import type { ProductSnapshot } from '../sync/product-snapshot'

/**
 * Capability check used before a repair takes the panel's busy/abort lock.
 * Legacy events may be repaired without a checkpoint only when every target
 * carries its preserved server receipt.
 */
export function canStartReceiptRepair(
  checkpoint: string | null,
  targetEventIds: readonly string[],
  preservedProofIds: ReadonlySet<string>,
): boolean {
  return checkpoint !== null || targetEventIds.every((eventId) => preservedProofIds.has(eventId))
}

/**
 * Project a receipt-repair snapshot for a best-effort partial upload.
 *
 * The complete snapshot is retained in browser recovery storage by the caller.
 * This projection only carries events that were not blocked and ownership that
 * is not an encounter reward. Encounter references, draws, meter, and family
 * essence are deliberately reset because the compact product contract does not
 * link a draw back to the source event that caused it. Keeping those fields
 * would let a blocked receipt smuggle its derived reward into the cloud.
 *
 * `history` references are profile metadata, not encounter rewards, so they
 * remain available to keep valid events owned by a previously acquired
 * companion uploadable. Encounter-only companions are omitted along with
 * their events; their complete records remain in the recovery snapshot.
 */
export function projectPartialProductSnapshot(
  snapshot: ProductSnapshot,
  blockedEventIds: ReadonlySet<string>,
): ProductSnapshot {
  const presentBlockedEventIds = new Set(
    snapshot.events
      .map((event) => event.eventId)
      .filter((eventId) => blockedEventIds.has(eventId)),
  )
  if (presentBlockedEventIds.size === 0) return snapshot

  const collection = snapshot.collection.filter((reference) => reference.acquisition !== 'encounter')
  const ownedCompanionIds = new Set(collection.map((reference) => reference.companionId))
  const events = snapshot.events.filter((event) => (
    !presentBlockedEventIds.has(event.eventId) && ownedCompanionIds.has(event.companionId)
  ))
  const collectionCountByCompanion = new Map<string, number>()
  for (const reference of collection) {
    collectionCountByCompanion.set(
      reference.companionId,
      (collectionCountByCompanion.get(reference.companionId) ?? 0) + 1,
    )
  }
  // Companion totals/progression are derived fields. Zero them in the partial
  // request so a client or future server cannot accept blocked-derived XP or
  // essence merely because the event ledger was projected.
  const companions = snapshot.companions
    .filter((companion) => ownedCompanionIds.has(companion.companionId))
    .map((companion) => ({
      ...companion,
      xp: 0,
      essence: 0,
      encounterCount: collectionCountByCompanion.get(companion.companionId) ?? 0,
      progression: null,
    }))
  const starter = collection.find((reference) => reference.acquisition === 'starter') ?? collection[0]
  const activeCompanionId = ownedCompanionIds.has(snapshot.activeCompanionId)
    ? snapshot.activeCompanionId
    : starter?.companionId ?? snapshot.activeCompanionId

  return {
    ...snapshot,
    activeCompanionId,
    companions,
    collection,
    events,
    encounters: {
      ...snapshot.encounters,
      meter: 0,
      totalProgress: 0,
      nextSequence: 0,
      draws: [],
      processedTriggerIds: [],
      essenceByFamily: {},
    },
  }
}
