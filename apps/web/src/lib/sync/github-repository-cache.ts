/**
 * Server-side TTL cache for the GitHub repository listing.
 *
 * `/github` used to issue up to four listings per visit (page open, save,
 * sync, post-sync reload), and each listing costs up to five paged GitHub
 * requests. That is how a single visit burned the account's hourly budget and
 * produced a rate-limit wall with zero repositories shown.
 *
 * This cache is the other half of the fix: within the fresh window a listing
 * is served from process memory with no provider call at all, and after the
 * window a failed provider read degrades to the last known listing (marked
 * stale) instead of an error page.
 *
 * Caveats inherited from `api-cache.ts` and stated rather than assumed: this
 * is a module-scope `Map`, so it lives as long as one warm server instance,
 * is wiped on restart, and is per instance on a multi-instance deployment. It
 * is a request-budget guard, not a distributed cache.
 *
 * The key is the GitHub account id, never the token: a token must never sit in
 * a lookup key, a log line, or a heap dump string. The entry only ever holds
 * `status === 'ok'` listings -- partial pages and errors are never cached. A
 * listing that filled the last permitted page is cached with a `truncated`
 * flag, because it is usable but is not a completeness proof: callers must not
 * prune or unselect from it.
 */

import {
  fetchGithubRepositories,
  type GithubRepository,
  type GithubRepositoryFetchResult,
} from './github-repositories'

/** A stored listing answers requests without a provider call for this long. */
export const GITHUB_REPOSITORY_CACHE_FRESH_MS = 5 * 60 * 1000
/**
 * A stale listing may still be served while the provider is failing, up to
 * this age. Past it the entry is dropped and the failure propagates: an
 * arbitrarily old listing would quietly hide repositories the user has since
 * gained access to, and the picker would look authoritative while being wrong.
 */
export const GITHUB_REPOSITORY_CACHE_RETENTION_MS = 60 * 60 * 1000
/**
 * Hard cap on retained accounts. Retention is otherwise only checked when the
 * same account is requested again, so without a cap every account that ever
 * opened `/github` would hold its repository names (including private ones) in
 * process memory until restart. The oldest entries are evicted first.
 */
export const GITHUB_REPOSITORY_CACHE_MAX_ENTRIES = 64

export interface GithubRepositoryCacheEntry {
  readonly repositories: readonly GithubRepository[]
  readonly fetchedAt: number
  /**
   * True when the listing filled the last permitted page, so it is usable but
   * not a completeness proof. Preserved across cache hits so a sync never
   * prunes from a truncated listing.
   */
  readonly truncated: boolean
  /**
   * Reserved for an `If-None-Match` revalidation path. Not populated today:
   * `fetchGithubRepositories` does not return the response ETag yet, so the
   * 304 fast path is a documented known gap rather than a silent no-op.
   */
  readonly etag?: string
}

export type GithubRepositoriesProvider = (options: {
  token: string
}) => Promise<GithubRepositoryFetchResult>

const cacheStore = new Map<number, GithubRepositoryCacheEntry>()
/**
 * One provider read per account at a time. Two tabs, or the picker and a sync,
 * can hit a stale entry in the same instant; without this, each issues a full
 * five-page listing and the budget drain this cache exists to stop comes back
 * through the concurrency door.
 */
const inFlightStore = new Map<number, Promise<GithubRepositoriesCachedResult>>()
/**
 * Bumped by `purgeGithubRepositoryCache`. A provider read captures the epoch
 * when it starts and refuses to store its result if the epoch changed while it
 * was in flight: a disconnect or re-auth must not be undone by a read that was
 * already on the wire.
 */
const purgeEpochStore = new Map<number, number>()

export interface GetGithubRepositoriesCachedOptions {
  githubId: number
  token: string
  /** Bypass the fresh window and revalidate now (the Refresh list button). */
  force?: boolean
  /** Injectable clock so staleness is testable without waiting. */
  now?: number
  /** Injectable provider; defaults to the real GitHub listing. */
  fetchRepositories?: GithubRepositoriesProvider
}

export interface GithubRepositoriesCachedResult {
  result: GithubRepositoryFetchResult
  /** When the returned listing was read from GitHub. */
  fetchedAt: number
  /** True when the listing is a cached one served while GitHub was failing. */
  stale: boolean
}

function okResult(
  repositories: readonly GithubRepository[],
  truncated: boolean,
): GithubRepositoryFetchResult {
  return { status: 'ok', repositories, truncated }
}

/**
 * Drops expired entries and enforces the entry cap. The per-request check only
 * covers the account being requested, so without this sweep a listing nobody
 * asks for again stays resident until the process restarts.
 */
function sweepCache(now: number): void {
  for (const [githubId, entry] of cacheStore) {
    if (now - entry.fetchedAt >= GITHUB_REPOSITORY_CACHE_RETENTION_MS) {
      cacheStore.delete(githubId)
    }
  }
  if (cacheStore.size <= GITHUB_REPOSITORY_CACHE_MAX_ENTRIES) return
  const oldestFirst = [...cacheStore.entries()].sort(
    ([, left], [, right]) => left.fetchedAt - right.fetchedAt,
  )
  for (const [githubId] of oldestFirst) {
    if (cacheStore.size <= GITHUB_REPOSITORY_CACHE_MAX_ENTRIES) break
    cacheStore.delete(githubId)
  }
}

/**
 * Returns a repository listing, using the cache where it is safe to.
 *
 * Behavior matrix:
 * - fresh entry, not forced      -> cache, zero provider calls
 * - stale entry (5-60 min)       -> provider; `ok` replaces the entry
 * - forced                       -> provider, regardless of freshness
 * - provider rate-limited/failed -> serve the entry marked `stale: true`,
 *                                   or propagate the failure untouched
 * - provider unauthorized (401)  -> purge the entry, never serve it stale
 * - entry older than 60 min      -> dropped, so it is never served at all
 */
export async function getGithubRepositoriesCached(
  options: GetGithubRepositoriesCachedOptions,
): Promise<GithubRepositoriesCachedResult> {
  const now = options.now ?? Date.now()
  const cached = cacheStore.get(options.githubId)
  // A negative age means the clock moved backwards (NTP correction, a paused
  // container). The entry is not fresh -- otherwise the fresh window would last
  // until the clock caught up -- but it stays available as a degraded fallback.
  const cachedAge = cached ? now - cached.fetchedAt : 0
  if (cached && cachedAge >= GITHUB_REPOSITORY_CACHE_RETENTION_MS) {
    cacheStore.delete(options.githubId)
  }
  if (cached && cachedAge >= 0 && cachedAge < GITHUB_REPOSITORY_CACHE_FRESH_MS && !options.force) {
    return {
      result: okResult(cached.repositories, cached.truncated),
      fetchedAt: cached.fetchedAt,
      stale: false,
    }
  }

  const inFlight = inFlightStore.get(options.githubId)
  if (inFlight) return inFlight

  const epoch = purgeEpochStore.get(options.githubId) ?? 0
  const read = readRepositories(options, now, epoch)
  const shared = read.finally(() => {
    if (inFlightStore.get(options.githubId) === shared) inFlightStore.delete(options.githubId)
  })
  inFlightStore.set(options.githubId, shared)
  return shared
}

/** Reads from the provider and applies the cache policy for one account. */
async function readRepositories(
  options: GetGithubRepositoriesCachedOptions,
  now: number,
  epoch: number,
): Promise<GithubRepositoriesCachedResult> {
  const cached = cacheStore.get(options.githubId)
  const fetchRepositories = options.fetchRepositories ?? fetchGithubRepositories
  const result = await fetchRepositories({ token: options.token })

  // A purge while the read was in flight (disconnect, fresh OAuth scope) makes
  // this result stale by contract: return it to the waiter, but do not let it
  // re-insert a listing the purge removed.
  const purged = (purgeEpochStore.get(options.githubId) ?? 0) !== epoch

  if (result.status === 'ok' && !purged) {
    // Only a complete, successful listing is ever stored. An empty listing is
    // stored too: an account that legitimately has no readable repositories
    // must not hammer GitHub on every page view. A truncated listing is stored
    // with its flag so the request budget is protected without pretending the
    // listing is complete. The sweep runs after the insert so it also enforces
    // the entry cap.
    cacheStore.set(options.githubId, {
      repositories: result.repositories,
      fetchedAt: now,
      truncated: result.truncated,
    })
    sweepCache(now)
    return { result, fetchedAt: now, stale: false }
  }

  if (result.status === 'unauthorized') {
    // Revoked access is not a transient read failure. Serving the old listing
    // would keep offering repositories the account can no longer read.
    cacheStore.delete(options.githubId)
    return { result, fetchedAt: now, stale: false }
  }

  if (cached) {
    return {
      result: okResult(cached.repositories, cached.truncated),
      fetchedAt: cached.fetchedAt,
      stale: true,
    }
  }
  return { result, fetchedAt: now, stale: false }
}

/** Drops one account's listing, e.g. on disconnect or fresh OAuth scope. */
export function purgeGithubRepositoryCache(githubId: number): void {
  purgeEpochStore.set(githubId, (purgeEpochStore.get(githubId) ?? 0) + 1)
  cacheStore.delete(githubId)
  // A read already in flight belongs to the session that was just dropped; do
  // not let the next request join it.
  inFlightStore.delete(githubId)
}

/**
 * Number of accounts currently held. Exposed so the sweep and the entry cap
 * are testable without reaching into module state.
 */
export function githubRepositoryCacheSize(): number {
  return cacheStore.size
}

/** Test-only: reset all in-process state between test cases. */
export function clearGithubRepositoryCache(): void {
  cacheStore.clear()
  inFlightStore.clear()
  purgeEpochStore.clear()
}
