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

export type ReceiptRecoveryMode = 'blocked' | 'repair' | 'catch-up' | 'retry'

export interface ReceiptRecoveryPresentation {
  readonly mode: ReceiptRecoveryMode
  readonly heading: string
  readonly detail: string
  readonly actionLabel: string
  /** `catch-up` continues with the normal sync action; every other mode retries the repair upload. */
  readonly action: 'sync' | 'repair'
  readonly checkpointHint: string
}

/**
 * The durable recovery record covers several distinct conditions, and the
 * panel previously rendered all of them as "receipt repair". A bounded
 * catch-up in progress has no blocked receipts at all, and the lone repair
 * button was inert for it (it only reported "no receipt failures to repair"
 * in the summary far below), so the state read as a dead end. Name the actual
 * condition so the copy and the action match it.
 */
export function receiptRecoveryPresentation(record: {
  readonly failures: readonly unknown[]
  readonly blockedEventIds: readonly string[]
  readonly continuation?: string | null
  readonly checkpoint?: string | null
}): ReceiptRecoveryPresentation {
  const preservedHint = 'The held backup is committed only after the repaired activity is stored.'
  const freshHint = 'A fresh sync may be needed to create a new backup.'

  // Order matters: the blocked overlay is the most explicit condition, and a
  // pending receipt failure keeps the repair action even while a catch-up
  // cursor is preserved (that failed-repair record keeps both).
  if (record.blockedEventIds.length > 0) {
    const count = record.blockedEventIds.length
    return {
      mode: 'blocked',
      heading: 'Some verified activity is blocked',
      detail: `${count} event${count === 1 ? '' : 's'} remain visible in this browser but could not be confirmed in the bounded GitHub repair window. Valid progress can still be backed up; earlier backups stay unchanged.`,
      actionLabel: 'Repair activity proof and retry',
      action: 'repair',
      checkpointHint: record.checkpoint ? preservedHint : freshHint,
    }
  }
  if (record.failures.length > 0) {
    const count = record.failures.length
    return {
      mode: 'repair',
      heading: 'Activity proof repair is ready',
      detail: `${count} activity proof${count === 1 ? '' : 's'} could not be verified and blocked the account backup. Your browser ledger and encounters are intact.`,
      actionLabel: 'Repair activity proof and retry',
      action: 'repair',
      checkpointHint: record.checkpoint ? preservedHint : freshHint,
    }
  }
  if (record.continuation) {
    return {
      mode: 'catch-up',
      heading: 'GitHub catch-up in progress',
      detail: 'The GitHub activity window is being read in parts across syncs; nothing is blocked. Your browser ledger and encounters are intact. Continue the sync to finish the read — the backup is committed only when the catch-up completes.',
      actionLabel: 'Continue sync',
      action: 'sync',
      checkpointHint: 'Sync again to continue this window; the backup follows when it completes.',
    }
  }
  return {
    mode: 'retry',
    heading: 'Account backup retry is ready',
    detail: 'The last account backup was not committed. Your browser ledger and encounters are intact; retrying re-uploads the preserved snapshot.',
    actionLabel: 'Retry account backup',
    action: 'repair',
    checkpointHint: record.checkpoint ? preservedHint : freshHint,
  }
}
