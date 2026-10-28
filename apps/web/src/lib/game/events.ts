/**
 * Provider-neutral activity events.
 *
 * Sources turn their native activity into this small contract before it enters
 * the game. The ledger stores derived event metadata only; it does not contain
 * note contents, repository contents, or provider-specific payloads.
 */

export type SourceKind = 'built-in-editor' | 'mounted-markdown' | 'github'

/** Local events are useful to the owner but are not independently verified. */
export type Provenance = 'local' | 'verified'

export type EventCategory =
  | 'qualifying-active-day'
  | 'work-session'
  | 'new-note'
  | 'new-words'
  | 'resolved-wikilink'
  | 'merged-pull-request'
  | 'published-release'
  | 'closed-linked-issue'
  | 'successful-ci'
  /**
   * A note moved between seedling / budding / evergreen.
   *
   * Recorded as HISTORY: a dated event carrying `from` and `to`, so the timeline exists and a
   * downgrade is visible instead of silently erasing its own XP. See the zero rate for this
   * category in `XP_BY_EVENT_CATEGORY`, which explains why it is zero on purpose.
   */
  | 'maturity-changed'

/**
 * A stable ID must come from the source's durable identity, not from a scan
 * timestamp. Branding prevents accidentally passing a display label as an ID.
 */
export type EventId = string & { readonly __eventIdBrand: unique symbol }

export type CompanionId = string & {
  readonly __companionIdBrand: unique symbol
}
export function asEventId(value: string): EventId {
  const normalized = value.trim()
  if (!normalized) throw new Error('An event ID must not be empty')
  return normalized as EventId
}

export function asCompanionId(value: string): CompanionId {
  const normalized = value.trim()
  if (!normalized) throw new Error('A companion ID must not be empty')
  return normalized as CompanionId
}

/**
 * Builds a deterministic ID for a source-native event. Encoding each part
 * keeps delimiters unambiguous while allowing IDs from different sources to
 * coexist in one ledger.
 */
export function makeEventId(
  source: SourceKind,
  sourceId: string,
  nativeEventId: string,
): EventId {
  const parts = [source, sourceId, nativeEventId].map((part) => {
    const normalized = part.trim()
    if (!normalized) throw new Error('Event ID parts must not be empty')
    return encodeURIComponent(normalized)
  })

  return asEventId(parts.join(':'))
}

/**
 * A cap is attached by the source normalizer. `key` identifies the capped
 * bucket, for example `github:repo-42:2026-08-28:work-session`; `limit` is a
 * count of accepted events, not an XP limit.
 */
export interface EventCap {
  readonly key: string
  readonly limit: number
}

export type EventMetadataValue = string | number | boolean

export interface NormalizedEvent {
  readonly eventId: EventId
  readonly companionId: CompanionId
  readonly source: SourceKind
  /** Stable identity of the mounted vault, editor workspace, repo, or account. */
  readonly sourceId: string
  readonly provenance: Provenance
  readonly category: EventCategory
  /** ISO timestamp supplied by the source, preferably the activity time. */
  readonly occurredAt: string
  readonly cap?: EventCap
  /** Small displayable evidence fields, never raw note or repository content. */
  readonly metadata?: Readonly<Record<string, EventMetadataValue>>
}

export interface EventLedger {
  readonly events: readonly NormalizedEvent[]
}

export const EMPTY_EVENT_LEDGER: EventLedger = Object.freeze({ events: [] })

/** Prototype XP rates from docs/PRODUCT.md. XP is derived, never trusted from input. */
export const XP_BY_EVENT_CATEGORY: Readonly<Record<EventCategory, number>> = {
  'qualifying-active-day': 10,
  'work-session': 10,
  'new-note': 25,
  'new-words': 5,
  'resolved-wikilink': 3,
  'merged-pull-request': 25,
  'published-release': 40,
  'closed-linked-issue': 10,
  'successful-ci': 10,
  /**
   * ZERO, DELIBERATELY -- not an unfinished value.
   *
   * A maturity change is recorded as HISTORY first: when a note moves between
   * seedling / budding / evergreen, the ledger gets a dated event carrying `from` and `to`. The
   * timeline begins to exist, and XP stays exactly what it is today.
   *
   * WHY ZERO AND NOT A RATE: promotion XP is currently a cumulative-credit reading of the
   * current snapshot (see `xp.ts`), which means a DOWNGRADE silently erases XP the user already
   * earned. Making this rate non-zero means replaying promotions from this log instead, and that
   * forces a migration decision -- grandfather every existing user's current claim once, or start
   * empty and erase it. That choice deserves real promotions in the log before it is made, so
   * until then this event is the audit trail, not the payer.
   */
  'maturity-changed': 0,
}

function assertCap(cap: EventCap): void {
  if (!cap.key.trim()) throw new Error('An event cap key must not be empty')
  if (!Number.isInteger(cap.limit) || cap.limit < 0) {
    throw new Error('An event cap limit must be a non-negative integer')
  }
}

function uniqueEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  const byId = new Map<EventId, NormalizedEvent>()

  for (const event of events) {
    if (event.cap) assertCap(event.cap)
    // First write wins. If a duplicate delivery has conflicting metadata, the
    // original source event remains the canonical record.
    if (!byId.has(event.eventId)) byId.set(event.eventId, event)
  }

  return [...byId.values()]
}

/** Add events without mutating the input ledger or counting an ID twice. */
export function addEvents(
  ledger: EventLedger,
  incoming: readonly NormalizedEvent[],
): EventLedger {
  return { events: uniqueEvents([...ledger.events, ...incoming]) }
}

/** Union multiple snapshots using the same first-write-wins ID rule. */
export function mergeEventLedgers(...ledgers: readonly EventLedger[]): EventLedger {
  return { events: uniqueEvents(ledgers.flatMap((ledger) => ledger.events)) }
}

function orderedForCap(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((left, right) => {
    const time = left.occurredAt.localeCompare(right.occurredAt)
    if (time !== 0) return time
    return left.eventId.localeCompare(right.eventId)
  })
}

/**
 * The most XP one calendar day may pay out, across EVERY source.
 *
 * WHY A GLOBAL BUDGET EXISTS AT ALL: `PRODUCT.md` section 5 promises
 * "cross-source diminishing returns or a global soft limit [that] prevents
 * additional mounted sources from multiplying XP without bound", and until now
 * nothing implemented it. Only the per-source caps existed, so each new source
 * added its own daily allowance and four sources meant four allowances.
 *
 * WHY 300, NOT 250: the note categories are capped, but `merged-pull-request`,
 * `published-release`, `closed-linked-issue` and `successful-ci` carry no cap of
 * their own, so the budget is the ONLY limit on a heavy GitHub day. At 250 a
 * plausible sprint close-out (eight merged pull requests, four green builds, plus
 * the activity ceiling) totals 270 and was clipped by 20: the ceiling punished
 * real work, the one thing it must never do. 300 clears every honest
 * single-source day measured: notes maxed 191, a heavy GitHub day 270, a typical
 * mixed day 119. It still binds where it matters, because both sources maxed
 * together reach 461 and are held to 300.
 *
 * Values are playtest values, same caveat as the XP rates above.
 */
export const GLOBAL_DAILY_XP_BUDGET = 300

/** Why an event earned nothing. */
export type LedgerRejectionReason = 'source-cap' | 'daily-budget'

export interface LedgerAcceptance {
  /** Events that survived every cap, in no particular order. */
  readonly accepted: readonly NormalizedEvent[]
  /** eventId -> why it earned nothing. Absent for accepted events. */
  readonly rejected: ReadonlyMap<string, LedgerRejectionReason>
}

/** The calendar day an event is charged to, in UTC. */
function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10)
}

/**
 * The day an event's budget is charged to.
 *
 * WHY THIS IS NOT JUST `occurredAt.slice(0,10)`: pass 1 keys the per-source caps
 * by the trusted scan day, but for local notes `occurredAt` is the file's
 * modification time, which the caps deliberately stopped trusting because it is
 * user-settable. Bucketing the budget by `occurredAt` therefore reopened the
 * exact hole the content caps closed: one scan's events all survive a single cap
 * bucket, then scatter across as many budget days as the user forged mtimes for,
 * so the day's sum is never bounded.
 *
 * The trusted day is already in the cap key (`...:<YYYY-MM-DD>:<category>`, for
 * both the note and GitHub producers), so it is read from there when a cap
 * exists. GitHub events without a cap carry a server-supplied `occurredAt`,
 * which is trustworthy, so they fall back to it.
 *
 * The day is the LAST date-shaped segment: the category names contain no date,
 * while a source id in the middle of a GitHub key theoretically could.
 */
const ISO_DAY = /\d{4}-\d{2}-\d{2}/g

function budgetDayOf(event: NormalizedEvent): string {
  if (event.cap) {
    const matches = event.cap.key.match(ISO_DAY)
    if (matches && matches.length > 0) return matches[matches.length - 1]
  }
  return dayOf(event.occurredAt)
}

/**
 * Resolves which events count, and why the rest do not.
 *
 * TWO PASSES, IN ORDER. Per-source caps first, then the global daily budget
 * over what survived. A second pass rather than widening `EventCap` to a list
 * because `cap` is part of the wire contract: it is serialized into the product
 * snapshot, its key is opaque, and the server receipt signs it. Widening it
 * would mean a schema change and a migration to express a budget that is really
 * a property of the ledger as a whole, not of any one event.
 *
 * The budget is evaluated per day across all sources, so its behaviour does not
 * depend on which source an event came from. This is pacing, not security: a
 * guest owns their local state and can edit it, so the local side was never
 * tamper-proof and is not claimed to be. The `verified` side is what the server
 * signs.
 */
export function explainLedgerAcceptance(ledger: EventLedger): LedgerAcceptance {
  const events = uniqueEvents(ledger.events)
  const rejected = new Map<string, LedgerRejectionReason>()
  const candidates: NormalizedEvent[] = []

  // Pass 1: the per-source caps, unchanged.
  const cappedGroups = new Map<string, NormalizedEvent[]>()
  for (const event of events) {
    if (!event.cap) {
      candidates.push(event)
      continue
    }
    const group = cappedGroups.get(event.cap.key) ?? []
    group.push(event)
    cappedGroups.set(event.cap.key, group)
  }

  for (const group of cappedGroups.values()) {
    const ordered = orderedForCap(group)
    // A conflicting limit is fail-closed. This avoids allowing a malformed
    // later event to silently enlarge an already established cap bucket.
    const limit = Math.min(...ordered.map((event) => event.cap!.limit))
    for (const event of ordered.slice(0, limit)) candidates.push(event)
    for (const event of ordered.slice(limit)) rejected.set(event.eventId, 'source-cap')
  }

  // Pass 2: one budget per day, across every source.
  const byDay = new Map<string, NormalizedEvent[]>()
  for (const event of candidates) {
    const day = budgetDayOf(event)
    const group = byDay.get(day) ?? []
    group.push(event)
    byDay.set(day, group)
  }

  const accepted: NormalizedEvent[] = []
  for (const group of byDay.values()) {
    let spent = 0
    for (const event of orderedForCap(group)) {
      const xp = XP_BY_EVENT_CATEGORY[event.category] ?? 0
      // An event that does not fit is skipped rather than ending the day, so a
      // later cheaper event still counts and the day keeps as much of its work
      // as the budget allows. The total never exceeds the budget either way.
      if (spent + xp > GLOBAL_DAILY_XP_BUDGET) {
        rejected.set(event.eventId, 'daily-budget')
        continue
      }
      spent += xp
      accepted.push(event)
    }
  }

  return { accepted, rejected }
}

/** Returns the canonical events that survive every cap. */
export function acceptedLedgerEvents(ledger: EventLedger): readonly NormalizedEvent[] {
  return explainLedgerAcceptance(ledger).accepted
}

/** XP a set of accepted events is worth, after every cap. */
export function totalXpOf(events: readonly NormalizedEvent[]): number {
  return events.reduce((sum, event) => sum + (XP_BY_EVENT_CATEGORY[event.category] ?? 0), 0)
}

/** Returns the XP actually awarded by one canonical event after caps. */
export function xpAwardedForEvent(
  ledger: EventLedger,
  eventId: EventId | string,
): number {
  const accepted = acceptedLedgerEvents(ledger).find((event) => event.eventId === eventId)
  return accepted ? XP_BY_EVENT_CATEGORY[accepted.category] : 0
}

/**
 * Sums accepted XP by companion. Cap buckets are evaluated once across the
 * whole ledger, so switching companions cannot bypass a per-source limit.
 * Local and verified events currently award the same XP; provenance remains
 * available to sync and public-profile policy layers.
 */
export function sumXpPerCompanion(
  ledger: EventLedger,
): Readonly<Record<CompanionId, number>> {
  const totals: Record<CompanionId, number> = {}
  for (const event of acceptedLedgerEvents(ledger)) {
    totals[event.companionId] =
      (totals[event.companionId] ?? 0) + XP_BY_EVENT_CATEGORY[event.category]
  }

  return totals
}
