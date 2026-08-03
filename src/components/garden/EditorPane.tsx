'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from 'tiptap-markdown'
import type { GardenFile, GardenSource } from '@/lib/garden-fs/types'
import { parseNote, serializeNote, titleToFileName, type NoteFrontMatter } from '@/lib/garden-fs/serialize'
import { renameNoteEverywhere } from '@/lib/garden-fs/rewrite'
import { extractWikilinks, slugify } from '@/lib/utils'
import { computeGardenXp } from '@/lib/game/xp'
import { MATURITIES, type GardenStats, type Maturity, type XpEntry } from '@/lib/game/types'
import NoteList, { type NoteSummary } from './NoteList'
import WikilinkAutocomplete from './WikilinkAutocomplete'
import { Wikilink } from './wikilink-node'

interface EditorPaneProps {
  source: GardenSource
}

interface DraftForm {
  title: string
  tags: string
  maturity: Maturity | ''
  body: string
}

const EMPTY_DRAFT: DraftForm = { title: '', tags: '', maturity: '', body: '' }

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function toSummary(file: GardenFile): NoteSummary {
  const { frontMatter } = parseNote(file.content)
  return {
    fileName: file.name,
    title: frontMatter.title || file.name.replace(/\.mdx?$/i, ''),
    tags: frontMatter.tags,
    maturity: frontMatter.maturity,
  }
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * Word count for a draft body, matching `src/lib/game/stats.ts`'s
 * whitespace-split convention so the live preview and the real build-time
 * count never disagree about what "words" means.
 */
function countWords(body: string): number {
  const trimmed = body.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

/**
 * Live XP feedback while writing: "+100 note, +40 words, +30 links". Built
 * from a one-note `GardenStats` snapshot run through the real
 * `computeGardenXp`, per the spec ("do not invent new maths"). Backlinks,
 * tags, and maturity promotions are not previewable from a single draft in
 * isolation, so this only ever returns the subset that is: note-published,
 * words, and resolved wikilinks.
 */
export function computeDraftXpPreview(body: string, existingTitles: string[]): XpEntry[] {
  const titleSet = new Set(existingTitles.map((t) => t.toLowerCase()))
  const slugSet = new Set(existingTitles.map((t) => slugify(t).toLowerCase()))

  const links = extractWikilinks(body)
  const resolvedWikilinks = links.filter((target) => {
    const lower = target.toLowerCase()
    return titleSet.has(lower) || slugSet.has(slugify(target).toLowerCase())
  }).length

  const stats: GardenStats = {
    noteCount: 1,
    projectCount: 0,
    totalWords: countWords(body),
    resolvedWikilinks,
    backlinksReceived: 0,
    tagCount: 0,
    maturityCounts: { seedling: 0, budding: 0, evergreen: 0 },
    maxBacklinksOnSingleNote: 0,
    firstPublishedAt: null,
    lastPublishedAt: null,
  }

  return computeGardenXp(stats).filter((entry) => entry.count > 0)
}

export interface WikilinkTrigger {
  /** Offset into the current block's plain text where the triggering `[[`
   *  starts. `EditorPane` converts this to an absolute ProseMirror position
   *  before using it, since a textblock can start anywhere in the doc. */
  start: number
  query: string
}

/**
 * Detects an in-progress `[[query` the caret is currently inside, so the
 * autocomplete popup knows what to filter on. Returns null once `]]` has
 * closed the link, a newline was typed, or a second `[[` was opened before
 * the first closed. Pure string logic, deliberately editor-agnostic: it
 * does not know or care whether `text` came from a textarea or, as now, the
 * plain text of a ProseMirror textblock.
 */
export function detectWikilinkTrigger(text: string, caret: number): WikilinkTrigger | null {
  const uptoCaret = text.slice(0, caret)
  const openIndex = uptoCaret.lastIndexOf('[[')
  if (openIndex === -1) return null

  const between = uptoCaret.slice(openIndex + 2)
  if (between.includes(']]') || between.includes('\n') || between.includes('[[')) {
    return null
  }
  return { start: openIndex, query: between }
}

/** A `WikilinkTrigger` resolved to absolute ProseMirror document positions,
 *  ready to hand to `insertContentAt`. */
interface ResolvedWikilinkTrigger {
  from: number
  to: number
  query: string
}

/** Reads the plain text of the textblock containing the current selection
 *  and runs it through `detectWikilinkTrigger`, converting the result to
 *  absolute doc positions. Returns null outside a text selection or with no
 *  in-progress `[[query`. */
function findWikilinkTrigger(editor: Editor): ResolvedWikilinkTrigger | null {
  const { $from, empty } = editor.state.selection
  if (!empty) return null

  const blockText = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const trigger = detectWikilinkTrigger(blockText, blockText.length)
  if (!trigger) return null

  const blockStart = $from.start()
  return { from: blockStart + trigger.start, to: $from.pos, query: trigger.query }
}

export default function EditorPane({ source }: EditorPaneProps) {
  const [files, setFiles] = useState<GardenFile[]>([])
  // Starts true so the initial fetch never needs a synchronous setState call
  // inside the effect that kicks it off; `refresh` only touches state after
  // its first await, which is what react-hooks/set-state-in-effect wants.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const [selectedFileName, setSelectedFileName] = useState<string | null>(null)
  const [mode, setMode] = useState<'list' | 'edit' | 'create'>('list')
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT)
  const [originalTitle, setOriginalTitle] = useState<string | null>(null)
  const [originalFrontMatter, setOriginalFrontMatter] = useState<NoteFrontMatter | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  const [trigger, setTrigger] = useState<ResolvedWikilinkTrigger | null>(null)

  // A single long-lived TipTap instance; switching notes calls
  // `editor.commands.setContent()` rather than remounting, which is what
  // keeps this a controlled "one editor, swap content" component instead of
  // one editor per note.
  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Placeholder.configure({ placeholder: 'Start writing. Type [[ to link a note.' }),
        Markdown,
        Wikilink,
      ],
      content: '',
      immediatelyRender: false,
      onUpdate: ({ editor }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const markdown = (editor.storage as any).markdown.getMarkdown() as string
        setDraft((d) => ({ ...d, body: markdown }))
        setTrigger(findWikilinkTrigger(editor))
      },
      onSelectionUpdate: ({ editor }) => {
        setTrigger(findWikilinkTrigger(editor))
      },
    },
    []
  )

  const refresh = useCallback(async () => {
    try {
      const list = await source.list()
      setFiles(list)
      setError(null)
    } catch {
      setError('Could not read the connected folder. Permission may have been revoked.')
    }
    setLoading(false)
  }, [source])

  useEffect(() => {
    // The eslint-plugin-react-hooks "set-state-in-effect" check cannot see
    // that every setState inside `refresh` happens after its first
    // `await`, so it flags this as a synchronous set-state-in-effect even
    // though it isn't one. Loading a folder's file list on mount is exactly
    // the documented "synchronize with an external system" case the rule
    // means to allow.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [refresh])

  const summaries = useMemo(() => files.map(toSummary), [files])
  const allTitles = useMemo(() => summaries.map((s) => s.title).filter(Boolean), [summaries])

  const otherTitles = useMemo(
    () => allTitles.filter((t) => t !== originalTitle),
    [allTitles, originalTitle]
  )

  const xpPreview = useMemo(
    () => computeDraftXpPreview(draft.body, otherTitles),
    [draft.body, otherTitles]
  )

  function startCreate() {
    setSelectedFileName(null)
    setOriginalTitle(null)
    setOriginalFrontMatter(null)
    setDraft(EMPTY_DRAFT)
    setMode('create')
    setStatus(null)
    setError(null)
    setConfirmingDelete(false)
    setTrigger(null)
    editor?.commands.setContent('')
  }

  function startEdit(fileName: string) {
    const file = files.find((f) => f.name === fileName)
    if (!file) return
    const { frontMatter, body } = parseNote(file.content)
    setSelectedFileName(fileName)
    setOriginalTitle(frontMatter.title)
    setOriginalFrontMatter(frontMatter)
    setDraft({
      title: frontMatter.title,
      tags: frontMatter.tags.join(', '),
      maturity: frontMatter.maturity ?? '',
      body,
    })
    setMode('edit')
    setStatus(null)
    setError(null)
    setConfirmingDelete(false)
    setTrigger(null)
    // `setContent` is patched by the Markdown extension to parse a plain
    // markdown string, same as it does for a `.md` file loaded from disk.
    editor?.commands.setContent(body)
  }

  async function handleSave() {
    const trimmedTitle = draft.title.trim()
    if (!trimmedTitle) {
      setError('A note needs a title.')
      return
    }

    setSaving(true)
    setError(null)
    setStatus(null)

    try {
      const frontMatter: NoteFrontMatter = {
        title: trimmedTitle,
        date: originalFrontMatter?.date || today(),
        tags: parseTagsInput(draft.tags),
        maturity: draft.maturity || undefined,
      }

      if (mode === 'create') {
        const fileName = titleToFileName(trimmedTitle)
        if (files.some((f) => f.name === fileName)) {
          setError(`A note named "${trimmedTitle}" already exists.`)
          return
        }
        await source.write(fileName, serializeNote(frontMatter, draft.body))
        await refresh()
        setSelectedFileName(fileName)
        setOriginalTitle(trimmedTitle)
        setOriginalFrontMatter(frontMatter)
        setMode('edit')
        setStatus('Note created.')
        return
      }

      // mode === 'edit'
      if (!selectedFileName) return
      let finalFileName = selectedFileName

      if (originalTitle !== null && trimmedTitle !== originalTitle) {
        // Title changed: rewrite every inbound wikilink across the folder
        // before writing this note's own edited body, so the rename and the
        // content edit both land in one save.
        const summary = await renameNoteEverywhere(source, selectedFileName, trimmedTitle)
        finalFileName = summary.renamedFile
        if (summary.updatedFiles.length > 0) {
          setStatus(
            `Renamed. Updated ${summary.updatedFiles.length} linking note${
              summary.updatedFiles.length === 1 ? '' : 's'
            }.`
          )
        } else {
          setStatus('Renamed.')
        }
      } else {
        setStatus('Saved.')
      }

      await source.write(finalFileName, serializeNote(frontMatter, draft.body))
      await refresh()
      setSelectedFileName(finalFileName)
      setOriginalTitle(trimmedTitle)
      setOriginalFrontMatter(frontMatter)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this note.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!selectedFileName) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await source.remove(selectedFileName)
      await refresh()
      setSelectedFileName(null)
      setMode('list')
      setDraft(EMPTY_DRAFT)
      setTrigger(null)
      editor?.commands.setContent('')
      setStatus('Note deleted.')
    } catch {
      setError('Could not delete this note.')
    } finally {
      setSaving(false)
      setConfirmingDelete(false)
    }
  }

  /**
   * Replaces the in-progress `[[query` text with the real atomic wikilink
   * node (see `wikilink-node.ts`), rather than splicing `[[Title]]` text
   * and relying on the input rule to catch up. Inserting the node directly
   * is both simpler and immune to the input rule's regex missing an edge
   * case, since there is no intermediate plain-text state to mis-parse.
   */
  function handleSelectSuggestion(title: string) {
    if (!editor || !trigger) return
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: trigger.from, to: trigger.to },
        { type: 'wikilink', attrs: { target: title, label: title } }
      )
      .run()
    setTrigger(null)
  }

  if (loading) {
    return (
      <p className="font-ui text-sm p-4" style={{ color: 'var(--ink-muted)' }}>
        Loading {source.name}...
      </p>
    )
  }

  if (error && files.length === 0 && mode === 'list') {
    return (
      <p className="font-ui text-sm p-4" style={{ color: 'var(--ink-muted)' }}>
        {error}
      </p>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] h-full border" style={{ borderColor: 'var(--rule)' }}>
      <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: 'var(--rule)' }}>
        <NoteList
          notes={summaries}
          selectedFileName={mode === 'edit' ? selectedFileName : null}
          onSelect={startEdit}
          onCreate={startCreate}
        />
      </div>

      <div className="p-4 flex flex-col gap-4">
        {mode === 'list' && (
          <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
            Select a note to edit, or create a new one.
          </p>
        )}

        {mode !== 'list' && (
          <>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Title
                </span>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  className="font-ui px-2 py-1.5 border bg-transparent outline-none text-sm"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                  placeholder="Untitled"
                />
              </label>

              <div className="flex gap-3 flex-wrap">
                <label className="flex flex-col gap-1 flex-1 min-w-[160px]">
                  <span className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Tags (comma separated)
                  </span>
                  <input
                    type="text"
                    value={draft.tags}
                    onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
                    className="font-ui px-2 py-1.5 border bg-transparent outline-none text-sm"
                    style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                    placeholder="thinking, tools"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Maturity
                  </span>
                  <select
                    value={draft.maturity}
                    onChange={(e) => setDraft((d) => ({ ...d, maturity: e.target.value as Maturity | '' }))}
                    className="font-ui px-2 py-1.5 border bg-transparent outline-none text-sm"
                    style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                  >
                    <option value="">seedling (default)</option>
                    {MATURITIES.filter((m) => m !== 'seedling').map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="relative flex-1 flex flex-col">
              <span className="font-data text-xs uppercase tracking-wide mb-1" style={{ color: 'var(--ink-muted)' }}>
                Ctrl+B bold, Ctrl+I italic, type [[ to link a note.
              </span>
              <div
                className="tiptap-editor font-ui flex-1 min-h-[280px] px-3 py-2 border bg-transparent text-sm leading-relaxed overflow-y-auto"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
              >
                <EditorContent editor={editor} />
              </div>
              {trigger &&
                (() => {
                  // `coordsAtPos` can throw if the position went stale between
                  // an edit and this render; fail closed (no popup) rather
                  // than crash the editor over an autocomplete nicety.
                  let coords: { left: number; bottom: number } | null = null
                  try {
                    coords = editor?.view.coordsAtPos(trigger.from) ?? null
                  } catch {
                    coords = null
                  }
                  if (!coords) return null
                  return (
                    <WikilinkAutocomplete
                      query={trigger.query}
                      titles={otherTitles}
                      onSelect={handleSelectSuggestion}
                      style={{
                        position: 'fixed',
                        top: coords.bottom + 4,
                        left: coords.left,
                      }}
                    />
                  )
                })()}
            </div>

            {xpPreview.length > 0 && (
              <p className="font-data text-xs" style={{ color: 'var(--accent)' }}>
                {xpPreview.map((e) => `+${e.xp} ${e.label.toLowerCase()}`).join(', ')}
              </p>
            )}

            {error && (
              <p className="font-ui text-sm" style={{ color: 'var(--accent)' }}>
                {error}
              </p>
            )}
            {status && !error && (
              <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
                {status}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="font-ui text-sm font-medium px-3 py-1.5 border transition-colors hover:opacity-80 disabled:opacity-50"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
              >
                {mode === 'create' ? 'Create note' : 'Save'}
              </button>

              {mode === 'edit' && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={saving}
                  className="font-ui text-sm px-3 py-1.5 border transition-colors hover:opacity-80 disabled:opacity-50"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                >
                  {confirmingDelete ? 'Confirm delete' : 'Delete'}
                </button>
              )}

              {confirmingDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="font-ui text-sm px-3 py-1.5 transition-colors hover:opacity-80"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
