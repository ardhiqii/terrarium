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

export interface TagCount {
  tag: string
  count: number
}

/**
 * Tag counts for the filter rail, most-used first, ties alphabetical.
 *
 * THIS REPLACES THE OLD TAG GROUPING, which rendered a note once per tag it
 * carried. That was defensible (it matches Obsidian's tag pane) but it made
 * the sidebar contradict itself: a header reading "7 notes" sat directly
 * above 14 rows, and a note had no single home to remember it by. Worse, on
 * a small garden most groups held exactly one note, so grouping added a
 * header per note without organising anything.
 *
 * Tags are a filter here instead, which is what they actually are in a flat
 * folder. The list stays a set: one note, one row, always.
 */
export function tagCounts(notes: NoteSummary[]): TagCount[] {
  const counts = new Map<string, number>()
  let untagged = 0

  for (const note of notes) {
    if (note.tags.length === 0) {
      untagged++
      continue
    }
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  const tags = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) =>
      b.count !== a.count
        ? b.count - a.count
        : a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' })
    )

  // Untagged always sorts last, however many there are: it is a residual
  // bucket, not a subject.
  if (untagged > 0) tags.push({ tag: UNTAGGED, count: untagged })
  return tags
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

/** Narrows to one tag. `UNTAGGED` selects notes carrying no tags at all. */
export function filterByTag(notes: NoteSummary[], tag: string | null): NoteSummary[] {
  if (!tag) return notes
  if (tag === UNTAGGED) return notes.filter((note) => note.tags.length === 0)
  return notes.filter((note) => note.tags.includes(tag))
}

/**
 * The tag filter actually in force.
 *
 * A selected tag can stop existing while it is selected: delete the last note
 * carrying it, or reconnect to a different folder. The rail is built from the
 * current notes, so its chip disappears, and a raw `activeTag` would leave the
 * list filtered by something with no visible control to undo it. Deriving the
 * value instead means the filter clears itself.
 */
export function resolveActiveTag(tags: TagCount[], activeTag: string | null): string | null {
  if (activeTag === null) return null
  return tags.some((t) => t.tag === activeTag) ? activeTag : null
}

/**
 * Whether the maturity glyph earns its place.
 *
 * A channel with the same value on every row carries no information and is
 * pure noise, and a fresh garden is all seedlings. So the glyph and its
 * gutter are omitted entirely rather than dimmed: dimming still spends the
 * space and still draws a repeating column down the sidebar. It reappears on
 * its own the first time a note is promoted.
 */
export function shouldShowMaturity(notes: NoteSummary[]): boolean {
  const distinct = new Set(notes.map((note) => note.maturity ?? 'seedling'))
  return distinct.size > 1
}

function NoteRow({
  note,
  selected,
  showMaturity,
  onSelect,
}: {
  note: NoteSummary
  selected: boolean
  showMaturity: boolean
  onSelect: (fileName: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(note.fileName)}
        className="ui-row flex w-full items-center gap-2 text-left px-3 py-2"
        data-active={selected}
        aria-current={selected}
      >
        {/* Leading, so the glyphs form a column the eye can read downward.
            A trailing chip's position moves with title truncation and never
            lines up. */}
        {showMaturity && <MaturityMark maturity={note.maturity} glyphOnly />}
        <span
          className="font-ui text-sm truncate"
          style={{ color: 'var(--ink)', fontWeight: selected ? 600 : 400 }}
        >
          {note.title || note.fileName}
        </span>
      </button>
    </li>
  )
}

export default function NoteList({ notes, selectedFileName, onSelect, onCreate }: NoteListProps) {
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const tags = useMemo(() => tagCounts(notes), [notes])
  // Derived, not raw: see resolveActiveTag. A tag that no longer exists must
  // not keep filtering the list after its chip has gone.
  const effectiveTag = useMemo(() => resolveActiveTag(tags, activeTag), [tags, activeTag])
  const visible = useMemo(
    () => sortNotes(filterNotes(filterByTag(notes, effectiveTag), query)),
    [notes, effectiveTag, query]
  )
  const showMaturity = useMemo(() => shouldShowMaturity(notes), [notes])

  const narrowed = effectiveTag !== null || query.trim().length > 0
  const countLabel = narrowed
    ? `${visible.length} of ${notes.length} notes`
    : `${notes.length} note${notes.length !== 1 ? 's' : ''}`

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Everything above the scroller is pinned, so the count, the search
          box and the active filter stay reachable in a long list. */}
      <div
        className="shrink-0 flex items-center justify-between gap-2 px-3 py-2.5 border-b"
        style={{ borderColor: 'var(--rule)' }}
      >
        <span
          className="font-data text-xs uppercase tracking-wide"
          aria-live="polite"
          style={{ color: 'var(--ink-muted)' }}
        >
          {countLabel}
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

      <div className="shrink-0 px-3 py-2 border-b" style={{ borderColor: 'var(--rule)' }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes and tags"
          aria-label="Search notes and tags"
          className="font-ui w-full px-2 py-1.5 border bg-transparent outline-none text-sm"
          style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
        />
      </div>

      {tags.length > 0 && (
        <div
          className="shrink-0 flex gap-1 overflow-x-auto px-2 py-1.5 border-b"
          style={{ borderColor: 'var(--rule)' }}
          role="group"
          aria-label="Filter by tag"
        >
          <TagChip
            label="All"
            count={notes.length}
            active={effectiveTag === null}
            onClick={() => setActiveTag(null)}
          />
          {tags.map(({ tag, count }) => (
            <TagChip
              key={tag}
              label={tag === UNTAGGED ? UNTAGGED : `#${tag}`}
              count={count}
              active={effectiveTag === tag}
              onClick={() => setActiveTag(effectiveTag === tag ? null : tag)}
            />
          ))}
        </div>
      )}

      {notes.length === 0 ? (
        <p className="font-ui text-sm p-4" style={{ color: 'var(--ink-muted)' }}>
          No notes yet. Create one to get started.
        </p>
      ) : visible.length === 0 ? (
        <p className="font-ui text-sm p-4" style={{ color: 'var(--ink-muted)' }}>
          No notes match.
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <ul className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {visible.map((note) => (
              <NoteRow
                key={note.fileName}
                note={note}
                selected={note.fileName === selectedFileName}
                showMaturity={showMaturity}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function TagChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="ui-row font-data shrink-0 flex items-center gap-1 px-2 py-1 text-xs rounded whitespace-nowrap"
      data-active={active}
      style={{
        color: active ? 'var(--ink)' : 'var(--ink-muted)',
        // The single accent, spent on the active filter only. Maturity never
        // uses it, so the two encodings cannot be confused.
        boxShadow: active ? 'inset 0 -2px 0 var(--accent)' : undefined,
      }}
    >
      <span>{label}</span>
      <span style={{ opacity: 0.6 }}>{count}</span>
    </button>
  )
}
