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

  const retainedCollection = snapshot.collection.filter((reference) => reference.acquisition !== 'encounter')
  // A normal profile always has a starter reference. If a partial recovery is
  // handed only encounter references, keep the projection structurally valid
  // with the same explicit legacy fallback used by the trusted server boundary.
  const collection = retainedCollection.length > 0
    ? retainedCollection
    : [{
        referenceId: 'ref-00000000-00000001',
        companionId: 'pikachu-family',
        acquiredAt: snapshot.createdAt,
        acquisition: 'starter' as const,
      }]
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
  const projectedCompanions = snapshot.companions
    .filter((companion) => ownedCompanionIds.has(companion.companionId))
    .map((companion) => ({
      ...companion,
      xp: 0,
      essence: 0,
      encounterCount: collectionCountByCompanion.get(companion.companionId) ?? 0,
      progression: null,
    }))
  const companions = projectedCompanions.length > 0
    ? projectedCompanions
    : [{
        companionId: 'pikachu-family',
        familyId: 'pikachu-family',
        xp: 0,
        essence: 0,
        encounterCount: 1,
        progression: null,
      }]
  const fallbackReference = [...collection].sort((left, right) => (
    (left.acquisition === 'starter' ? 0 : left.acquisition === 'history' ? 1 : 2) -
    (right.acquisition === 'starter' ? 0 : right.acquisition === 'history' ? 1 : 2) ||
    left.acquiredAt.localeCompare(right.acquiredAt) ||
    left.referenceId.localeCompare(right.referenceId) ||
    left.companionId.localeCompare(right.companionId)
  ))[0]
  const activeCompanionId = ownedCompanionIds.has(snapshot.activeCompanionId)
    ? snapshot.activeCompanionId
    : fallbackReference?.companionId ?? 'pikachu-family'
  const activeSelection = snapshot.activeSelection.companionId === activeCompanionId
    ? snapshot.activeSelection
    : {
        companionId: activeCompanionId,
        provenance: fallbackReference?.acquisition === 'starter' ? 'starter' as const : 'user' as const,
        selectedAt: fallbackReference?.acquiredAt ?? snapshot.updatedAt,
      }

  return {
    ...snapshot,
    activeCompanionId,
    activeSelection,
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
      progressByTriggerId: {},
    },
  }
}
