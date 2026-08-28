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
 * Sums accepted XP by companion. Cap buckets are evaluated once across the
 * whole ledger, so switching companions cannot bypass a per-source limit.
 * Local and verified events currently award the same XP; provenance remains
 * available to sync and public-profile policy layers.
 */
export function sumXpPerCompanion(
  ledger: EventLedger,
): Readonly<Record<CompanionId, number>> {
  const events = uniqueEvents(ledger.events)
  const cappedGroups = new Map<string, NormalizedEvent[]>()
  const uncapped: NormalizedEvent[] = []

  for (const event of events) {
    if (!event.cap) {
      uncapped.push(event)
      continue
    }

    const group = cappedGroups.get(event.cap.key) ?? []
    group.push(event)
    cappedGroups.set(event.cap.key, group)
  }

  const accepted = [...uncapped]
  for (const group of cappedGroups.values()) {
    const ordered = orderedForCap(group)
    // A conflicting limit is fail-closed. This avoids allowing a malformed
    // later event to silently enlarge an already established cap bucket.
    const limit = Math.min(...ordered.map((event) => event.cap!.limit))
    accepted.push(...ordered.slice(0, limit))
  }

  const totals: Record<CompanionId, number> = {}
  for (const event of accepted) {
    totals[event.companionId] =
      (totals[event.companionId] ?? 0) + XP_BY_EVENT_CATEGORY[event.category]
  }

  return totals
}
