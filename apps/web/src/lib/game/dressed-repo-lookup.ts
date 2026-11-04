/**
 * Server half of "show the dressed companion on the repo": the opt-in check,
 * the snapshot read and a short cache, around the pure `resolveDressedCompanion`.
 *
 * Used by `/api/creature` and `/api/creature.svg` for repo creatures only. The
 * handle-level garden creature never calls this.
 *
 * NEVER THROWS, NEVER BLOCKS THE BADGE. Any store failure answers "not dressed",
 * so the route falls back to the automatic species pick it always showed.
 *
 * PRIVACY ORDER. Nothing about the owner's collection is read until three things
 * hold: the repository is known to be PUBLIC (an unknown visibility counts as
 * private), its owner is an account with a numeric id, and that owner has opted in.
 *
 * WHY ITS OWN SHORT CACHE: the creature response itself is cached for an hour,
 * because it costs GitHub API calls. This lookup costs only local store reads,
 * so it is cached separately for one minute and laid over the cached body. A
 * user who dresses, undresses or opts out is reflected within a minute on this
 * server instead of an hour; the CDN window is shortened separately with
 * `DRESSED_S_MAXAGE_SECONDS`.
 */

import { cacheGetFresh, cacheSet } from './api-cache'
import type { RepoMeta } from './creature-route-shared'
import type { DressedCompanion } from './dressed-companion'

export interface DressedLookup {
  /** The owner opted in to dressed badges. Used only to pick the cache window. */
  readonly optedIn: boolean
  readonly dressed: DressedCompanion | null
}

const NONE: DressedLookup = { optedIn: false, dressed: null }

/** In-process TTL for one owner/repo lookup. */
export const DRESSED_LOOKUP_TTL_MS = 60 * 1000

/**
 * CDN window for repo creatures whose owner opted in. The default one hour stays
 * for everyone else; an opted-in owner gets five minutes so dressing, undressing
 * and opting out show up quickly. It depends on the opt-in, not on whether this
 * repo is dressed, so the header itself says nothing about dressing.
 */
export const DRESSED_S_MAXAGE_SECONDS = 300

export async function lookupDressedCompanion(meta: RepoMeta | null): Promise<DressedLookup> {
  if (!meta) return NONE
  if (meta.isPrivate !== false) return NONE
  const repositoryId = meta.id
  const ownerId = meta.ownerId
  if (!repositoryId || typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId)) return NONE

  const cacheKey = `dressed:${ownerId}:${repositoryId}`
  const cached = cacheGetFresh<DressedLookup>(cacheKey)
  if (cached) return cached

  try {
    // Loaded on first use, not at module scope: the creature routes serve
    // strangers and must stay quick to cold-start, and most requests never get
    // this far (private repo, no owner id, cache hit).
    const [{ getRepoBadgeStore }, { getProductStore }, { resolveDressedCompanion }, { PROTOTYPE_COMPANION_CATALOG }] =
      await Promise.all([
        import('../sync/repo-badge-store'),
        import('../sync/product-store'),
        import('./dressed-companion'),
        import('./companion-catalog'),
      ])
    const optIn = await getRepoBadgeStore().get(ownerId)
    if (!optIn) {
      cacheSet(cacheKey, NONE, DRESSED_LOOKUP_TTL_MS)
      return NONE
    }

    const snapshot = await getProductStore().get(ownerId)
    const dressed = snapshot
      ? resolveDressedCompanion(snapshot, repositoryId, PROTOTYPE_COMPANION_CATALOG)
      : null
    const result: DressedLookup = { optedIn: true, dressed }
    cacheSet(cacheKey, result, DRESSED_LOOKUP_TTL_MS)
    return result
  } catch {
    // A store outage is not cached: the next request tries again.
    return NONE
  }
}
