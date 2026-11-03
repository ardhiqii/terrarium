/**
 * The daily-budget meter.
 *
 * WHY THIS FILE EXISTS AT ALL: `resolveActivityLog` has always returned `dayXp` and `day`,
 * and until now nothing asserted either of them. The meter was computed from
 * `occurredAt.slice(0, 10)` while the ledger charged events to the day in their cap key, so
 * the two disagreed about what day it was: a scan of twenty backdated notes spent the whole
 * 300 XP budget while the meter read 0/300. A number the user sees that the engine never
 * used is worse than no number.
 */
import { describe, expect, it } from 'vitest'
import { GLOBAL_DAILY_XP_BUDGET, asCompanionId, asEventId, type NormalizedEvent } from './events'
import { resolveActivityLog } from './activity-log'

const SCAN_DAY = '2026-10-01'

function note(index: number, occurredDay: string): NormalizedEvent {
  return {
    eventId: asEventId(`note-${index}`),
    companionId: asCompanionId('gengar'),
    source: 'mounted-markdown',
    sourceId: 'vault-1',
    provenance: 'local',
    category: 'new-note',
    // The mtime, which is the user's to choose and which the caps stopped trusting.
    occurredAt: `${occurredDay}T09:00:00.000Z`,
    cap: { key: `mounted-markdown:${SCAN_DAY}:new-note`, limit: 20 },
  }
}

describe('the budget meter', () => {
  it('reports what the ledger charged the day, not what the timestamps say', () => {
    // Twenty notes with distinct 2019 mtimes, all scanned on 2026-10-01. The ledger charges
    // every one of them to the scan day and accepts twelve (300 XP).
    const events = Array.from({ length: 20 }, (_, i) =>
      note(i, `2019-03-${String(1 + i).padStart(2, '0')}`),
    )

    const log = resolveActivityLog({ events })

    expect(log.totalXp).toBe(GLOBAL_DAILY_XP_BUDGET)
    expect(log.dayXp).toBe(GLOBAL_DAILY_XP_BUDGET)
    expect(log.day).toBe(SCAN_DAY)
    expect(log.skippedCount).toBe(8)
  })

  it('never reports more than the budget it is measuring', () => {
    const events = Array.from({ length: 40 }, (_, i) => note(i, SCAN_DAY))
    const log = resolveActivityLog({ events })

    expect(log.dayXp).toBeLessThanOrEqual(GLOBAL_DAILY_XP_BUDGET)
    expect(log.dayXp).toBe(GLOBAL_DAILY_XP_BUDGET)
  })

  it('shows the day a live session is in, and zero when nothing on it counted', () => {
    const spent = Array.from({ length: 12 }, (_, i) => note(i, SCAN_DAY))
    const capped = resolveActivityLog({ events: spent })
    expect(capped.dayXp).toBe(GLOBAL_DAILY_XP_BUDGET)

    // One more note on the same day is listed but earns nothing: the meter stays at full,
    // it does not drop to zero or climb past the ceiling.
    const overflow = resolveActivityLog({ events: [...spent, note(99, SCAN_DAY)] })
    expect(overflow.dayXp).toBe(GLOBAL_DAILY_XP_BUDGET)
    expect(overflow.skippedCount).toBe(1)
    expect(overflow.entries.filter((entry) => !entry.counted).map((entry) => entry.skipReason)).toEqual([
      "Beyond today's overall xp budget",
    ])
  })
})
