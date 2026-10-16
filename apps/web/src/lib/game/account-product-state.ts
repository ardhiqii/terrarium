import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { migrateLegacyCreature } from './companion-migration'
import { createGuestProfile } from './guest-profile'
import type { CreatureState } from './types'
import { readGithubCache } from './github'
import type { ProductState } from './product-state'
import {
  buildProductSnapshot,
  restoreProductStateFromSnapshot,
} from '@/lib/sync/product-snapshot'
import { getProductStore } from '@/lib/sync/product-store'
import { trustStoredProductSnapshot } from '@/lib/sync/trusted-product-snapshot'
import { getSessionProvider } from '@/lib/sync/session'

/**
 * The legacy cache is site-owner data, so its migration gate must use
 * GitHub's immutable numeric identity rather than the mutable login handle.
 * Invalid or missing configuration fails closed and simply leaves the legacy
 * cache unmigrated.
 */
function configuredOwnerGithubId(): number | null {
  const raw = process.env.GITHUB_OWNER_ID?.trim()
  if (!raw || !/^[1-9][0-9]*$/u.test(raw)) return null
  const githubId = Number(raw)
  return Number.isSafeInteger(githubId) && githubId > 0 ? githubId : null
}

export type AccountProductResult =
  | { status: 'signed-out'; state: null }
  | { status: 'missing' | 'unavailable'; state: null; githubId: number }
  | { status: 'available'; state: ProductState; githubId: number }

/**
 * Loads the account-owned product projection. The global legacy garden is
 * eligible for migration only for the configured site owner; other accounts
 * never inherit the site's content-derived history.
 */
export async function loadAccountProductState(
  legacyState: CreatureState,
): Promise<AccountProductResult> {
  const session = await getSessionProvider().current()
  if (!session) return { status: 'signed-out', state: null }

  try {
    const record = await getProductStore().getRecord(session.githubId, session.handle)
    if (!record) return { status: 'missing', state: null, githubId: session.githubId }
    const snapshot = trustStoredProductSnapshot(record.snapshot, session.githubId)
    const fallbackProfile = createGuestProfile({
      guestId: snapshot.guestId,
      starterCompanionId: snapshot.activeCompanionId,
      now: snapshot.createdAt,
    })
    let state = restoreProductStateFromSnapshot(
      snapshot,
      fallbackProfile,
      PROTOTYPE_COMPANION_CATALOG,
    )

    const ownerGithubId = configuredOwnerGithubId()
    if (ownerGithubId !== null && session.githubId === ownerGithubId) {
      // The legacy GitHub cache is site-owner data. Read it only after the
      // authenticated account has been matched by immutable GitHub ID, never
      // while constructing a public or guest projection. A handle rename does
      // not invalidate the match, and a reused handle cannot inherit it.
      const ownerLegacyGithub = readGithubCache()
      const migration = migrateLegacyCreature(
        state,
        {
          legacyStats: legacyState.stats,
          legacyGithub: ownerLegacyGithub,
          legacyLine: 'grass',
        },
        PROTOTYPE_COMPANION_CATALOG,
        { now: new Date().toISOString() },
      )
      if (migration.changed) {
        const proofs = Object.fromEntries(snapshot.events.flatMap((event) => event.verifiedProof
          ? [[event.eventId, event.verifiedProof] as const]
          : []))
        const migratedSnapshot = buildProductSnapshot(migration.state, new Date().toISOString(), proofs)
        const saved = await getProductStore().put(
          session.githubId,
          session.handle,
          migratedSnapshot,
          migratedSnapshot.updatedAt,
          record.updatedAt,
        )
        if (saved) {
          state = migration.state
        } else {
          // Another device won the optimistic write. Return the winner rather
          // than presenting an unsaved migration as the account authority.
          const current = await getProductStore().getRecord(session.githubId, session.handle)
          if (!current) return { status: 'unavailable', state: null, githubId: session.githubId }
          const currentSnapshot = trustStoredProductSnapshot(current.snapshot, session.githubId)
          state = restoreProductStateFromSnapshot(
            currentSnapshot,
            createGuestProfile({
              guestId: currentSnapshot.guestId,
              starterCompanionId: currentSnapshot.activeCompanionId,
              now: currentSnapshot.createdAt,
            }),
            PROTOTYPE_COMPANION_CATALOG,
          )
        }
      }
    }

    return { status: 'available', state, githubId: session.githubId }
  } catch {
    return { status: 'unavailable', state: null, githubId: session.githubId }
  }
}
