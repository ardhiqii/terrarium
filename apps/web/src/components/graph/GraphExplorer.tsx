'use client'

import { useMemo, useState } from 'react'
import GardenGraph from './GardenGraph'
import { filterGraph, type MaturityFilter } from '@/lib/graph/filter'
import type { GraphData } from '@/lib/types'

const ALL = 'all'
const SELECT_CLASS =
  'font-data text-xs min-h-11 px-2 rounded bg-transparent border'
const SELECT_STYLE = { borderColor: 'var(--rule)', color: 'var(--ink)' }
const LABEL_STYLE = { color: 'var(--ink-muted)', letterSpacing: '0.15em' }

/**
 * Filters in front of the graph.
 *
 * WHY: /graph was a whole route whose entire content was five nodes and the sentence
 * "Click a node to navigate". It had no way to narrow anything, so at five nodes it looked
 * pointless and at a hundred it would look like yarn. The data to filter on was already on
 * every node (tags, maturity); nothing exposed it.
 *
 * The filter is client-side and pure so it survives the simulation mutating the input.
 */
export default function GraphExplorer({ data }: { data: GraphData }) {
  const [tag, setTag] = useState<string>(ALL)
  const [maturity, setMaturity] = useState<MaturityFilter>(ALL)

  const tags = useMemo(() => {
    const set = new Set<string>()
    for (const node of data.nodes) for (const t of node.tags) set.add(t)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [data.nodes])

  const filtered = useMemo(() => filterGraph(data, tag, maturity), [data, tag, maturity])
  const isFiltered = tag !== ALL || maturity !== ALL

  const reset = () => {
    setTag(ALL)
    setMaturity(ALL)
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-6">
        <label className="flex items-center gap-2">
          <span className="font-data text-xs uppercase tracking-widest" style={LABEL_STYLE}>
            Tag
          </span>
          <select
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            className={SELECT_CLASS}
            style={SELECT_STYLE}
          >
            <option value={ALL}>All tags</option>
            {tags.map((name) => (
              <option key={name} value={name}>
                #{name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="font-data text-xs uppercase tracking-widest" style={LABEL_STYLE}>
            Maturity
          </span>
          <select
            value={maturity}
            onChange={(event) => setMaturity(event.target.value as MaturityFilter)}
            className={SELECT_CLASS}
            style={SELECT_STYLE}
          >
            <option value={ALL}>Any maturity</option>
            <option value="seedling">Seedling</option>
            <option value="budding">Budding</option>
            <option value="evergreen">Evergreen</option>
          </select>
        </label>

        {isFiltered && (
          <div className="flex items-center gap-3">
            {/* States the effect of the filter instead of leaving the reader to count. */}
            <span className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
              {filtered.nodes.length} of {data.nodes.length} nodes
            </span>
            <button
              onClick={reset}
              className="font-data text-xs min-h-11 px-2 underline decoration-dotted underline-offset-2 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--accent)' }}
            >
              Reset
            </button>
          </div>
        )}
      </div>

      {filtered.nodes.length === 0 ? (
        <div
          className="border px-6 py-16 text-center"
          style={{ borderColor: 'var(--rule)' }}
        >
          <p className="font-ui text-sm mb-1" style={{ color: 'var(--ink)' }}>
            Nothing matches those filters.
          </p>
          <p className="font-prose text-sm mb-4" style={{ color: 'var(--ink-muted)' }}>
            Try a different tag, or clear the filters to see the whole garden.
          </p>
          <button
            onClick={reset}
            className="font-ui text-sm min-h-11 px-4 rounded border hover:opacity-70 transition-opacity"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <GardenGraph data={filtered} />
      )}
    </div>
  )
}
