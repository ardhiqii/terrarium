import Link from 'next/link'
import type { TocEntry } from '@/lib/mdx'

interface TocProps {
  entries: TocEntry[]
}

export default function TableOfContents({ entries }: TocProps) {
  if (entries.length < 2) return null

  return (
    <nav className="font-ui text-sm">
      <p className="font-data font-medium mb-3 uppercase tracking-wider text-xs" style={{ color: 'var(--ink-muted)' }}>
        On this page
      </p>
      <ul className="space-y-1.5">
        {entries.map((entry) => (
          <li
            key={entry.id}
            style={{ paddingLeft: `${(entry.level - 1) * 0.75}rem` }}
          >
            <Link
              href={`#${entry.id}`}
              className="block hover:opacity-80 transition-opacity leading-snug"
              style={{ color: 'var(--ink-muted)' }}
            >
              {entry.text}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
