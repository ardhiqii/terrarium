import Link from 'next/link'
import type { ContentMeta } from '@/lib/types'

interface ContentCardProps {
  item: ContentMeta
}

export default function ContentCard({ item }: ContentCardProps) {
  const isProject = item.type === 'project'

  return (
    <article
      className="group rounded-xl border p-5 transition-all hover:shadow-sm"
      style={{
        background: 'var(--card-bg)',
        borderColor: 'var(--card-border)',
      }}
    >
      <Link href={item.href} className="block">
        {/* Type badge + date row */}
        <div className="flex items-center gap-2 mb-2.5">
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{
              background: isProject ? 'rgba(181,94,58,0.1)' : 'rgba(74,124,89,0.1)',
              color: isProject ? 'var(--project-color)' : 'var(--note-color)',
            }}
          >
            {isProject ? 'project' : 'note'}
          </span>
          <time
            className="text-xs"
            style={{ color: 'var(--muted)' }}
            dateTime={item.date}
          >
            {new Date(item.date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </time>
        </div>

        {/* Title */}
        <h2
          className="font-semibold text-base mb-1.5 group-hover:opacity-80 transition-opacity leading-snug"
          style={{ fontFamily: 'Inter, sans-serif' }}
        >
          {item.title}
        </h2>

        {/* Description */}
        {item.description && (
          <p className="text-sm leading-relaxed mb-3" style={{ color: 'var(--muted)' }}>
            {item.description}
          </p>
        )}

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded-md"
                style={{
                  background: 'var(--tag-bg)',
                  color: 'var(--tag-text)',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </Link>
    </article>
  )
}
