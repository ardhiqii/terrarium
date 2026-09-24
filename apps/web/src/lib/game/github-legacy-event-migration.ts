/**
 * Safe projection of the old unnamespaced GitHub browser ledger.
 *
 * The old key is a shared guest archive, so it is not safe to move its whole
 * profile into an account namespace. A server-issued proof plus a stable
 * product event ID are the only records this helper is willing to carry over.
 * The generic profile and guest identity are not adopted wholesale; collection
 * ownership is supplied separately so the caller can reuse only references it
 * can independently show already exist.
 */

import {
  addEvents,
  type EventLedger,
  type NormalizedEvent,
} from './events'
import { canonicalizeProductEvent, productEventId } from '../sync/product-event-id'
import { productSnapshotEvent } from '../sync/product-snapshot'

export interface LegacyGithubEventMigrationInput {
  readonly genericLedger: EventLedger
  readonly accountLedger: EventLedger
  readonly genericProofs: Readonly<Record<string, string>>
  readonly accountProofs: Readonly<Record<string, string>>
  /**
   * Collection-backed ownership is the only safe bridge between the two
   * namespaces. An event's companionId is evidence of attribution, not proof
   * that the companion belongs to either profile.
   */
  readonly genericOwnedCompanionIds?: readonly string[]
  readonly accountOwnedCompanionIds?: readonly string[]
  /** Optional IDs are diagnostic only; neither profile is ever rewritten. */
  readonly genericGuestId?: string | null
  readonly accountGuestId?: string | null
}

export interface LegacyGithubEventMigrationResult {
  /** Account events first; generic-only stable events are appended. */
  readonly ledger: EventLedger
  /** Account receipts win; a compatible generic receipt fills a missing one. */
  readonly proofs: Readonly<Record<string, string>>
  /** IDs present in the generic ledger and safe to retry/remove after upload. */
  readonly migratedEventIds: readonly string[]
  /** Generic records whose receipt and ownership checks passed. */
  readonly migratedGenericEvents: readonly NormalizedEvent[]
  /** Generic-only events that must be applied to account progression, not just
   * appended to the ledger. */
  readonly genericOnlyEvents: readonly NormalizedEvent[]
  readonly overlapCount: number
  readonly genericOnlyCount: number
  readonly accountOnlyCount: number
  readonly skippedGenericEventCount: number
  readonly guestIdentityMismatch: boolean
}

export interface RetainedLegacyGithubData {
  readonly ledger: EventLedger
  readonly proofs: Readonly<Record<string, string>>
}

function validProof(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function proofFor(
  proofs: Readonly<Record<string, string>>,
  event: NormalizedEvent,
): string | null {
  const canonicalId = productEventId(event.eventId)
  const proof = proofs[canonicalId] ?? proofs[event.eventId]
  return validProof(proof) ? proof : null
}

/**
 * A stable event is provider-derived, verified, and paired with a bounded
 * receipt. The receipt is intentionally not cryptographically checked here;
 * the product API remains the authority for that operation.
 */
export function isStableVerifiedGithubEvent(
  event: NormalizedEvent,
  proofs: Readonly<Record<string, string>>,
): boolean {
  try {
    const canonical = canonicalizeProductEvent(event)
    return canonical.source === 'github' &&
      canonical.provenance === 'verified' &&
      proofFor(proofs, canonical) !== null
  } catch {
    return false
  }
}

function canonicalEvent(event: NormalizedEvent): NormalizedEvent | null {
  try {
    return canonicalizeProductEvent(event)
  } catch {
    return null
  }
}

/**
 * Compare the fields that a receipt can bind after both records have gone
 * through the product snapshot normalizer. That matters for a legacy record:
 * `repositoryId` becomes `repositoryIdHash` in the account snapshot, and cap
 * keys are opaque there. `provenance` is deliberately omitted because a
 * receipt is precisely what upgrades a legacy local GitHub record to verified;
 * `sourceId` is not signed and is omitted by the product payload too.
 */
function compatibleReceiptEvent(
  generic: NormalizedEvent,
  account: NormalizedEvent,
): boolean {
  const left = canonicalEvent(generic)
  const right = canonicalEvent(account)
  if (!left || !right) return false
  const leftSnapshot = productSnapshotEvent(left)
  const rightSnapshot = productSnapshotEvent(right)
  return leftSnapshot.eventId === rightSnapshot.eventId &&
    leftSnapshot.source === 'github' &&
    rightSnapshot.source === 'github' &&
    leftSnapshot.companionId === rightSnapshot.companionId &&
    leftSnapshot.category === rightSnapshot.category &&
    leftSnapshot.occurredAt === rightSnapshot.occurredAt &&
    JSON.stringify(leftSnapshot.cap ?? null) === JSON.stringify(rightSnapshot.cap ?? null) &&
    JSON.stringify(leftSnapshot.metadata ?? null) === JSON.stringify(rightSnapshot.metadata ?? null)
}

function uniqueCanonicalEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  const byId = new Map<string, NormalizedEvent>()
  for (const event of events) {
    const canonical = canonicalEvent(event)
    if (!canonical) continue
    const id = productEventId(canonical.eventId)
    if (!byId.has(id)) byId.set(id, canonical)
  }
  return [...byId.values()]
}

function ownedCompanionIds(ids: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(ids ?? [])
}

/**
 * Merge only stable, receipt-backed GitHub events from the generic key.
 * Account events are authoritative on an overlap unless the account only has
 * an unverified/local copy; in that case the compatible receipt-backed generic
 * copy upgrades the record without adopting the generic profile or guest ID.
 *
 * A receipt does not establish collection ownership. Generic events therefore
 * enter the candidate set only when their companion is already in the account
 * collection or is backed by a collection reference in the generic profile.
 * Omitting the ownership sets is fail-closed: no generic event is migrated.
 */
export function mergeLegacyGithubEvents(
  input: LegacyGithubEventMigrationInput,
): LegacyGithubEventMigrationResult {
  const accountEvents = uniqueCanonicalEvents(input.accountLedger.events)
  const accountById = new Map<string, NormalizedEvent>(accountEvents.map((event) => [String(productEventId(event.eventId)), event]))
  const accountOwned = ownedCompanionIds(input.accountOwnedCompanionIds)
  const genericOwned = ownedCompanionIds(input.genericOwnedCompanionIds)
  const genericCandidates: NormalizedEvent[] = []
  const genericIds = new Set<string>()
  let skippedGenericEventCount = 0

  const genericSeen = new Set<string>()
  for (const rawEvent of input.genericLedger.events) {
    const event = canonicalEvent(rawEvent)
    if (!event) {
      skippedGenericEventCount += 1
      continue
    }
    const id = String(productEventId(event.eventId))
    if (genericSeen.has(id)) continue
    if (!isStableVerifiedGithubEvent(event, input.genericProofs)) {
      // A stale local duplicate may precede the verified delivery. Do not let
      // it hide the later stable record.
      skippedGenericEventCount += 1
      continue
    }
    if (!accountOwned.has(event.companionId) && !genericOwned.has(event.companionId)) {
      // A verified event names the companion that received progression; it does
      // not prove that the old profile actually owned that companion. Keep the
      // bytes and proof in the generic archive for explicit resolution.
      skippedGenericEventCount += 1
      continue
    }
    genericCandidates.push(event)
    genericIds.add(id)
    genericSeen.add(id)
  }

  const genericOnly = genericCandidates.filter((event) => !accountById.has(productEventId(event.eventId)))
  const overlap = genericCandidates.filter((event) => accountById.has(productEventId(event.eventId)))
  const accountOnlyCount = accountEvents.filter((event) => !genericIds.has(productEventId(event.eventId))).length
  const genericById = new Map(genericCandidates.map((event) => [String(productEventId(event.eventId)), event]))
  const mergedAccountEvents = accountEvents.map((account) => {
    const eventId = String(productEventId(account.eventId))
    const generic = genericById.get(eventId)
    // A receipt-backed generic copy is allowed to upgrade only an unverified
    // account record and only when every receipt-bound field agrees. A
    // verified account record remains authoritative even if the old proof is
    // the one that is available locally.
    return generic && account.provenance !== 'verified' && compatibleReceiptEvent(generic, account)
      ? generic
      : account
  })
  const ledger = addEvents({ events: [] }, [...mergedAccountEvents, ...genericOnly])
  const mergedEventsById = new Map<string, NormalizedEvent>(ledger.events.map((event) => [String(productEventId(event.eventId)), event]))

  const proofs: Record<string, string> = {}
  for (const [eventId, proof] of Object.entries(input.accountProofs)) {
    const event = mergedEventsById.get(eventId)
    if (event && event.source === 'github' && event.provenance === 'verified' && validProof(proof)) {
      proofs[eventId] = proof
    }
  }

  const acceptedGenericIds = new Set<string>()
  for (const generic of genericCandidates) {
    const eventId = String(productEventId(generic.eventId))
    const account = accountById.get(eventId)
    // Generic-only events are copied with their proof. An overlapping receipt
    // is accepted only when the account record has the same receipt-bound
    // shape; an incompatible overlap remains in the generic archive and must
    // never be deleted merely because the account already has a proof under
    // that ID.
    if (account && !compatibleReceiptEvent(generic, account)) continue
    const proof = proofFor(input.genericProofs, generic)
    const merged = mergedEventsById.get(eventId)
    if (proof && merged?.source === 'github' && merged.provenance === 'verified') {
      if (!proofs[eventId]) proofs[eventId] = proof
      acceptedGenericIds.add(eventId)
    }
  }

  const migratedGenericEvents = genericCandidates.filter((event) => {
    const eventId = String(productEventId(event.eventId))
    return acceptedGenericIds.has(eventId) && Boolean(proofs[eventId])
  })
  const migratedEventIds = migratedGenericEvents.map((event) => String(productEventId(event.eventId)))

  return {
    ledger,
    proofs,
    migratedEventIds,
    migratedGenericEvents,
    genericOnlyEvents: genericOnly,
    overlapCount: overlap.length,
    genericOnlyCount: genericOnly.length,
    accountOnlyCount,
    skippedGenericEventCount,
    guestIdentityMismatch: input.genericGuestId !== undefined &&
      input.accountGuestId !== undefined &&
      input.genericGuestId !== null &&
      input.accountGuestId !== null &&
      input.genericGuestId !== input.accountGuestId,
  }
}

/**
 * Remove only the event/proof IDs that were already accepted by cloud. This is
 * intentionally a separate pure projection so a failed upload can leave the
 * original generic bytes untouched and a retry can repeat the union.
 */
export function retainUnmigratedLegacyGithubData(
  ledger: EventLedger,
  proofs: Readonly<Record<string, string>>,
  migratedEventIds: readonly string[],
): RetainedLegacyGithubData {
  const migrated = new Set(migratedEventIds)
  const removedIds = new Set<string>()
  const remainingEvents = ledger.events.filter((event) => {
    const canonical = canonicalEvent(event)
    const eventId = canonical ? String(productEventId(canonical.eventId)) : null
    const remove = canonical !== null &&
      eventId !== null &&
      migrated.has(eventId) &&
      isStableVerifiedGithubEvent(canonical, proofs)
    if (remove && eventId !== null) removedIds.add(eventId)
    return !remove
  })
  const remainingProofs = Object.fromEntries(
    Object.entries(proofs).filter(([eventId]) => !removedIds.has(eventId)),
  )
  return {
    ledger: { events: remainingEvents },
    proofs: remainingProofs,
  }
}
