/**
 * Reads a GitHub user's public "following" list, used to scope the
 * leaderboard to people the viewer actually follows on GitHub.
 *
 * Cached in memory: this list changes rarely, and the leaderboard must not
 * hit GitHub on every page view. A `Map` keyed by lowercased login is enough
 * here (unlike `apps/web/src/lib/game/github.ts`'s on-disk cache) because this runs
 * per-request in a long-lived Node process rather than at static build
 * time, so there is no separate build step to persist across.
 *
 * THE RULE THAT MATTERS, same as `github.ts`: every failure path returns an
 * empty list (or the last good cache entry when one exists) rather than
 * throwing. A leaderboard page must always render, even when GitHub is
 * unreachable, rate limited, or the login does not resolve.
 */

interface CacheEntry {
  logins: string[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours
const DEFAULT_API_BASE = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 10_000
const PER_PAGE = 100
// Up to 500 followees. GitHub's own UI caps following at a much lower
// number for most accounts; this is a generous ceiling, not an expectation.
const MAX_PAGES = 5

export interface GithubFollowingOptions {
  /** Personal access token. Falls back to process.env.GITHUB_TOKEN. Raises the rate limit; not required. */
  token?: string
  /** Override for the API base, test-only. */
  apiBase?: string
  /** Refetch only if the cache is older than this. Default 6 hours. */
  maxAgeMs?: number
}

/** Test-only: forgets every cached entry so tests don't leak between runs. */
export function clearFollowingCache(): void {
  cache.clear()
}

/**
 * Lowercased GitHub logins the given login follows. Empty on any failure:
 * a missing or unknown handle, a network error, a rate limit, or a
 * malformed response. Never throws.
 */
export async function getFollowing(
  login: string,
  options: GithubFollowingOptions = {}
): Promise<string[]> {
  try {
    return await getFollowingInner(login, options)
  } catch {
    // Belt-and-braces backstop; getFollowingInner is written to never throw.
    return []
  }
}

async function getFollowingInner(
  login: string,
  options: GithubFollowingOptions
): Promise<string[]> {
  const key = login.toLowerCase()
  if (!key) return []

  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const apiBase = options.apiBase ?? DEFAULT_API_BASE
  const token = options.token ?? process.env.GITHUB_TOKEN

  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    return cached.logins
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'digital-garden-leaderboard',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const logins: string[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiBase}/users/${encodeURIComponent(key)}/following?per_page=${PER_PAGE}&page=${page}`

    let response: Response
    try {
      response = await fetchWithTimeout(url, headers)
    } catch {
      // Network unavailable, DNS failure, timeout, aborted request, etc.
      return cached?.logins ?? []
    }

    if (response.status === 404) {
      // The login itself does not resolve. Not transient, so a stale cache
      // for a different assumption would be misleading; report empty.
      return []
    }

    if (response.status === 403 || response.status === 429) {
      // Rate limited or blocked. Serve the last good cache if there is one.
      return cached?.logins ?? []
    }

    if (!response.ok) {
      if (page === 1) return cached?.logins ?? []
      break
    }

    let batch: unknown
    try {
      batch = await response.json()
    } catch {
      // Malformed or truncated JSON.
      return cached?.logins ?? []
    }

    if (!Array.isArray(batch)) {
      return cached?.logins ?? []
    }

    for (const raw of batch) {
      if (raw && typeof raw === 'object') {
        const rawLogin = (raw as Record<string, unknown>).login
        if (typeof rawLogin === 'string' && rawLogin.length > 0) {
          logins.push(rawLogin.toLowerCase())
        }
      }
    }

    if (batch.length < PER_PAGE) break
  }

  cache.set(key, { logins, fetchedAt: Date.now() })
  return logins
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
