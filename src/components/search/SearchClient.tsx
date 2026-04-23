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
        className="flex items-center gap-3 px-4 py-3 rounded-xl border transition-all"
        style={{
          background: 'var(--card-bg)',
          borderColor: focused ? 'var(--accent)' : 'var(--border)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--muted)', flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search notes, projects, tags…"
          className="flex-1 bg-transparent outline-none text-sm"
          style={{ color: 'var(--foreground)' }}
          autoFocus
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="flex-shrink-0 transition-opacity hover:opacity-60"
            style={{ color: 'var(--muted)' }}
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
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
          {results.length} result{results.length !== 1 ? 's' : ''}
        </p>
      )}

      {/* Empty */}
      {showEmpty && (
        <p className="mt-6 text-sm" style={{ color: 'var(--muted)' }}>
          No results for &ldquo;{query}&rdquo;.
        </p>
      )}

      {/* Results */}
      {showResults && (
        <ul className="mt-4 space-y-2">
          {results.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex items-start gap-3 px-4 py-3 rounded-xl border transition-all hover:shadow-sm group"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}
              >
                <span
                  className="mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{
                    background: item.type === 'project' ? 'var(--project-color)' : 'var(--note-color)',
                  }}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm group-hover:opacity-80 transition-opacity">
                    {item.title}
                  </p>
                  {item.description && (
                    <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                      {item.description}
                    </p>
                  )}
                  {item.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--tag-bg)', color: 'var(--tag-text)' }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)' }}>
                  {item.collection}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Idle state */}
      {!query && (
        <p className="mt-6 text-sm" style={{ color: 'var(--muted)' }}>
          Type to search across all notes and projects.
        </p>
      )}
    </div>
  )
}
