/**
 * Scheduled GitHub sync cadence and its GitHub request budget.
 *
 * The docs promise a schedule that runs while the website is open: manual,
 * 5-minute, 15-minute (the default), and 30-minute choices. A schedule is only
 * affordable if it respects GitHub's hourly request ceiling for the account:
 * one sync reads a window of {@link MAX_SYNC_REPOSITORIES} repositories and
 * costs roughly {@link REQUESTS_PER_REPOSITORY_ESTIMATE} requests per
 * repository, so an account at the window spends only a few hundred requests
 * per sync. Every 15 minutes fits inside the hourly budget; every 5 minutes
 * does not for a large tracked set. The planner therefore spends only up to
 * {@link SYNC_REQUEST_BUDGET_PER_HOUR} of the ceiling and pauses the schedule
 * (with an explanation, not silence) until the rolling hour window clears.
 *
 * The same module owns the read window itself, because two independent caps
 * must agree: the hourly request budget and the deferred-baseline checkpoint's
 * event capacity. If the window were derived from the request budget alone, a
 * heavy account could read more events than the checkpoint can carry, and
 * issuance -- which runs inside the sync -- would throw and fail the whole
 * sync in-band.
 *
 * This module is deliberately pure and free of browser and Node APIs: the panel
 * owns the timer and localStorage, and the tests own time and usage.
 */

/** Cadence choices, matching the documented manual/5/15/30 option set. */
export const SYNC_SCHEDULE_OPTIONS = ['manual', '5', '15', '30'] as const

export type SyncScheduleInterval = (typeof SYNC_SCHEDULE_OPTIONS)[number]

/** Documented default: a scheduled sync runs every 15 minutes. */
export const DEFAULT_SYNC_SCHEDULE: SyncScheduleInterval = '15'

const INTERVAL_MINUTES: Readonly<Record<Exclude<SyncScheduleInterval, 'manual'>, number>> = {
  '5': 5,
  '15': 15,
  '30': 30,
}

const MINUTE_MS = 60 * 1000

/** GitHub's hourly ceiling for an authenticated account's REST requests. */
export const GITHUB_HOURLY_REQUEST_CEILING = 5_000

/**
 * The share of the hourly ceiling the schedule may spend. The remainder is
 * reserved for the repository listing, a manual sync, and profile reads in the
 * same hour, so the account never runs itself into a hard GitHub rate limit.
 */
export const SYNC_REQUEST_BUDGET_PER_HOUR = 4_000

/** Measured cost of reading one repository (activity lists plus commit details). */
export const REQUESTS_PER_REPOSITORY_ESTIMATE = 18

/**
 * Worst-case events a single repository can contribute to one sync.
 *
 * Derived from the fetcher's own read bounds (github-events-fetch.ts), not
 * measured from a single account:
 *   - 30 commits (MAX_COMMITS_PER_REPO) -> <=30 active-day + <=30 work-session
 *   - 3 pages x 30 merged pull requests = 90
 *   - one page x 30 releases = 30
 *   - one page x 30 closed linked issues = 30
 *   - one successful-CI event per merged pull request = 90
 */
export const MAX_EVENTS_PER_REPOSITORY = 300

/**
 * Events one sync may hand to the deferred-baseline checkpoint.
 *
 * This is the checkpoint's transport bound, not a guess: 5,000 event IDs plus
 * both 500-entry baseline maps encode to well under the 256 KB signed-token
 * limit, and the corresponding snapshot stays inside the product body cap.
 */
export const MAX_EVENTS_PER_SYNC = 5_000

/**
 * Repositories a single sync reads.
 *
 * Bounded from both sides so the numbers can never drift apart: the hourly
 * request budget on one side, and the checkpoint's event capacity divided by
 * the worst-case per-repository event count on the other. Repositories that
 * still need a baseline are read first, so a tracked set larger than the window
 * is still covered completely, window by window, without stranding a
 * repository forever.
 */
export const MAX_SYNC_REPOSITORIES = Math.min(
  Math.floor(SYNC_REQUEST_BUDGET_PER_HOUR / REQUESTS_PER_REPOSITORY_ESTIMATE),
  Math.floor(MAX_EVENTS_PER_SYNC / MAX_EVENTS_PER_REPOSITORY),
)

/** Rolling window over which spent requests are counted. */
export const SYNC_USAGE_WINDOW_MS = 60 * 60 * 1000

export interface SyncRequestUsageEntry {
  /** Epoch milliseconds when the sync finished. */
  readonly at: number
  /** Requests the sync actually issued, as reported by its progress stream. */
  readonly requests: number
}

export interface ScheduledSyncInput {
  readonly interval: SyncScheduleInterval
  /** Epoch milliseconds used for every due-time and window comparison. */
  readonly now: number
  /** When the last sync was attempted, scheduled or manual. */
  readonly lastAttemptAt: number | null
  readonly requestsInWindow: number
  readonly trackedRepositoryCount: number
  readonly lastObservedRequests: number | null
  /** True while a sync is already running. */
  readonly busy: boolean
}

export type ScheduledSyncSkipReason = 'manual' | 'in-progress' | 'not-due' | 'request-budget'

export type ScheduledSyncPlan =
  | { readonly run: true; readonly estimatedRequests: number }
  | {
      readonly run: false
      readonly reason: ScheduledSyncSkipReason
      readonly estimatedRequests: number
      /** Epoch milliseconds of the next due time, when one is known. */
      readonly nextDueAt: number | null
    }

export function isSyncScheduleInterval(value: unknown): value is SyncScheduleInterval {
  return typeof value === 'string' && (SYNC_SCHEDULE_OPTIONS as readonly string[]).includes(value)
}

/** Parse a stored schedule value, falling back to the documented default. */
export function parseSyncSchedule(value: unknown): SyncScheduleInterval {
  return isSyncScheduleInterval(value) ? value : DEFAULT_SYNC_SCHEDULE
}

/** Interval between automatic syncs, or `null` when only manual syncs run. */
export function scheduleIntervalMs(interval: SyncScheduleInterval): number | null {
  if (interval === 'manual') return null
  return INTERVAL_MINUTES[interval] * MINUTE_MS
}

/** Human-readable label for the schedule control. */
export function syncScheduleLabel(interval: SyncScheduleInterval): string {
  return interval === 'manual' ? 'Manual only' : `Every ${interval} minutes`
}

/**
 * Union usage records without counting the same entry twice.
 *
 * Two tabs share one browser profile, so a write from one tab must not erase
 * the spend another tab recorded; the union is the account's real cost.
 */
export function mergeSyncRequestUsage(
  ...collections: readonly (readonly SyncRequestUsageEntry[])[]
): SyncRequestUsageEntry[] {
  const merged = new Map<string, SyncRequestUsageEntry>()
  for (const entry of collections.flat()) {
    if (!Number.isFinite(entry.at) || !Number.isFinite(entry.requests) || entry.requests < 0) continue
    merged.set(`${entry.at}:${entry.requests}`, { at: entry.at, requests: Math.round(entry.requests) })
  }
  return [...merged.values()].sort((left, right) => left.at - right.at)
}

/** Drop usage entries that fell out of the rolling window. */
export function pruneSyncRequestUsage(
  entries: readonly SyncRequestUsageEntry[],
  now: number,
): SyncRequestUsageEntry[] {
  return entries.filter((entry) =>
    Number.isFinite(entry.at) &&
    Number.isFinite(entry.requests) &&
    entry.requests >= 0 &&
    now - entry.at < SYNC_USAGE_WINDOW_MS,
  )
}

/** Requests spent in the rolling window, ignoring malformed stored entries. */
export function requestsInUsageWindow(
  entries: readonly SyncRequestUsageEntry[],
  now: number,
): number {
  return pruneSyncRequestUsage(entries, now).reduce((total, entry) => total + entry.requests, 0)
}

/** Add one sync's measured cost to the rolling usage record. */
export function addSyncRequestUsage(
  entries: readonly SyncRequestUsageEntry[],
  now: number,
  requests: number,
): SyncRequestUsageEntry[] {
  if (!Number.isFinite(requests) || requests <= 0) return pruneSyncRequestUsage(entries, now)
  return pruneSyncRequestUsage(
    [...entries, { at: now, requests: Math.round(requests) }],
    now,
  )
}

/**
 * Requests a sync is expected to spend.
 *
 * The observed cost of the last sync is the best evidence available, but a
 * tracked set that grew since then would make it an undercount, so the
 * per-repository estimate is used as a floor.
 */
export function estimateSyncRequests(
  trackedRepositoryCount: number,
  lastObservedRequests: number | null,
): number {
  const tracked = Number.isFinite(trackedRepositoryCount)
    ? Math.max(0, Math.floor(trackedRepositoryCount))
    : 0
  const observed = lastObservedRequests !== null && Number.isFinite(lastObservedRequests) && lastObservedRequests >= 0
    ? Math.round(lastObservedRequests)
    : 0
  return Math.max(1, tracked * REQUESTS_PER_REPOSITORY_ESTIMATE, observed)
}

/**
 * Decide whether a scheduled sync may run now.
 *
 * Ordered so the cheapest explanation wins: a manual schedule never runs, a
 * sync already in flight is never doubled, a cadence that is not due waits, and
 * a cadence that would overdraw the hourly request budget pauses instead of
 * spending requests GitHub will refuse.
 */
export function planScheduledSync(input: ScheduledSyncInput): ScheduledSyncPlan {
  const estimatedRequests = estimateSyncRequests(
    input.trackedRepositoryCount,
    input.lastObservedRequests,
  )
  const intervalMs = scheduleIntervalMs(input.interval)

  if (intervalMs === null) {
    return { run: false, reason: 'manual', estimatedRequests, nextDueAt: null }
  }
  if (input.busy) {
    return { run: false, reason: 'in-progress', estimatedRequests, nextDueAt: null }
  }

  // A schedule that has never recorded an attempt waits one interval from the
  // first tick rather than running immediately: otherwise every page load is
  // itself an unsolicited GitHub sync. The user can still sync by hand.
  const nextDueAt = (input.lastAttemptAt ?? input.now) + intervalMs
  if (input.now < nextDueAt) {
    return { run: false, reason: 'not-due', estimatedRequests, nextDueAt }
  }
  if (input.requestsInWindow + estimatedRequests > SYNC_REQUEST_BUDGET_PER_HOUR) {
    // Pausing must not silently retry every tick: the caller records the
    // attempt time, so the cadence clock keeps running across a pause.
    return { run: false, reason: 'request-budget', estimatedRequests, nextDueAt: null }
  }
  return { run: true, estimatedRequests }
}

/** User-facing explanation for a paused schedule, or `null` when it is running. */
export function describeSyncSchedulePause(
  plan: ScheduledSyncPlan,
  requestsInWindow: number,
): string | null {
  if (plan.run || plan.reason === 'not-due' || plan.reason === 'manual') return null
  if (plan.reason === 'in-progress') return null
  return `Automatic sync paused: ${Math.round(requestsInWindow)} of ${SYNC_REQUEST_BUDGET_PER_HOUR} GitHub requests for this hour are already spent. It resumes on its own once the hour window clears.`
}

export type ScheduleTickInput = Omit<ScheduledSyncInput, 'requestsInWindow'> & {
  readonly usage: readonly SyncRequestUsageEntry[]
}

export interface ScheduleTickResult {
  /** Usage record with anything outside the rolling hour removed. */
  readonly usage: readonly SyncRequestUsageEntry[]
  readonly run: boolean
  /** Pause explanation, empty when the schedule is healthy. */
  readonly notice: string
  /** Next-due copy for a healthy schedule that is simply waiting. */
  readonly nextLabel: string
}

/**
 * One scheduler tick: prune usage, decide, and produce the exact copy the panel
 * shows. The panel owns only the timer and the state writes, so the decision,
 * the accounting, and the wording are all exercised by the unit tests.
 */
export function scheduleTick(input: ScheduleTickInput): ScheduleTickResult {
  const usage = pruneSyncRequestUsage(input.usage, input.now)
  const requestsInWindow = requestsInUsageWindow(usage, input.now)
  const plan = planScheduledSync({ ...input, requestsInWindow })
  if (plan.run) {
    return { usage, run: true, notice: '', nextLabel: '' }
  }
  return {
    usage,
    run: false,
    notice: describeSyncSchedulePause(plan, requestsInWindow) ?? '',
    nextLabel: plan.reason === 'not-due' && plan.nextDueAt !== null
      ? `Runs while this page is open · next in about ${minutesUntil(plan.nextDueAt, input.now)} min.`
      : '',
  }
}

function minutesUntil(timestamp: number, now: number): number {
  return Math.max(1, Math.round((timestamp - now) / 60000))
}
