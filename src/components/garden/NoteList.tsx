'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/**
 * A row in a picker, not a heading.
 *
 * The previous version stacked six signals onto a control with two states.
 * Title at `text-sm` in full `--ink` made the rows the largest, darkest text
 * in the panel, so they outranked the panel's own header and read as
 * headings. Selection jumped 400 to 600, which is the editor h1 weight. A
 * `divide-y` hairline under every row said "separate cells" the way a table
 * does. And symmetric `py-2` around one short string is button padding.
 *
 * Now: 13px so it cannot be confused with body copy, muted until selected,
 * one weight step, an accent rule on the selected row, and no separators at
 * all. Selection is still carried by weight and colour as well as the accent,
 * so it survives greyscale.
 */
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
        className="ui-row flex w-full items-center gap-2 text-left px-3 py-1.5"
        data-active={selected}
        aria-current={selected ? 'true' : undefined}
        style={{
          // Inset, so marking the selected row cannot shift it by a pixel the
          // way a real left border would.
          boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
        }}
      >
        {/* Fixed-width box: the three glyphs are not guaranteed equal width in
            the mono fallback chain, and without this the titles fail to align
            down the column. */}
        {showMaturity && (
          <span className="w-3 shrink-0 flex justify-center">
            <MaturityMark maturity={note.maturity} glyphOnly />
          </span>
        )}
        <span
          className="font-ui text-[13px] leading-5 truncate"
          style={{
            color: selected ? 'var(--ink)' : 'var(--ink-muted)',
            fontWeight: selected ? 500 : 400,
          }}
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
        <TagFilter
          tags={tags}
          totalCount={notes.length}
          active={effectiveTag}
          onChange={setActiveTag}
        />
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
          {/* No divider between rows. A hairline under every row is table
              styling: it says "separate cells" when this is one continuous
              list, and at a 32px pitch it draws a stripe every 32px down a
              212px column. Hover and the selected rule carry the structure. */}
          <ul>
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

/**
 * Tag filter as a disclosure, not a scrolling rail.
 *
 * The rail was a single row of chips with `overflow-x-auto`. The sidebar is
 * 260px, roughly 212px of content, and a chip is 70 to 90px, so exactly two
 * were ever visible and the rest sat behind a horizontal scrollbar styled
 * down to a 6px thumb. The control was hiding most of its own options.
 *
 * A trigger plus a vertical panel fixes the axis: overflow becomes vertical
 * scroll inside a bounded box, which is the right direction in a narrow
 * column. It also costs one tab stop instead of one per tag, and the trigger
 * states the active filter even when closed.
 *
 * Single select, so it is a radiogroup with a roving tabindex, mirroring the
 * pattern MaturitySegmented already uses rather than introducing a second
 * keyboard idiom.
 */
function TagFilter({
  tags,
  totalCount,
  active,
  onChange,
}: {
  tags: TagCount[]
  totalCount: number
  active: string | null
  onChange: (tag: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const options: { tag: string | null; count: number }[] = [
    { tag: null, count: totalCount },
    ...tags.map(({ tag, count }) => ({ tag: tag as string | null, count })),
  ]
  const activeIndex = Math.max(0, options.findIndex((o) => o.tag === active))

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) close(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close(true)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  function focusOption(index: number) {
    const wrapped = (index + options.length) % options.length
    optionRefs.current[wrapped]?.focus()
  }

  function onOptionKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(options.length - 1)
    }
  }

  const label = (tag: string | null) =>
    tag === null ? 'All notes' : tag === UNTAGGED ? UNTAGGED : `#${tag}`

  return (
    <div
      ref={containerRef}
      className="shrink-0 relative border-b"
      style={{ borderColor: 'var(--rule)' }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="gc-tag-panel"
        onClick={() => setOpen((prev) => !prev)}
        className="ui-row font-ui w-full flex items-center justify-between gap-2 px-3 py-2 text-[13px]"
        data-active={active !== null}
        style={{ color: active !== null ? 'var(--ink)' : 'var(--ink-muted)' }}
      >
        <span className="truncate">Tags: {active === null ? 'All' : label(active)}</span>
        <span aria-hidden="true" style={{ color: 'var(--ink-muted)' }}>
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div
          id="gc-tag-panel"
          role="radiogroup"
          aria-label={`Filter by tag, ${tags.length} tags`}
          className="absolute left-0 right-0 top-full z-20 border-b overflow-y-auto"
          style={{
            borderColor: 'var(--rule)',
            background: 'var(--paper-raised)',
            maxHeight: 'min(260px, 45vh)',
          }}
        >
          {options.map((option, index) => {
            const isActive = option.tag === active
            return (
              <button
                key={option.tag ?? '__all'}
                ref={(el) => {
                  optionRefs.current[index] = el
                }}
                type="button"
                role="radio"
                aria-checked={isActive}
                tabIndex={index === activeIndex ? 0 : -1}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
                onClick={() => {
                  onChange(option.tag)
                  close(true)
                }}
                className="ui-row font-ui w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] text-left"
                data-active={isActive}
                style={{
                  color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                  boxShadow: isActive ? 'inset 2px 0 0 var(--accent)' : undefined,
                }}
              >
                <span className="truncate">{label(option.tag)}</span>
                <span
                  className="font-data text-xs shrink-0"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  {option.count}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
