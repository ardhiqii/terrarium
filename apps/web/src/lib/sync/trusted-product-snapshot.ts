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
  restoreProductStateFromSnapshot,
  validateProductSnapshot,
  type ProductSnapshot,
  type ProductSnapshotEvent,
} from './product-snapshot'
import { verifyVerifiedEventProof } from './verified-event-proof'

export function trustStoredProductSnapshot(
  snapshot: ProductSnapshot,
  githubId: number,
): ProductSnapshot {
  let changed = false
  const catalogFallback = PROTOTYPE_COMPANION_CATALOG.list()[0]?.id ?? 'pikachu-family'
  const safeCollection = snapshot.collection.filter((reference) => (
    Boolean(PROTOTYPE_COMPANION_CATALOG.get(reference.companionId))
  ))
  const ownedCompanionIds = new Set(safeCollection.map((reference) => reference.companionId))
  const knownSnapshotCompanionIds = [
    snapshot.activeCompanionId,
    ...snapshot.companions.map((companion) => companion.companionId),
    ...snapshot.collection.map((reference) => reference.companionId),
    ...snapshot.events.map((event) => event.companionId),
    ...snapshot.encounters.draws.flatMap((draw) => [
      draw.selectedCompanionId,
      ...draw.weights.map((weight) => weight.companionId),
    ]),
  ]
  if (
    knownSnapshotCompanionIds.some((id) => !PROTOTYPE_COMPANION_CATALOG.get(id)) ||
    !ownedCompanionIds.has(snapshot.activeCompanionId) ||
    snapshot.encounters.draws.some((draw) => !ownedCompanionIds.has(draw.selectedCompanionId)) ||
    safeCollection.length !== snapshot.collection.length
  ) changed = true
  const events = snapshot.events.flatMap((event): ProductSnapshotEvent[] => {
    if (!PROTOTYPE_COMPANION_CATALOG.get(event.companionId) || !ownedCompanionIds.has(event.companionId)) {
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
  const sanitized: ProductSnapshot = changed
    ? {
        ...snapshot,
        events,
        collection: recoverableCollection.length > 0
          ? recoverableCollection
          : [{
              referenceId: `${snapshot.guestId}:starter`,
              companionId: catalogFallback,
              acquiredAt: snapshot.createdAt,
              acquisition: 'starter' as const,
            }],
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
    : snapshot
  const fallbackProfile = createGuestProfile({
    guestId: snapshot.guestId,
    starterCompanionId: sanitized.collection[0]?.companionId ?? catalogFallback,
    now: snapshot.createdAt,
  })
  const restored = restoreProductStateFromSnapshot(
    sanitized,
    fallbackProfile,
    PROTOTYPE_COMPANION_CATALOG,
  )
  const proofs = Object.fromEntries(
    sanitized.events.flatMap((event) => event.verifiedProof
      ? [[event.eventId, event.verifiedProof] as const]
      : []),
  )
  const rebuilt = buildProductSnapshot(restored, snapshot.generatedAt, proofs)
  const activeCompanionId = restored.activeCompanion?.companionId ??
    sanitized.collection[0]?.companionId ??
    catalogFallback
  const canonical: ProductSnapshot = {
    ...rebuilt,
    guestId: snapshot.guestId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    generatedAt: snapshot.generatedAt,
    activeCompanionId,
    sourceBaselines: snapshot.sourceBaselines,
    recoverabilityWarning: snapshot.recoverabilityWarning,
  }
  validateProductSnapshot(canonical)
  return canonical
}
