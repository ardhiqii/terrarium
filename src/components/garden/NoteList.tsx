'use client'

import { useMemo, useState } from 'react'
import MaturityMark from '@/components/MaturityMark'
import type { Maturity } from '@/lib/game/types'

/** Summary shown per row. `EditorPane` derives this from `parseNote`, so the
 *  list never needs to know about raw frontmatter shapes. */
export interface NoteSummary {
  /** Filename in the connected folder, the stable identity for selection. */
  fileName: string
  title: string
  tags: string[]
  maturity?: Maturity
}

interface NoteListProps {
  notes: NoteSummary[]
  selectedFileName: string | null
  onSelect: (fileName: string) => void
  onCreate: () => void
}

/** The bucket untagged notes fall into, sorted after every real tag. */
const UNTAGGED = 'untagged'

/** Alphabetical by title, case-insensitive, ties broken by filename so the
 *  order is stable across renders even when two notes share a title. */
export function sortNotes(notes: NoteSummary[]): NoteSummary[] {
  return [...notes].sort((a, b) => {
    const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    return byTitle !== 0 ? byTitle : a.fileName.localeCompare(b.fileName)
  })
}

export interface NoteGroup {
  tag: string
  notes: NoteSummary[]
}

/**
 * Groups notes by tag, Obsidian-style: a note with several tags appears
 * under each of them, which is correct, not a duplicate bug. Untagged notes
 * get their own group, sorted last regardless of where "untagged" would
 * otherwise alphabetise. Groups are sorted alphabetically (case-insensitive)
 * and each group's notes go through `sortNotes`.
 */
export function groupNotesByTag(notes: NoteSummary[]): NoteGroup[] {
  const byTag = new Map<string, NoteSummary[]>()

  for (const note of notes) {
    const tags = note.tags.length > 0 ? note.tags : [UNTAGGED]
    for (const tag of tags) {
      const bucket = byTag.get(tag)
      if (bucket) bucket.push(note)
      else byTag.set(tag, [note])
    }
  }

  const groups = Array.from(byTag.entries())
    .filter(([tag]) => tag !== UNTAGGED)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([tag, groupNotes]) => ({ tag, notes: sortNotes(groupNotes) }))

  const untagged = byTag.get(UNTAGGED)
  if (untagged) groups.push({ tag: UNTAGGED, notes: sortNotes(untagged) })

  return groups
}

/** Matches a filter query against a note's title or any of its tags,
 *  case-insensitive substring match. Empty query matches everything. */
export function filterNotes(notes: NoteSummary[], query: string): NoteSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return notes
  return notes.filter(
    (note) =>
      note.title.toLowerCase().includes(q) || note.tags.some((tag) => tag.toLowerCase().includes(q))
  )
}

function NoteRow({
  note,
  selected,
  onSelect,
}: {
  note: NoteSummary
  selected: boolean
  onSelect: (fileName: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(note.fileName)}
        className="ui-row block w-full text-left px-3 py-2"
        data-active={selected}
        aria-current={selected}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="font-ui text-sm truncate"
            style={{ color: 'var(--ink)', fontWeight: selected ? 600 : 400 }}
          >
            {note.title || note.fileName}
          </span>
          <MaturityMark maturity={note.maturity} />
        </div>
      </button>
    </li>
  )
}

export default function NoteList({ notes, selectedFileName, onSelect, onCreate }: NoteListProps) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => filterNotes(notes, query), [notes, query])
  const groups = useMemo(() => groupNotesByTag(filtered), [filtered])

  function toggleGroup(tag: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <span className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
          {notes.length} note{notes.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={onCreate}
          className="font-ui text-xs font-medium px-2 py-1 border transition-colors hover:opacity-70"
          style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
        >
          + New note
        </button>
      </div>

      <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--rule)' }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by title or tag..."
          aria-label="Filter notes"
          className="font-ui w-full px-2 py-1.5 border bg-transparent outline-none text-sm"
          style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
        />
      </div>

      {notes.length === 0 ? (
        <p className="font-ui text-sm p-4" style={{ color: 'var(--ink-muted)' }}>
          No notes yet. Create one to get started.
        </p>
      ) : filtered.length === 0 ? (
        <p className="font-ui text-sm p-4" style={{ color: 'var(--ink-muted)' }}>
          No notes match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.tag)
            return (
              <div key={group.tag} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.tag)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 font-data text-xs uppercase tracking-wide transition-colors hover:opacity-70"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                    {group.tag === UNTAGGED ? UNTAGGED : `#${group.tag}`}
                  </span>
                  <span>{group.notes.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                    {group.notes.map((note) => (
                      <NoteRow
                        key={`${group.tag}:${note.fileName}`}
                        note={note}
                        selected={note.fileName === selectedFileName}
                        onSelect={onSelect}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
