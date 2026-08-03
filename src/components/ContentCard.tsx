import Link from 'next/link'
import type { ContentMeta } from '@/lib/types'
import MaturityMark from './MaturityMark'

interface ContentCardProps {
  item: ContentMeta
}

export default function ContentCard({ item }: ContentCardProps) {
  const isProject = item.type === 'project'

  return (
    <article className="group py-5">
      <Link href={item.href} className="block">
        {/* Type + date + maturity row */}
        <div className="font-data flex items-center gap-2 mb-2.5 text-xs uppercase tracking-wide flex-wrap">
          <span
            className="font-medium"
            style={{ color: isProject ? 'var(--accent)' : 'var(--ink-muted)' }}
          >
            {isProject ? 'project' : 'note'}
          </span>
          <span style={{ color: 'var(--rule)' }}>.</span>
          <time style={{ color: 'var(--ink-muted)' }} dateTime={item.date}>
            {new Date(item.date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </time>
          <MaturityMark maturity={item.maturity} className="ml-auto" />
        </div>

        {/* Title */}
        <h2 className="font-ui font-semibold text-base mb-1.5 group-hover:opacity-80 transition-opacity leading-snug">
          {item.title}
        </h2>

        {/* Description */}
        {item.description && (
          <p className="font-ui text-sm leading-relaxed mb-3" style={{ color: 'var(--ink-muted)' }}>
            {item.description}
          </p>
        )}

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="font-data flex flex-wrap gap-2 text-xs uppercase tracking-wide">
            {item.tags.map((tag) => (
              <span key={tag} style={{ color: 'var(--ink-muted)' }}>
                #{tag}
              </span>
            ))}
          </div>
        )}
      </Link>
    </article>
  )
}
