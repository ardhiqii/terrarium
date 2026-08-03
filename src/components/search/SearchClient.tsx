'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import type { ContentMeta } from '@/lib/types'

interface SearchClientProps {
  items: ContentMeta[]
}

export default function SearchClient({ items }: SearchClientProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContentMeta[]>([])
  const [focused, setFocused] = useState(false)

  const search = useCallback(
    (q: string) => {
      if (!q.trim()) {
        setResults([])
        return
      }
      const lower = q.toLowerCase()
      const matched = items.filter((item) => {
        return (
          item.title.toLowerCase().includes(lower) ||
          item.description?.toLowerCase().includes(lower) ||
          item.tags.some((t) => t.toLowerCase().includes(lower))
        )
      })
      setResults(matched)
    },
    [items]
  )

  useEffect(() => {
    const timeout = setTimeout(() => search(query), 150)
    return () => clearTimeout(timeout)
  }, [query, search])

  const showEmpty = query.trim() && results.length === 0
  const showResults = results.length > 0

  return (
    <div className="max-w-2xl">
      {/* Input */}
      <div
        className="flex items-center gap-3 px-4 py-3 border transition-colors"
        style={{
          background: 'var(--paper-raised)',
          borderColor: focused ? 'var(--accent)' : 'var(--rule)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--ink-muted)', flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search notes, projects, tags."
          className="font-ui flex-1 bg-transparent outline-none text-sm"
          style={{ color: 'var(--ink)' }}
          autoFocus
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="flex-shrink-0 transition-opacity hover:opacity-60"
            style={{ color: 'var(--ink-muted)' }}
            aria-label="Clear search"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Results count */}
      {showResults && (
        <p className="font-data mt-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
          {results.length} result{results.length !== 1 ? 's' : ''}
        </p>
      )}

      {/* Empty */}
      {showEmpty && (
        <p className="font-ui mt-6 text-sm" style={{ color: 'var(--ink-muted)' }}>
          No results for &ldquo;{query}&rdquo;.
        </p>
      )}

      {/* Results */}
      {showResults && (
        <ul className="mt-4 flex flex-col divide-y divide-[color:var(--rule)]">
          {results.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex items-start gap-3 px-1 py-3 group"
              >
                <span
                  className="font-data mt-0.5 text-xs uppercase flex-shrink-0"
                  style={{ color: item.type === 'project' ? 'var(--accent)' : 'var(--ink-muted)' }}
                >
                  {item.type === 'project' ? 'project' : 'note'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-ui font-medium text-sm group-hover:opacity-80 transition-opacity">
                    {item.title}
                  </p>
                  {item.description && (
                    <p className="font-ui text-xs mt-0.5 truncate" style={{ color: 'var(--ink-muted)' }}>
                      {item.description}
                    </p>
                  )}
                  {item.tags.length > 0 && (
                    <div className="font-data flex flex-wrap gap-2 mt-1.5 text-xs uppercase">
                      {item.tags.map((tag) => (
                        <span key={tag} style={{ color: 'var(--ink-muted)' }}>
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="font-data text-xs flex-shrink-0" style={{ color: 'var(--ink-muted)' }}>
                  {item.collection}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Idle state */}
      {!query && (
        <p className="font-ui mt-6 text-sm" style={{ color: 'var(--ink-muted)' }}>
          Type to search across all notes and projects.
        </p>
      )}
    </div>
  )
}
