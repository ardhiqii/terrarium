/**
 * Server-side trust boundary for stored product snapshots.
 *
 * Product snapshots may outlive a signing-key rotation or a client bug. A
 * stored GitHub event is allowed to contribute XP only while its receipt still
 * verifies for the account that owns the row. Invalid verified events and the
 * encounter rewards that cannot be tied to a trusted event are removed before
 * a snapshot is returned to a caller.
 *
 * This module is server-only because receipt verification uses the session
 * secret. Do not import it from a client component.
 */
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createGuestProfile } from '@/lib/game/guest-profile'
import {
  buildProductSnapshot,
  deserializeProductSnapshot,
  restoreProductStateFromSnapshot,
  validateProductSnapshot,
  type ProductSnapshot,
  type ProductSnapshotEvent,
  type ProductSnapshotCollectionReference,
  toOpaqueProductId,
} from './product-snapshot'
import { verifyVerifiedEventProof } from './verified-event-proof'

const EXPLICIT_FALLBACK_COMPANION_ID = 'pikachu-family'

function canonicalizeStoredEvent(event: ProductSnapshotEvent): ProductSnapshotEvent {
  return {
    ...event,
    eventId: toOpaqueProductId(event.eventId, 'event'),
    ...(event.cap ? { cap: { ...event.cap, key: toOpaqueProductId(event.cap.key, 'cap') } } : {}),
    ...(event.metadata
      ? {
          metadata: {
            ...event.metadata,
            ...(event.metadata.repositoryIdHash
              ? { repositoryIdHash: toOpaqueProductId(event.metadata.repositoryIdHash, 'repo') }
              : {}),
            ...(event.metadata.linkedPullRequestIdHash
              ? { linkedPullRequestIdHash: toOpaqueProductId(event.metadata.linkedPullRequestIdHash, 'pr') }
              : {}),
            ...(event.metadata.pullRequestIdHash
              ? { pullRequestIdHash: toOpaqueProductId(event.metadata.pullRequestIdHash, 'pr') }
              : {}),
          },
        }
      : {}),
  }
}

function referenceRank(reference: ProductSnapshotCollectionReference): number {
  return reference.acquisition === 'starter'
    ? 0
    : reference.acquisition === 'history'
      ? 1
      : 2
}

/**
 * Choose an owned fallback without depending on catalog order. Existing
 * profiles always have a starter reference; the explicit ID is only the final
 * recovery path for a corrupt/empty profile.
 */
function deterministicOwnedCompanionId(
  collection: readonly ProductSnapshotCollectionReference[],
  preferredId?: string,
): string {
  if (preferredId && collection.some((reference) => reference.companionId === preferredId)) {
    return preferredId
  }
  const reference = [...collection].sort((left, right) => (
    referenceRank(left) - referenceRank(right) ||
    left.acquiredAt.localeCompare(right.acquiredAt) ||
    left.referenceId.localeCompare(right.referenceId) ||
    left.companionId.localeCompare(right.companionId)
  ))[0]
  return reference?.companionId ?? EXPLICIT_FALLBACK_COMPANION_ID
}

function recomputeEncounterAggregates(
  encounters: ProductSnapshot['encounters'],
): ProductSnapshot['encounters'] {
  const essenceByFamily: Record<string, number> = {}
  for (const draw of encounters.draws) {
    if (draw.essenceAwarded <= 0) continue
    essenceByFamily[draw.selectedFamilyId] =
      (essenceByFamily[draw.selectedFamilyId] ?? 0) + draw.essenceAwarded
  }
  const nextSequence = Math.max(0, ...encounters.draws.map((draw) => draw.sequence + 1))
  return {
    ...encounters,
    nextSequence,
    essenceByFamily,
  }
}

function selectionFor(
  snapshot: ProductSnapshot,
  activeCompanionId: string,
  collection: readonly ProductSnapshotCollectionReference[],
) {
  if (snapshot.activeSelection.companionId === activeCompanionId) return { ...snapshot.activeSelection }
  const starter = collection
    .filter((reference) => reference.companionId === activeCompanionId && reference.acquisition === 'starter')
    .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.referenceId.localeCompare(right.referenceId))[0]
  return {
    companionId: activeCompanionId,
    provenance: starter ? 'starter' as const : 'user' as const,
    selectedAt: starter?.acquiredAt ?? snapshot.updatedAt,
  }
}

export function trustStoredProductSnapshot(
  inputSnapshot: ProductSnapshot,
  githubId: number,
): ProductSnapshot {
  // Rows written by an older server are upgraded here as well as in the store
  // so a deployment can read old JSON before it has been rewritten.
  const decoded = deserializeProductSnapshot(JSON.stringify(inputSnapshot))
  if (!decoded) throw new TypeError('Stored product snapshot is invalid')
  const snapshot: ProductSnapshot = {
    ...decoded,
    events: decoded.events.map(canonicalizeStoredEvent),
  }
  validateProductSnapshot(snapshot)

  let changed = false
  const validLegacyCredits = snapshot.legacyCredits.filter((credit) => (
    credit.migrationVersion === snapshot.migrationVersion &&
    credit.creditId === `migration:${credit.migrationVersion}:${credit.companionId}` &&
    /^legacy:[0-9a-f]{8}-[0-9a-f]{8}$/u.test(credit.sourceFingerprint)
  ))
  const validCreditReferences = new Set(validLegacyCredits.map((credit) => (
    toOpaqueProductId(credit.creditId, 'ref')
  )))
  const starterReference = [...snapshot.collection]
    .filter((reference) => reference.acquisition === 'starter')
    .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.referenceId.localeCompare(right.referenceId))[0]
  const safeCollection = snapshot.collection.filter((reference) => (
    Boolean(PROTOTYPE_COMPANION_CATALOG.get(reference.companionId)) &&
    (reference.acquisition !== 'history' || validCreditReferences.has(reference.referenceId)) &&
    (reference.acquisition !== 'starter' || reference.referenceId === starterReference?.referenceId)
  ))
  const initialOwnedCompanionIds = new Set(safeCollection.map((reference) => reference.companionId))
  const safeCompanions = snapshot.companions.filter((companion) => (
    Boolean(PROTOTYPE_COMPANION_CATALOG.get(companion.companionId)) &&
    initialOwnedCompanionIds.has(companion.companionId)
  ))
  const catalogCompanionIds = new Set(PROTOTYPE_COMPANION_CATALOG.list().map((definition) => definition.id))
  const knownSnapshotCompanionIds = [
    snapshot.activeCompanionId,
    snapshot.activeSelection.companionId,
    ...snapshot.companions.map((companion) => companion.companionId),
    ...snapshot.collection.map((reference) => reference.companionId),
    ...snapshot.legacyCredits.map((credit) => credit.companionId),
    ...snapshot.events.map((event) => event.companionId),
    ...snapshot.encounters.draws.flatMap((draw) => [
      draw.selectedCompanionId,
      ...draw.weights.map((weight) => weight.companionId),
    ]),
  ]
  if (
    knownSnapshotCompanionIds.some((id) => !PROTOTYPE_COMPANION_CATALOG.get(id)) ||
    !initialOwnedCompanionIds.has(snapshot.activeCompanionId) ||
    snapshot.activeSelection.companionId !== snapshot.activeCompanionId ||
    snapshot.encounters.draws.some((draw) => (
      !initialOwnedCompanionIds.has(draw.selectedCompanionId) ||
      (() => {
        const weightIds = new Set(draw.weights.map((weight) => weight.companionId))
        return draw.weights.some((weight) => !PROTOTYPE_COMPANION_CATALOG.get(weight.companionId)) ||
          weightIds.size !== draw.weights.length ||
          weightIds.size !== catalogCompanionIds.size ||
          [...catalogCompanionIds].some((id) => !weightIds.has(id))
      })()
    )) ||
    safeCollection.length !== snapshot.collection.length ||
    safeCompanions.length !== snapshot.companions.length ||
    validLegacyCredits.length !== snapshot.legacyCredits.length
  ) changed = true

  const events = snapshot.events.flatMap((event): ProductSnapshotEvent[] => {
    if (!PROTOTYPE_COMPANION_CATALOG.get(event.companionId) || !initialOwnedCompanionIds.has(event.companionId)) {
      changed = true
      return []
    }
    const trustedGithub = event.source === 'github' &&
      event.provenance === 'verified' &&
      Boolean(event.verifiedProof) &&
      verifyVerifiedEventProof(event, githubId, event.verifiedProof as string)
    if (trustedGithub) return [event]
    // GitHub is never a local source. Any unverified or invalid event must be
    // removed instead of downgraded, otherwise its already-derived XP survives
    // the receipt boundary through the companion totals.
    if (event.source === 'github') {
      changed = true
      return []
    }
    if (event.provenance !== 'verified') return [event]
    changed = true
    // Verified provenance is meaningful only for server-issued GitHub
    // receipts. Remove malformed legacy records from every other source too.
    return []
  })

  // Encounter draws do not carry a source-event foreign key in the compact
  // product contract. Once an untrusted event is removed, the safe choice is
  // to invalidate encounter-derived rewards rather than let an old draw,
  // essence balance, or collectible survive the receipt boundary.
  const retainedEventCompanionIds = new Set(events.map((event) => event.companionId))
  const recoverableCollection = safeCollection.filter((reference) => (
    reference.acquisition !== 'encounter' || retainedEventCompanionIds.has(reference.companionId)
  ))
  const ownedCompanionIds = new Set(recoverableCollection.map((reference) => reference.companionId))
  const legacyCredits = validLegacyCredits.filter((credit) => {
    const keep = Boolean(PROTOTYPE_COMPANION_CATALOG.get(credit.companionId)) && ownedCompanionIds.has(credit.companionId)
    if (!keep) changed = true
    return keep
  })
  const activeCompanionId = deterministicOwnedCompanionId(
    recoverableCollection,
    PROTOTYPE_COMPANION_CATALOG.get(snapshot.activeCompanionId) &&
      ownedCompanionIds.has(snapshot.activeCompanionId)
      ? snapshot.activeCompanionId
      : undefined,
  )
  if (activeCompanionId !== snapshot.activeCompanionId) changed = true
  const activeSelection = selectionFor(snapshot, activeCompanionId, recoverableCollection)
  if (
    activeSelection.companionId !== snapshot.activeSelection.companionId ||
    activeSelection.provenance !== snapshot.activeSelection.provenance ||
    activeSelection.selectedAt !== snapshot.activeSelection.selectedAt
  ) changed = true

  const sanitized: ProductSnapshot = changed
    ? {
        ...snapshot,
        activeCompanionId,
        activeSelection,
        legacyCredits,
        events,
        collection: recoverableCollection.length > 0
          ? recoverableCollection
          : [{
              referenceId: `${snapshot.guestId}:starter`,
              companionId: EXPLICIT_FALLBACK_COMPANION_ID,
              acquiredAt: snapshot.createdAt,
              acquisition: 'starter' as const,
            }],
        companions: safeCompanions.filter((companion) => ownedCompanionIds.has(companion.companionId)),
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
    : snapshot
  const fallbackCompanionId = deterministicOwnedCompanionId(sanitized.collection, sanitized.activeCompanionId)
  const fallbackProfile = createGuestProfile({
    guestId: sanitized.guestId,
    starterCompanionId: fallbackCompanionId,
    now: sanitized.createdAt,
  })
  // Recompute reward aggregates on every trust boundary. A structurally valid
  // stored row can still contain a forged Essence map, and taking that cache
  // at face value would make it survive a GET without any matching draws.
  const trustedEncounters = recomputeEncounterAggregates(sanitized.encounters)
  const restored = restoreProductStateFromSnapshot(
    { ...sanitized, encounters: trustedEncounters },
    fallbackProfile,
    PROTOTYPE_COMPANION_CATALOG,
  )
  const proofs = Object.fromEntries(
    sanitized.events.flatMap((event) => event.verifiedProof
      ? [[event.eventId, event.verifiedProof] as const]
      : []),
  )
  const rebuilt = buildProductSnapshot(restored, sanitized.generatedAt, proofs)
  const canonical: ProductSnapshot = {
    ...rebuilt,
    guestId: sanitized.guestId,
    createdAt: sanitized.createdAt,
    updatedAt: sanitized.updatedAt,
    generatedAt: sanitized.generatedAt,
    activeCompanionId: restored.activeCompanion?.companionId ?? fallbackCompanionId,
    activeSelection: { ...restored.profile.activeSelection! },
    catalogVersion: sanitized.catalogVersion,
    ...(sanitized.migrationVersion ? { migrationVersion: sanitized.migrationVersion } : {}),
    legacyCredits: restored.legacyCredits.map((credit) => ({ ...credit })),
    sourceBaselines: sanitized.sourceBaselines,
    recoverabilityWarning: sanitized.recoverabilityWarning,
  }
  validateProductSnapshot(canonical)
  return canonical
}
