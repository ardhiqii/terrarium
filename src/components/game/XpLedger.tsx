import type { XpEntry } from '@/lib/game/types'

/**
 * One row per XpEntry, grouped with a single top rule and a total row set
 * apart, rather than a hairline under every row (DESIGN.md 6 bans that
 * pattern). Entries with count === 0 are hidden rather than shown as zeros,
 * since a garden with no backlinks yet has nothing worth reporting there.
 */
export interface XpLedgerProps {
  entries: XpEntry[]
  total: number
}

export function XpLedger({ entries, total }: XpLedgerProps) {
  const visible = entries.filter((e) => e.count > 0)

  return (
    <div className="font-data text-xs">
      <div
        className="pb-2 mb-2 border-t"
        style={{ borderColor: 'var(--rule)' }}
      />

      {visible.length === 0 ? (
        <p style={{ color: 'var(--ink-muted)' }} className="py-2">
          No observations logged yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((entry) => (
            <div
              key={entry.source}
              className="flex items-baseline justify-between gap-3"
            >
              <span style={{ color: 'var(--ink-muted)' }} className="truncate">
                {entry.label}
                <span style={{ color: 'var(--rule)' }}> x{entry.count}</span>
              </span>
              <span style={{ color: 'var(--ink)' }} className="shrink-0">
                {entry.xp} xp
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        className="flex items-baseline justify-between mt-3 pt-2 border-t font-semibold"
        style={{ borderColor: 'var(--rule)' }}
      >
        <span style={{ color: 'var(--ink)' }}>Total</span>
        <span style={{ color: 'var(--ink)' }}>{total} xp</span>
      </div>
    </div>
  )
}
