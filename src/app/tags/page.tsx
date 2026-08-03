import { getAllTags, getContentByTag } from '@/lib/content'
import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tags',
}

export default function TagsPage() {
  const tags = getAllTags()

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <h1 className="font-ui text-2xl font-semibold mb-2">
          Tags
        </h1>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          Browse content by topic.
        </p>
      </div>

      {tags.length === 0 ? (
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          No tags yet.
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {tags.map((tag) => {
            const count = getContentByTag(tag).length
            return (
              <Link
                key={tag}
                href={`/tags/${tag}`}
                className="flex items-center gap-2 px-4 py-2 border transition-colors hover:border-[color:var(--ink-muted)]"
                style={{ borderColor: 'var(--rule)' }}
              >
                <span className="font-ui text-sm font-medium">{tag}</span>
                <span
                  className="font-data text-xs"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  {count}
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
