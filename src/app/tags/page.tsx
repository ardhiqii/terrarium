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
        <h1 className="text-2xl font-semibold mb-2" style={{ fontFamily: 'Inter, sans-serif' }}>
          Tags
        </h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Browse content by topic.
        </p>
      </div>

      {tags.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
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
                className="flex items-center gap-2 px-4 py-2 rounded-xl border transition-all hover:shadow-sm"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
              >
                <span className="text-sm font-medium">{tag}</span>
                <span
                  className="text-xs px-1.5 py-0.5 rounded-md"
                  style={{ background: 'var(--tag-bg)', color: 'var(--muted)' }}
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
