'use client'

import type { CSSProperties } from 'react'

export interface WikilinkAutocompleteProps {
  /** Text typed after the triggering `[[`, not yet including the brackets. */
  query: string
  /** Every note title in the connected folder, in any order. */
  titles: string[]
  onSelect: (title: string) => void
  /** Positions the popup next to the caret; caller measures the textarea. */
  style?: CSSProperties
}

const MAX_RESULTS = 8

/**
 * Ranks titles for `[[` autocomplete: case-insensitive prefix matches first,
 * then case-insensitive substring matches, capped so the popup never grows
 * past a screenful on a large garden.
 *
 * Exported standalone (not just used inside the component) so the matching
 * behaviour has a direct unit test without rendering React.
 */
export function matchWikilinkTitles(query: string, titles: string[]): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return titles.slice(0, MAX_RESULTS)

  const startsWith: string[] = []
  const contains: string[] = []
  for (const title of titles) {
    const lower = title.toLowerCase()
    if (lower.startsWith(q)) startsWith.push(title)
    else if (lower.includes(q)) contains.push(title)
  }
  return [...startsWith, ...contains].slice(0, MAX_RESULTS)
}

/**
 * `[[` autocomplete popup. Deliberately dumb: the caller (`EditorPane`)
 * owns detecting the `[[query` trigger and inserting the chosen title back
 * into the textarea, since caret math belongs with the field it edits.
 */
export default function WikilinkAutocomplete({
  query,
  titles,
  onSelect,
  style,
}: WikilinkAutocompleteProps) {
  const matches = matchWikilinkTitles(query, titles)
  if (matches.length === 0) return null

  return (
    <ul
      className="font-ui absolute z-20 min-w-[200px] max-w-xs border text-sm shadow-sm max-h-56 overflow-y-auto"
      style={{ background: 'var(--paper-raised)', borderColor: 'var(--rule)', ...style }}
      role="listbox"
      aria-label="Note title suggestions"
    >
      {matches.map((title) => (
        <li key={title}>
          <button
            type="button"
            // mousedown fires before the textarea blurs; click would lose focus first.
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(title)
            }}
            className="block w-full text-left px-3 py-1.5 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--ink)' }}
            role="option"
            aria-selected={false}
          >
            {title}
          </button>
        </li>
      ))}
    </ul>
  )
}
