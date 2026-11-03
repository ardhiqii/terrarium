/**
 * Needs, derived from timestamps on read.
 *
 * THE CORE RULE: nothing here decrements. A need is a function of
 * `(care state, signals, now)`, so the same account on two devices, or the same
 * account after a week offline, computes the same number without a background
 * job and without a write on every tick. `PRODUCT.md` §4.4 states this; this
 * module is the implementation of that promise.
 *
 * WHY UNMEASURED IS `null`, NOT `100`: two of the five needs (health,
 * cleanliness) depend on signals nothing produces yet — default-branch CI
 * status and the open age of the user's own pull requests. Defaulting those to
 * 100 would make the House claim "Health 100 of 100" about something it never
 * looked at, which is exactly the class of lie `PRODUCT.md` §11.1 exists to
 * prevent. `null` renders as "not measured yet" and the matching care actions
 * refuse with `not-measured` rather than spending an item on a guess.
 *
 * Every formula is a playtest value and is expected to be tuned.
 */

import type { EventCategory, EventLedger, NormalizedEvent } from '../events'
import { localHour } from './scene'
import type { CareNeeds } from './scene'

const DAY_MS = 24 * 60 * 60 * 1000

/** Days a need's decay window looks back over. */
export const SIGNAL_WINDOW_DAYS = 7

/**
 * How stale a measurement may be before it stops counting.
 *
 * A CI result from three weeks ago says nothing about the repository today, so
 * an old observation is discarded rather than trusted. Without this, one green
 * build would keep health at 100 forever.
 */
export const SIGNAL_FRESHNESS_DAYS = 14

/**
 * The signals needs are computed from.
 *
 * `activityDays` and `lateNightDays` are LOCAL days (`YYYY-MM-DD` in the
 * viewer's timezone), not UTC days: a commit at 23:30 in Jakarta is a late
 * night even though it is 16:30 UTC, and a streak must roll over at the user's
 * midnight or it will look broken for eight hours a day.
 */
export interface CareSignals {
  /** Local days carrying at least one ledger event, oldest first. */
  readonly activityDays: readonly string[]
  /** Local days whose work session ran between 22:00 and 04:59. */
  readonly lateNightDays: readonly string[]
  /** Distinct event categories seen inside the window. */
  readonly categoriesInWindow: readonly EventCategory[]
  readonly lastActivityAt: string | null
  readonly lastQualifyingActiveDayAt: string | null
  readonly lastWorkSessionAt: string | null
  readonly lastNoteAt: string | null
  /**
   * Default-branch CI state for the user's repositories.
   *
   * `unknown` is the honest default: the GitHub sync does not yet report a
   * failing default branch, so nothing here can claim the build is green.
   * Health stays unmeasured until that producer exists.
   */
  readonly ciStatus: 'green' | 'red' | 'unknown'
  /** When the current CI state was observed. A heal after this clears it. */
  readonly ciSince: string | null
  /** Days the user's own pull requests have been open, or `null` if unknown. */
  readonly staleOwnPrDays: number | null
  /** When the current staleness was observed. A clean after this clears it. */
  readonly staleSince: string | null
  /** The viewer's local day at the moment these signals were derived. */
  readonly today: string
}

export interface DeriveCareSignalsOptions {
  /**
   * The viewer's offset east of UTC, as `-new Date().getTimezoneOffset()`.
   *
   * `PRODUCT.md` §5 wants the account's progress timezone here. Until that
   * exists server-side, the browser supplies its own offset and the limitation
   * is documented in `docs/PRODUCT.md`.
   */
  readonly utcOffsetMinutes?: number
  /** Rolling window for the category-mix signal. Defaults to 7 days. */
  readonly windowDays?: number
  /** CI observation, when a producer has one. */
  readonly ci?: { readonly status: 'green' | 'red'; readonly since: string }
  /** Own-PR staleness, when a producer has one. */
  readonly stale?: { readonly days: number; readonly since: string }
}

/** The local calendar day a timestamp falls on, given an offset east of UTC. */
export function localDay(timestamp: string, utcOffsetMinutes = 0): string | null {
  const ms = parseTimestamp(timestamp)
  if (ms === null) return null
  return new Date(ms + utcOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** Parse a timestamp, returning `null` for anything unusable. */
export function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * A timestamp that can be believed: parseable and not implausibly in the future.
 * See `FUTURE_TOLERANCE_MS`. Returns `null` for a broken clock, which callers
 * treat as "no anchor", never as "now".
 */
export function usableTimestamp(
  value: string | null | undefined,
  nowMs: number,
): number | null {
  const ms = parseTimestamp(value)
  if (ms === null) return null
  if (ms > nowMs + FUTURE_TOLERANCE_MS) return null
  return ms
}

/**
 * Whole days between two instants.
 *
 * A clock that went backwards (a synced device with a stale time, a user
 * changing their system clock) yields 0, never a negative number: a need that
 * *rises* when time moves backwards would be a free refill.
 */
export function daysSince(nowMs: number, thenMs: number): number {
  const delta = nowMs - thenMs
  if (!Number.isFinite(delta) || delta <= 0) return 0
  return Math.floor(delta / DAY_MS)
}

/**
 * How far in the future a timestamp may be and still be believed.
 *
 * A device with a wrong clock is the only clock this feature has: a laptop set a
 * year ahead writes `lastFedAt` in 2027, and since hunger treats any future
 * timestamp as "just fed", that one record pins hunger at 100 on every device it
 * syncs to. Five minutes absorbs ordinary drift between devices; anything beyond
 * that is a broken clock and is ignored, so the previous anchor wins and decay
 * resumes.
 */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000

function latestTimestamp(
  values: readonly (string | null | undefined)[],
  nowMs: number,
): { value: string | null; ms: number | null } {
  let best: string | null = null
  let bestMs: number | null = null
  for (const value of values) {
    const ms = parseTimestamp(value)
    if (ms === null) continue
    if (ms > nowMs + FUTURE_TOLERANCE_MS) continue
    if (bestMs === null || ms > bestMs) {
      bestMs = ms
      best = value ?? null
    }
  }
  return { value: best, ms: bestMs }
}

/**
 * Consecutive active days ending today or yesterday.
 *
 * Yesterday counts so the streak does not read zero all morning before the
 * first commit, which would tell a user with a 40-day streak that they had
 * broken it at midnight.
 */
export function streakLength(activityDays: readonly string[], today: string): number {
  const days = new Set(activityDays)
  if (days.size === 0) return 0

  const cursor = new Date(`${today}T00:00:00.000Z`)
  if (Number.isNaN(cursor.getTime())) return 0
  if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1)

  let streak = 0
  for (;;) {
    const key = cursor.toISOString().slice(0, 10)
    if (!days.has(key)) break
    streak += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return streak
}

function isNoteCategory(category: EventCategory): boolean {
  return (
    category === 'new-note' ||
    category === 'new-words' ||
    category === 'resolved-wikilink' ||
    category === 'maturity-changed'
  )
}

/**
 * Roll a ledger into the compact signals needs consume.
 *
 * Pure and defensive: malformed timestamps are skipped instead of throwing, so
 * one corrupt restored event cannot blank the whole care panel.
 */
export function deriveCareSignals(
  ledger: EventLedger,
  now: Date,
  options: DeriveCareSignalsOptions = {},
): CareSignals {
  const offset = options.utcOffsetMinutes ?? 0
  const windowDays = options.windowDays ?? SIGNAL_WINDOW_DAYS
  const nowMs = now.getTime()
  const windowStartMs = nowMs - windowDays * DAY_MS
  const today = localDay(now.toISOString(), offset) ?? ''

  const activityDays = new Set<string>()
  const lateNightDays = new Set<string>()
  const categories = new Set<EventCategory>()
  let lastActivityMs: number | null = null
  let lastActivityAt: string | null = null
  let lastQualifyingMs: number | null = null
  let lastQualifyingActiveDayAt: string | null = null
  let lastWorkSessionMs: number | null = null
  let lastWorkSessionAt: string | null = null
  let lastNoteMs: number | null = null
  let lastNoteAt: string | null = null

  for (const event of ledger.events as readonly NormalizedEvent[]) {
    const ms = parseTimestamp(event.occurredAt)
    if (ms === null) continue
    const day = localDay(event.occurredAt, offset)
    if (day !== null) activityDays.add(day)

    if (lastActivityMs === null || ms > lastActivityMs) {
      lastActivityMs = ms
      lastActivityAt = event.occurredAt
    }

    if (event.category === 'qualifying-active-day' && (lastQualifyingMs === null || ms > lastQualifyingMs)) {
      lastQualifyingMs = ms
      lastQualifyingActiveDayAt = event.occurredAt
    }

    if (event.category === 'work-session') {
      if (lastWorkSessionMs === null || ms > lastWorkSessionMs) {
        lastWorkSessionMs = ms
        lastWorkSessionAt = event.occurredAt
      }
      const hour = localHour(new Date(ms), offset)
      if ((hour >= 22 || hour < 5) && day !== null) lateNightDays.add(day)
    }

    if (isNoteCategory(event.category) && (lastNoteMs === null || ms > lastNoteMs)) {
      lastNoteMs = ms
      lastNoteAt = event.occurredAt
    }

    if (ms >= windowStartMs) categories.add(event.category)
  }

  const ciSince = options.ci ? parseTimestamp(options.ci.since) : null
  const staleSince = options.stale ? parseTimestamp(options.stale.since) : null
  const ciIsFresh = ciSince !== null && daysSince(nowMs, ciSince) <= SIGNAL_FRESHNESS_DAYS
  const staleIsFresh = staleSince !== null && daysSince(nowMs, staleSince) <= SIGNAL_FRESHNESS_DAYS

  return {
    activityDays: [...activityDays].sort(),
    lateNightDays: [...lateNightDays].sort(),
    categoriesInWindow: [...categories].sort(),
    lastActivityAt,
    lastQualifyingActiveDayAt,
    lastWorkSessionAt,
    lastNoteAt,
    ciStatus: options.ci && ciIsFresh ? options.ci.status : 'unknown',
    ciSince: options.ci && ciIsFresh ? options.ci.since : null,
    staleOwnPrDays: options.stale && staleIsFresh ? Math.max(0, options.stale.days) : null,
    staleSince: options.stale && staleIsFresh ? options.stale.since : null,
    today,
  }
}

/** The inputs to the need formulas that live beside the ledger. */
export interface CareAnchors {
  /** When care tracking began for this companion. The floor for every decay. */
  readonly startedAt: string
  readonly lastFedAt: string | null
  readonly lastCleanedAt: string | null
  readonly lastHealedAt: string | null
  readonly lastRestedAt: string | null
}

function clampNeed(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * Hunger: 25 points a day since the last meal OR the last qualifying active day.
 *
 * Work feeds the companion. A user who shipped all week should not be told
 * their creature is starving because they never opened the House, and the plan
 * (§3.1) names "qualifying active day" as the source signal for exactly that
 * reason. Feeding is the way to top up on a quiet week, not the only way to stay
 * fed during a busy one.
 */
export function hungerFrom(anchors: CareAnchors, signals: CareSignals, now: Date): number {
  // `startedAt` is a FLOOR, not an event: it is used only when nothing has ever
  // been eaten or done. Including it in the "latest anchor" comparison would let
  // a companion that started tracking today report itself full forever, because
  // `startedAt` would always be the most recent value in the list.
  const anchor = latestTimestamp(
    [anchors.lastFedAt, signals.lastQualifyingActiveDayAt, signals.lastActivityAt],
    now.getTime(),
  )
  const floorMs = anchor.ms ?? parseTimestamp(anchors.startedAt)
  if (floorMs === null) return 0
  return clampNeed(100 - 25 * daysSince(now.getTime(), floorMs))
}

/**
 * Energy: 10 points per late-night session, 5 more per consecutive day past
 * five, reset by a rest day.
 *
 * THE REST DAY RESETS THE COUNTS, NOT JUST THE VALUE. Recomputing 100 and then
 * subtracting the same 7-day totals would put the user straight back to 30 the
 * next morning, so a "rest" would be a button that does nothing visible. After
 * `lastRestedAt`, only the sessions and the streak accumulated *since* the rest
 * count.
 *
 * Deliberately absent: any penalty for inactivity. A companion that punishes a
 * weekend off is a companion that pushes crunch, which §3.1 rules out.
 */
export function energyFrom(anchors: CareAnchors, signals: CareSignals, now: Date): number {
  const nowMs = now.getTime()
  const restMs = usableTimestamp(anchors.lastRestedAt, nowMs)
  const startMs = usableTimestamp(anchors.startedAt, nowMs)
  const streakFloorMs = restMs ?? startMs ?? 0

  const lateNights = signals.lateNightDays.filter((day) => {
    const dayMs = parseTimestamp(`${day}T00:00:00.000Z`)
    if (dayMs === null) return true
    return dayMs >= streakFloorMs
  }).length

  const streakDays = signals.activityDays.filter((day) => {
    const dayMs = parseTimestamp(`${day}T00:00:00.000Z`)
    if (dayMs === null) return true
    return dayMs >= streakFloorMs
  })
  const streak = streakLength(streakDays, signals.today)

  return clampNeed(100 - 10 * lateNights - 5 * Math.max(0, streak - 5))
}

/**
 * Diet balance: a quarter of the bar per distinct kind of activity this week.
 *
 * WHY FOUR AND NOT TEN: `EventCategory` has ten values, but they are not
 * independent — notes produce four of them, and "shipped" produces three. A
 * user who only writes notes would max a ten-category bar by writing a note,
 * a link, some words and a maturity change, which is one kind of work wearing
 * four labels. Four distinct categories is the point where a week genuinely
 * spans different sorts of activity.
 */
export function dietFrom(signals: CareSignals): number {
  const distinct = new Set(signals.categoriesInWindow).size
  return clampNeed(25 * Math.min(4, distinct))
}

/** Health: 40 while the default branch is red, 100 while green, unmeasured otherwise. */
export function healthFrom(anchors: CareAnchors, signals: CareSignals): number | null {
  if (signals.ciStatus === 'unknown') return null
  if (signals.ciStatus === 'green') return 100

  const healedMs = parseTimestamp(anchors.lastHealedAt)
  const redSinceMs = parseTimestamp(signals.ciSince)
  if (healedMs !== null && redSinceMs !== null && healedMs >= redSinceMs) return 100
  return 40
}

/** Cleanliness: 5 points lost per day the user's own pull requests sit open. */
export function cleanlinessFrom(anchors: CareAnchors, signals: CareSignals): number | null {
  if (signals.staleOwnPrDays === null) return null

  const cleanedMs = parseTimestamp(anchors.lastCleanedAt)
  const staleSinceMs = parseTimestamp(signals.staleSince)
  if (cleanedMs !== null && staleSinceMs !== null && cleanedMs >= staleSinceMs) return 100
  return clampNeed(100 - 5 * signals.staleOwnPrDays)
}

/** All five needs at once. */
export function deriveNeeds(
  anchors: CareAnchors,
  signals: CareSignals,
  now: Date,
): CareNeeds {
  return {
    hunger: hungerFrom(anchors, signals, now),
    energy: energyFrom(anchors, signals, now),
    health: healthFrom(anchors, signals),
    cleanliness: cleanlinessFrom(anchors, signals),
    diet: dietFrom(signals),
  }
}

/**
 * Dormancy: every measured need at zero, and nothing eaten for a week.
 *
 * Never removes progression (`PRODUCT.md` §4.4): it changes how the companion
 * is doing, not what it earned. The anchor is the last feed or the start of
 * tracking, so a companion that never ate has to have been neglected for a week
 * from the day it arrived, not from the epoch.
 */
export function isDormant(needs: CareNeeds, anchors: CareAnchors, now: Date): boolean {
  const measured = Object.values(needs).filter((value): value is number => value !== null)
  if (measured.length === 0) return false
  if (measured.some((value) => value > 0)) return false

  // The last meal is the anchor when there is one. Falling back to the later of
  // the two would let a recently-created profile reset the clock, and taking the
  // max would do the same for any profile: the clock must start at the feed.
  const nowMs = now.getTime()
  const fedMs = usableTimestamp(anchors.lastFedAt, nowMs)
  const anchorMs = fedMs ?? usableTimestamp(anchors.startedAt, nowMs)
  if (anchorMs === null) return false
  return daysSince(nowMs, anchorMs) >= 7
}

/** The single need a care action targets, if any. */
export function needForAction(
  action: 'feed' | 'play' | 'clean' | 'heal' | 'sleep' | 'pet',
): 'hunger' | 'cleanliness' | 'health' | null {
  if (action === 'feed') return 'hunger'
  if (action === 'clean') return 'cleanliness'
  if (action === 'heal') return 'health'
  return null
}
