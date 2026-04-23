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
      style={{ borderColor: 'var(--border)' }}
    >
      <h3
        className="text-xs font-semibold uppercase tracking-wider mb-4"
        style={{ color: 'var(--muted)' }}
      >
        Linked from
      </h3>
      <ul className="space-y-2">
        {backlinks.map((bl) => (
          <li key={bl.slug}>
            <Link
              href={bl.href}
              className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity"
            >
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  background: bl.type === 'project' ? 'var(--project-color)' : 'var(--note-color)',
                }}
              />
              <span>{bl.title}</span>
              <span className="text-xs ml-auto" style={{ color: 'var(--muted)' }}>
                {bl.collection}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
