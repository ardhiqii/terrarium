import Link from 'next/link'
import type { ContentMeta } from '@/lib/types'

interface BacklinksProps {
  backlinks: ContentMeta[]
}

export default function Backlinks({ backlinks }: BacklinksProps) {
  if (backlinks.length === 0) return null

  return (
    <section
      className="mt-12 pt-8 border-t"
      style={{ borderColor: 'var(--rule)' }}
    >
      <h3
        className="font-data text-xs font-semibold uppercase tracking-wider mb-4"
        style={{ color: 'var(--ink-muted)' }}
      >
        Linked from
      </h3>
      <ul className="space-y-2">
        {backlinks.map((bl) => (
          <li key={bl.slug}>
            <Link
              href={bl.href}
              className="font-ui flex items-center gap-2 text-sm hover:opacity-80 transition-opacity"
            >
              <span
                className="font-data text-xs uppercase"
                style={{ color: bl.type === 'project' ? 'var(--accent)' : 'var(--ink-muted)' }}
              >
                {bl.type === 'project' ? 'project' : 'note'}
              </span>
              <span>{bl.title}</span>
              <span className="font-data text-xs ml-auto" style={{ color: 'var(--ink-muted)' }}>
                {bl.collection}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
