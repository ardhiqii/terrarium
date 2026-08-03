import Link from 'next/link'
import type { LeaderboardEntry } from '@/lib/sync/types'
import Avatar from './Avatar'

export interface LeaderboardListProps {
  entries: LeaderboardEntry[]
}

/**
 * A ranked list of rows, `border-t`/`divide-y` per DESIGN.md rather than a
 * grid of bordered cells (`/companions`) or a long-form article
 * (`/guide`), so this reads as its own kind of surface, a scoreboard, not a
 * third variation on either of those two templates.
 */
export function LeaderboardList({ entries }: LeaderboardListProps) {
  return (
    <div style={{ borderTop: '1px solid var(--rule)' }}>
      {entries.map((entry, i) => (
        <div
          key={entry.handle}
          className="flex items-center gap-4 py-4"
          style={{
            borderBottom: '1px solid var(--rule)',
            background: entry.isViewer ? 'var(--accent-soft)' : 'transparent',
          }}
        >
          <span
            className="font-data text-sm w-6 text-right shrink-0"
            style={{ color: 'var(--ink-muted)' }}
          >
            {i + 1}
          </span>

          <Avatar src={entry.avatarUrl} handle={entry.handle} size={32} />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/u/${entry.handle}`}
                className="font-ui text-sm font-semibold hover:opacity-70 transition-opacity truncate"
              >
                @{entry.handle}
              </Link>
              {entry.isViewer && (
                <span
                  className="font-data text-[10px] uppercase tracking-wide px-1.5 py-0.5"
                  style={{ background: 'var(--accent)', color: 'var(--paper)' }}
                >
                  you
                </span>
              )}
            </div>
            <p className="font-data text-xs mt-0.5" style={{ color: 'var(--ink-muted)' }}>
              Stage {entry.stageIndex} of 4 . {entry.companionCount.toLocaleString()}{' '}
              {entry.companionCount === 1 ? 'companion' : 'companions'}
            </p>
          </div>

          <span className="font-data text-sm font-semibold shrink-0">
            {entry.totalXp.toLocaleString()} <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>xp</span>
          </span>
        </div>
      ))}
    </div>
  )
}
