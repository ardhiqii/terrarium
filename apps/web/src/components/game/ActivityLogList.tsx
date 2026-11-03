'use client'

import { useMemo } from 'react'
import type { EventLedger } from '@/lib/game/events'
import { GLOBAL_DAILY_XP_BUDGET } from '@/lib/game/events'
import { resolveActivityLog } from '@/lib/game/activity-log'
import { displayCompanionName } from './display-name'

/**
 * The user-facing activity log: what this companion earned, from where, when.
 *
 * Rows that earned nothing are shown, not hidden, because the commonest reason
 * for a quiet day is a daily cap and a log that hides its own exclusions makes
 * that look like a bug. A capped row reads "no xp" with the reason inline.
 *
 * Nothing here is persisted: the entries are derived from the ledger on render,
 * so the log can never disagree with the XP total above it.
 */
export interface ActivityLogListProps {
  ledger: EventLedger
  /** Show only this companion's events. Omit for every recorded event. */
  companionId?: string
  /** How many rows to render. The log is a summary, not an archive dump. */
  limit?: number
}

function shortDate(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

export function ActivityLogList({ ledger, companionId, limit = 12 }: ActivityLogListProps) {
  const log = useMemo(
    () =>
      resolveActivityLog(ledger, companionId ? { companionId } : {}),
    [ledger, companionId],
  )

  if (log.entries.length === 0) {
    return (
      <p className="font-prose text-sm" style={{ color: 'var(--ink-muted)' }}>
        No activity recorded yet. Writing a note or landing a pull request will
        show up here.
      </p>
    )
  }

  const visible = log.entries.slice(0, limit)
  const hidden = log.entries.length - visible.length
  // The budget meter, so a user sees WHY they stopped earning without having to
  // find a rejected row and read the reason. Uses `dayXp`, not `totalXp`: the
  // budget is one day wide and spans every companion, while `totalXp` is this
  // companion's lifetime, so the lifetime figure rendered "1,800 / 300".
  // Only shown once it is close enough to matter: the honest ceiling for both
  // current sources is 221, so showing "30 / 300" every day would read as noise.
  const budgetUsed = log.dayXp
  const budgetPct = Math.min(1, budgetUsed / GLOBAL_DAILY_XP_BUDGET)
  const showBudget = budgetPct >= 0.5

  return (
    <div className="font-data text-xs">
      {showBudget ? (
        <div className="mb-3">
          <div className="flex items-baseline justify-between gap-3">
            <span style={{ color: 'var(--ink-muted)' }}>Today's xp budget</span>
            <span style={{ color: 'var(--ink-muted)' }}>
              {budgetUsed} / {GLOBAL_DAILY_XP_BUDGET}
            </span>
          </div>
          <div
            className="mt-1.5 h-1.5 w-full"
            style={{ background: 'var(--rule)' }}
            role="progressbar"
            aria-label="Today's xp budget"
            aria-valuenow={Math.round(budgetPct * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${Math.round(budgetPct * 100)}%`}
          >
            <div
              className="h-full"
              style={{ width: `${budgetPct * 100}%`, background: 'var(--accent)' }}
            />
          </div>
        </div>
      ) : null}
      <ul className="flex flex-col">
        {visible.map((entry) => (
          <li
            key={entry.eventId}
            className="flex items-baseline justify-between gap-3 border-b py-2 last:border-b-0"
            style={{ borderColor: 'var(--rule)' }}
          >
            <span className="min-w-0">
              <span style={{ color: 'var(--ink)' }}>{entry.label}</span>
              <span style={{ color: 'var(--ink-muted)' }}> in {entry.sourceLabel}</span>
              {!entry.counted && entry.skipReason ? (
                <span className="block" style={{ color: 'var(--ink-muted)' }}>
                  {entry.skipReason}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-right">
              <span
                style={{ color: entry.counted ? 'var(--ink)' : 'var(--ink-muted)' }}
              >
                {entry.counted ? `+${entry.xp} xp` : 'no xp'}
              </span>
              <span className="block" style={{ color: 'var(--ink-muted)' }}>
                {shortDate(entry.occurredAt)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div
        className="mt-3 flex items-baseline justify-between gap-3 border-t pt-2 font-semibold"
        style={{ borderColor: 'var(--rule)' }}
      >
        <span style={{ color: 'var(--ink-muted)' }}>
          {companionId
            ? `${displayCompanionName(companionId)} total`
            : 'Recorded total'}
        </span>
        <span style={{ color: 'var(--ink)' }}>{log.totalXp.toLocaleString()} xp</span>
      </div>

      {log.skippedCount > 0 ? (
        <p className="mt-2" style={{ color: 'var(--ink-muted)' }}>
          {log.skippedCount} {log.skippedCount === 1 ? 'entry' : 'entries'} earned
          nothing after the daily limits.
        </p>
      ) : null}

      {hidden > 0 ? (
        <p className="mt-2" style={{ color: 'var(--ink-muted)' }}>
          {hidden} older {hidden === 1 ? 'entry' : 'entries'} not shown.
        </p>
      ) : null}
    </div>
  )
}
