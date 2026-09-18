import { describe, expect, it } from 'vitest'
import {
  addSyncRequestUsage,
  DEFAULT_SYNC_SCHEDULE,
  describeSyncSchedulePause,
  estimateSyncRequests,
  GITHUB_HOURLY_REQUEST_CEILING,
  isSyncScheduleInterval,
  MAX_EVENTS_PER_REPOSITORY,
  MAX_EVENTS_PER_SYNC,
  MAX_SYNC_REPOSITORIES,
  mergeSyncRequestUsage,
  parseSyncSchedule,
  planScheduledSync,
  pruneSyncRequestUsage,
  requestsInUsageWindow,
  REQUESTS_PER_REPOSITORY_ESTIMATE,
  scheduleIntervalMs,
  scheduleTick,
  SYNC_REQUEST_BUDGET_PER_HOUR,
  syncScheduleLabel,
  type SyncRequestUsageEntry,
} from './sync-schedule'

const NOW = 1_700_000_000_000
const MINUTE = 60 * 1000
/** The account the docs and the sync route are written around. */
const TRACKED_REPOSITORIES = 44
const OBSERVED_REQUESTS_PER_SYNC = 792

function plan(overrides: Partial<Parameters<typeof planScheduledSync>[0]> = {}) {
  return planScheduledSync({
    interval: '15',
    now: NOW,
    lastAttemptAt: null,
    requestsInWindow: 0,
    trackedRepositoryCount: TRACKED_REPOSITORIES,
    lastObservedRequests: null,
    busy: false,
    ...overrides,
  })
}

describe('scheduled GitHub sync', () => {
  it('defaults to the documented 15-minute cadence with the documented options', () => {
    expect(DEFAULT_SYNC_SCHEDULE).toBe('15')
    expect(parseSyncSchedule('manual')).toBe('manual')
    expect(parseSyncSchedule('5')).toBe('5')
    expect(parseSyncSchedule('30')).toBe('30')
    expect(parseSyncSchedule('2')).toBe('15')
    expect(parseSyncSchedule(undefined)).toBe('15')
    expect(isSyncScheduleInterval('15')).toBe(true)
    expect(isSyncScheduleInterval('hourly')).toBe(false)
    expect(scheduleIntervalMs('manual')).toBeNull()
    expect(scheduleIntervalMs('5')).toBe(5 * MINUTE)
    expect(scheduleIntervalMs('15')).toBe(15 * MINUTE)
    expect(scheduleIntervalMs('30')).toBe(30 * MINUTE)
    expect(syncScheduleLabel('manual')).toBe('Manual only')
    expect(syncScheduleLabel('15')).toBe('Every 15 minutes')
  })

  it('never runs a manual schedule or a second sync while one is in flight', () => {
    expect(plan({ interval: 'manual' })).toMatchObject({ run: false, reason: 'manual' })
    expect(plan({ busy: true, lastAttemptAt: NOW - 30 * MINUTE }))
      .toMatchObject({ run: false, reason: 'in-progress', nextDueAt: null })
  })

  it('waits for the cadence and reports the next due time', () => {
    const lastAttemptAt = NOW - 5 * MINUTE
    const result = plan({ lastAttemptAt })

    expect(result).toMatchObject({
      run: false,
      reason: 'not-due',
      nextDueAt: lastAttemptAt + 15 * MINUTE,
    })
  })

  it('derives the read window from the request budget and the checkpoint capacity together', () => {
    // REGRESSION: the window used to come from the hourly request budget alone
    // (222 repositories), while the checkpoint accepted only 5,000 event IDs.
    // A heavy repository produces up to 300 events, so a full window could
    // build a checkpoint its own validator rejects -- the sync failed in-band
    // and the baseline never committed. The two bounds must agree by
    // construction, and this is the assertion that keeps them from drifting.
    expect(MAX_SYNC_REPOSITORIES).toBe(Math.min(
      Math.floor(SYNC_REQUEST_BUDGET_PER_HOUR / REQUESTS_PER_REPOSITORY_ESTIMATE),
      Math.floor(MAX_EVENTS_PER_SYNC / MAX_EVENTS_PER_REPOSITORY),
    ))
    expect(MAX_SYNC_REPOSITORIES * MAX_EVENTS_PER_REPOSITORY)
      .toBeLessThanOrEqual(MAX_EVENTS_PER_SYNC)
    // The repository-side bound is real: each repository can genuinely emit
    // this many events (30 commit days + 90 pull requests + 30 releases +
    // 30 linked issues + 90 CI successes).
    expect(MAX_EVENTS_PER_REPOSITORY).toBe(300)
  })

  it('runs when the cadence is due', () => {
    expect(plan({ lastAttemptAt: NOW - 15 * MINUTE })).toMatchObject({ run: true })
    expect(plan({ lastAttemptAt: NOW - 16 * MINUTE })).toMatchObject({ run: true })
  })

  it('does not fire a sync just because the page opened', () => {
    // REGRESSION: `lastAttemptAt === null` used to mean "due now", so every
    // page load started an unsolicited GitHub sync and spent the account's
    // request budget before the user did anything. A schedule that has never
    // run waits one interval instead; Sync GitHub now is still available.
    const result = plan({ lastAttemptAt: null })

    expect(result).toMatchObject({
      run: false,
      reason: 'not-due',
      nextDueAt: NOW + 15 * MINUTE,
    })
  })

  it('keeps a 5-minute cadence affordable for the window a sync actually reads', () => {
    // The window reads at most MAX_SYNC_REPOSITORIES repositories (16), so its
    // cost is the window estimate, not the 44-repository total: 12 x 16 x 18 =
    // 3,456 requests per hour, inside the 4,000 budget. Estimating from the
    // whole tracked set is what used to pause this cadence forever.
    const windowEstimate = estimateSyncRequests(MAX_SYNC_REPOSITORIES, null)
    expect(windowEstimate).toBe(MAX_SYNC_REPOSITORIES * REQUESTS_PER_REPOSITORY_ESTIMATE)
    expect(12 * windowEstimate).toBeLessThanOrEqual(SYNC_REQUEST_BUDGET_PER_HOUR)
    expect(plan({
      interval: '5',
      lastAttemptAt: NOW - 5 * MINUTE,
      trackedRepositoryCount: MAX_SYNC_REPOSITORIES,
      requestsInWindow: SYNC_REQUEST_BUDGET_PER_HOUR - windowEstimate,
    })).toMatchObject({ run: true })
  })

  it('merges usage records from another tab instead of replacing them', () => {
    // REGRESSION: each tab held its own whole-record list and wrote it whole,
    // so two tabs erased each other's entries and both believed the account
    // had spent only its own requests. The union is the real cost.
    const merged = mergeSyncRequestUsage(
      [{ at: NOW - 10 * MINUTE, requests: 800 }],
      [{ at: NOW - 5 * MINUTE, requests: 250 }],
      [{ at: NOW - 10 * MINUTE, requests: 800 }],
    )

    expect(merged).toEqual([
      { at: NOW - 10 * MINUTE, requests: 800 },
      { at: NOW - 5 * MINUTE, requests: 250 },
    ])
    expect(mergeSyncRequestUsage([{ at: NOW, requests: -1 }], [{ at: Number.NaN, requests: 10 }])).toEqual([])
  })

  it('estimates a sync from the observed cost, with a per-repository floor', () => {
    expect(estimateSyncRequests(TRACKED_REPOSITORIES, null))
      .toBe(TRACKED_REPOSITORIES * REQUESTS_PER_REPOSITORY_ESTIMATE)
    expect(estimateSyncRequests(TRACKED_REPOSITORIES, OBSERVED_REQUESTS_PER_SYNC))
      .toBe(OBSERVED_REQUESTS_PER_SYNC)
    // A tracked set that grew since the last sync must not be undercounted.
    expect(estimateSyncRequests(80, OBSERVED_REQUESTS_PER_SYNC)).toBe(80 * REQUESTS_PER_REPOSITORY_ESTIMATE)
    expect(estimateSyncRequests(0, null)).toBe(1)
    expect(estimateSyncRequests(Number.NaN, Number.NaN)).toBe(1)
  })

  it('keeps the documented 15-minute cadence inside GitHub hourly limits', () => {
    // 44 repositories x 18 requests = 792 requests per sync.
    const syncsPerHour = 60 / 15
    const hourly = syncsPerHour * OBSERVED_REQUESTS_PER_SYNC

    expect(hourly).toBe(3168)
    expect(hourly).toBeLessThan(GITHUB_HOURLY_REQUEST_CEILING)
    expect(hourly).toBeLessThanOrEqual(SYNC_REQUEST_BUDGET_PER_HOUR)
    // 3,168 is 63% of GitHub's 5,000/hour ceiling, so the schedule fits.
    expect(plan({ lastAttemptAt: NOW - 15 * MINUTE, requestsInWindow: 3168 })).toMatchObject({ run: true })
  })

  it('pauses before a 5-minute cadence can overdraw the account', () => {
    // 44 repositories x 792 = 9,600 requests/hour: five times the documented
    // 15-minute cost and well past GitHub's ceiling.
    const hourly = 12 * OBSERVED_REQUESTS_PER_SYNC
    expect(hourly).toBeGreaterThan(GITHUB_HOURLY_REQUEST_CEILING)

    const result = plan({
      interval: '5',
      lastAttemptAt: NOW - 5 * MINUTE,
      requestsInWindow: 3_300,
      lastObservedRequests: OBSERVED_REQUESTS_PER_SYNC,
    })

    expect(result).toMatchObject({
      run: false,
      reason: 'request-budget',
      estimatedRequests: OBSERVED_REQUESTS_PER_SYNC,
    })
    const notice = describeSyncSchedulePause(result, 3_300)
    expect(notice).toContain('3300 of 4000')
    expect(notice).toContain('resumes on its own')
  })

  it('explains only a budget pause, not a wait or a running sync', () => {
    expect(describeSyncSchedulePause(plan({ lastAttemptAt: NOW }), 0)).toBeNull()
    expect(describeSyncSchedulePause(plan({ interval: 'manual' }), 0)).toBeNull()
    expect(describeSyncSchedulePause(plan({ busy: true }), 0)).toBeNull()
    expect(describeSyncSchedulePause(plan(), 0)).toBeNull()
  })

  it('counts and prunes request usage over the rolling hour', () => {
    const entries: SyncRequestUsageEntry[] = [
      { at: NOW - 59 * MINUTE, requests: 800 },
      { at: NOW - 30 * MINUTE, requests: 800 },
      { at: NOW - 61 * MINUTE, requests: 800 },
    ]

    expect(pruneSyncRequestUsage(entries, NOW)).toHaveLength(2)
    expect(requestsInUsageWindow(entries, NOW)).toBe(1_600)
    expect(requestsInUsageWindow([{ at: NOW, requests: -5 }], NOW)).toBe(0)
    expect(requestsInUsageWindow([{ at: Number.NaN, requests: 10 }], NOW)).toBe(0)
  })

  it('adds only real measured cost to the usage record', () => {
    const spent = addSyncRequestUsage(
      [{ at: NOW - 61 * MINUTE, requests: 900 }],
      NOW,
      792,
    )

    expect(spent).toEqual([{ at: NOW, requests: 792 }])
    // A failed attempt before the first request, or a corrupt count, must not
    // invent a cost that would pause the schedule for no reason.
    expect(addSyncRequestUsage(spent, NOW, 0)).toEqual([{ at: NOW, requests: 792 }])
    expect(addSyncRequestUsage(spent, NOW, Number.NaN)).toEqual([{ at: NOW, requests: 792 }])
  })

  it('drives one tick end to end: prune, decide, and produce the panel copy', () => {
    const usage: SyncRequestUsageEntry[] = [
      { at: NOW - 5 * MINUTE, requests: 792 },
      { at: NOW - 61 * MINUTE, requests: 999 },
    ]
    const base = {
      interval: '15' as const,
      now: NOW,
      usage,
      trackedRepositoryCount: TRACKED_REPOSITORIES,
      lastObservedRequests: OBSERVED_REQUESTS_PER_SYNC,
      busy: false,
    }

    // Due and affordable: the tick runs and drops the expired usage entry.
    const due = scheduleTick({ ...base, lastAttemptAt: NOW - 15 * MINUTE })
    expect(due).toMatchObject({ run: true, notice: '', nextLabel: '' })
    expect(due.usage).toEqual([{ at: NOW - 5 * MINUTE, requests: 792 }])

    // Waiting: the tick stays quiet but tells the user when the next run is.
    const waiting = scheduleTick({ ...base, lastAttemptAt: NOW - MINUTE })
    expect(waiting.run).toBe(false)
    expect(waiting.nextLabel).toContain('next in about 14 min')

    // In flight: no second sync and no misleading copy.
    expect(scheduleTick({ ...base, lastAttemptAt: NOW - MINUTE, busy: true }))
      .toMatchObject({ run: false, notice: '', nextLabel: '' })

    // Over budget: the tick refuses and explains, and the usage record is kept
    // so the cadence clock does not silently restart on every tick.
    const overBudget = scheduleTick({
      ...base,
      interval: '5',
      lastAttemptAt: NOW - 5 * MINUTE,
      usage: [{ at: NOW - MINUTE, requests: 3_300 }],
    })
    expect(overBudget.run).toBe(false)
    expect(overBudget.notice).toContain('3300 of 4000')
    expect(overBudget.usage).toEqual([{ at: NOW - MINUTE, requests: 3_300 }])
  })
})
