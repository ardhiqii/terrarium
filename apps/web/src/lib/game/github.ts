/**
 * Build-time GitHub commit fetch, cached to JSON.
 *
 * TWO-PATH STRATEGY, chosen after the events-only approach turned out to
 * systematically undercount (see below).
 *
 * 1. **Token present -> GraphQL `contributionsCollection`.** This is the
 *    exact data GitHub's own contribution graph renders from: one request,
 *    real per-day commit counts, no undercounting. It requires
 *    authentication; there is no unauthenticated GraphQL mode, full stop.
 * 2. **No token -> the REST public-events path** (`fetchViaEvents`),
 *    unchanged from the original implementation, undercount and all.
 * 3. **GraphQL fails for any reason -> fall back to path 2**, still using
 *    the token for the REST call (higher rate limit), so a token holder
 *    never ends up worse off than an unauthenticated caller.
 *
 * The exact query (verifiable without a token, since it is just text):
 *
 * ```graphql
 * query($login: String!, $from: DateTime!, $to: DateTime!) {
 *   user(login: $login) {
 *     contributionsCollection(from: $from, to: $to) {
 *       commitContributionsByRepository(maxRepositories: 100) {
 *         repository {
 *           name
 *         }
 *         contributions(first: 100) {
 *           nodes {
 *             occurredAt
 *             commitCount
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Deliberately NOT `contributionCalendar.weeks[].contributionDays[]`: that
 * field is GitHub's generic "contributions" count, which blends commits
 * together with issues, PRs, and reviews. Using it would trade one kind of
 * inaccuracy (undercounting pushes) for another (counting non-commit
 * activity as commits), and the entire point of this fix is an accurate
 * `commitsByDay`. `commitContributionsByRepository` is commit-only, and its
 * nested `contributions` connection carries a real `commitCount` per
 * `occurredAt` day per repository, which is exactly the shape needed to
 * populate both `commitsByDay` (summed across every repository returned)
 * and `gardenCommitsByDay` (the one repository matching `gardenRepo`).
 *
 * `from`/`to` bound the query to a 90 day window, matching the REST path's
 * effective window (see below) and, more importantly, keeping the per-repo
 * `contributions(first: 100)` page comfortably under its 100-node limit
 * without needing cursor pagination through `contributions.pageInfo` this
 * module has not been able to exercise against a live token. Widening the
 * window to a full year later is a matter of also paginating that
 * connection; deliberately left out for now rather than shipped untested.
 *
 * **This GraphQL path has not been run against a live token.** No token was
 * available while building it (see the report for this task). It is
 * written defensively, treats every unexpected shape as a failure, and
 * falls back to the REST path rather than ever throwing, but it has not
 * been executed. Treat it as reviewed-by-inspection, not verified.
 *
 * REST endpoint choice for path 2: `GET /users/{login}/events/public`.
 *
 * The alternative, `GET /repos/{owner}/{repo}/stats/commit_activity`, only
 * covers one repo per call. Populating `commitsByDay` ("all repos") from it
 * would mean first listing every repo the user owns, then issuing one
 * commit-activity call per repo, each of which can return `202 Accepted`
 * with an empty body while GitHub computes the stats in the background and
 * has to be retried. That is a lot of requests against a 60/hour
 * unauthenticated budget, and a lot of extra failure surface for a build
 * step that must never throw.
 *
 * The public events feed is one call (paginated up to GitHub's ~300 event /
 * 90 day public history cap), returns `PushEvent`s with the repo name
 * attached, and is enough to derive both `commitsByDay` and the
 * `gardenCommitsByDay` subset (by matching `event.repo.name` against
 * `gardenRepo`) without a second request. The tradeoff is a 90 day window
 * rather than full history, which is an acceptable fit for a "current
 * streak, recent XP" creature and not a commit-count-of-record.
 *
 * Disclosed limitation, confirmed by hitting the live API while building
 * this: PushEvent payloads no longer reliably carry a `commits` array (or
 * even `size` / `distinct_size`) the way older documentation describes.
 * `summarizeEvents` below falls back to counting each such push as one
 * commit when nothing richer is available, which undercounts multi-commit
 * pushes. Getting an exact count back via REST would mean an extra
 * `/repos/{owner}/{repo}/compare/{before}...{head}` call per push, which
 * turns one request into dozens against the same 60/hour unauthenticated
 * budget this module has to survive on. That trade was made deliberately in
 * favour of "always works, is a floor" over "sometimes exact, sometimes rate
 * limited" -- and is now the reason path 1 (GraphQL) exists, since flooring
 * every push to 1 commit meant a 12-commit push scored the same as a
 * 1-commit push, which is a real problem for a feature whose whole point is
 * measuring commit activity.
 *
 * Cache-level bookkeeping, NOT part of the frozen `GithubStats` shape: the
 * JSON cache also carries a `source: 'graphql' | 'events'` field recording
 * which path produced the data, purely for build-log/debugging purposes.
 * `GithubStats` itself is untouched; `isValidGithubStats` below ignores the
 * extra field entirely when validating a cache read.
 *
 * THE RULE THAT MATTERS: every failure path below returns `null` (or falls
 * back to the on-disk cache) and nothing ever throws. This module runs
 * during a static build; a thrown fetch takes `npm run build` down with it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { GithubStats } from './types'
import { computeCurrentStreak } from './streak'

/** Which path produced a given cache entry. Cache-only, never on `GithubStats`. */
type GithubStatsSource = 'graphql' | 'events'

const GRAPHQL_CONTRIBUTIONS_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        repository {
          name
        }
        contributions(first: 100) {
          nodes {
            occurredAt
            commitCount
          }
        }
      }
    }
  }
}
`.trim()

const CONTRIBUTIONS_WINDOW_DAYS = 90

export interface GithubFetchOptions {
  /** GitHub handle, e.g. 'ardhiqi'. */
  login: string
  /** Repo name treated as "the garden" for the higher commit rate. */
  gardenRepo?: string
  /** Personal access token. Falls back to process.env.GITHUB_TOKEN. */
  token?: string
  /** Cache file path. Defaults to apps/web/src/lib/game/github-cache.json. */
  cachePath?: string
  /** Refetch only if the cache is older than this. Default 6 hours. */
  maxAgeMs?: number
  /**
   * Override for the API base, test-only. Lets a test point at an
   * unroutable host to simulate a network outage without touching real
   * network configuration.
   */
  apiBase?: string
}

// Resolved from `process.cwd()` rather than `__dirname`: this module is
// compiled by both Next's bundler and Vitest, and `__dirname` is not a
// reliable global under an ESM/bundler build target. `process.cwd()` is
// stable because both `next build` and `vitest run` are invoked from the
// project root via package.json scripts.
const DEFAULT_CACHE_PATH = path.join(
  /*turbopackIgnore: true*/ process.cwd(),
  'apps/web/src/lib/game/github-cache.json'
)
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours
const DEFAULT_API_BASE = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 10_000
const MAX_EVENT_PAGES = 3
const PER_PAGE = 100

/**
 * Returns null if missing, unreadable, or malformed. Never throws.
 */
export function readGithubCache(cachePath?: string): GithubStats | null {
  const resolved = cachePath ?? DEFAULT_CACHE_PATH
  try {
    if (!existsSync(resolved)) return null
    const raw = readFileSync(resolved, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isValidGithubStats(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Best-effort. Swallows write errors.
 */
export function writeGithubCache(stats: GithubStats, cachePath?: string): void {
  writeCacheFile(stats, cachePath ?? DEFAULT_CACHE_PATH)
}

/**
 * Internal-only variant that tags the cache entry with which path produced
 * it. Not exported: the exported `writeGithubCache` keeps the exact
 * `GithubStats`-only signature the spec requires, since `GithubStats` is
 * frozen. The `source` field lives only in the JSON on disk, is optional,
 * and `isValidGithubStats` never requires it, so a cache written by
 * `writeGithubCache` (no source) still reads back fine.
 */
function writeGithubCacheWithSource(
  stats: GithubStats,
  source: GithubStatsSource,
  cachePath: string
): void {
  writeCacheFile({ ...stats, source }, cachePath)
}

function writeCacheFile(data: unknown, resolved: string): void {
  try {
    writeFileSync(resolved, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  } catch {
    // Best-effort. A failed write must never take the build down; the next
    // build simply refetches.
  }
}

/**
 * Never throws. Returns null on any failure.
 */
export async function fetchGithubStats(
  options: GithubFetchOptions
): Promise<GithubStats | null> {
  try {
    return await fetchGithubStatsInner(options)
  } catch {
    // Belt-and-braces: fetchGithubStatsInner is written to never throw, but
    // this is the backstop that guarantees it regardless.
    return null
  }
}

async function fetchGithubStatsInner(
  options: GithubFetchOptions
): Promise<GithubStats | null> {
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const apiBase = options.apiBase ?? DEFAULT_API_BASE
  const token = options.token ?? process.env.GITHUB_TOKEN

  const cached = readGithubCache(cachePath)
  if (cached) {
    const cachedAt = Date.parse(cached.fetchedAt)
    const age = Number.isFinite(cachedAt) ? Date.now() - cachedAt : Infinity
    if (age < maxAgeMs) {
      return cached
    }
  }

  // Path 1: token present, try GraphQL first for exact per-day commit
  // counts. Any failure here (network, non-200, GraphQL `errors`, missing
  // user, unexpected shape) returns null from fetchViaGraphQL rather than
  // throwing, and control simply falls through to path 2 below.
  if (token) {
    const graphqlStats = await fetchViaGraphQL(options, token, apiBase, cachePath)
    if (graphqlStats) {
      return graphqlStats
    }
  }

  // Path 2: no token, or GraphQL failed. Falls back to the REST public
  // events feed, which still benefits from the token (higher rate limit)
  // when one is present.
  return await fetchViaEvents(options, apiBase, token, cachePath, cached)
}

async function fetchViaEvents(
  options: GithubFetchOptions,
  apiBase: string,
  token: string | undefined,
  cachePath: string,
  cached: GithubStats | null
): Promise<GithubStats | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'terrarium-creature-build',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const events: unknown[] = []
  let rateLimited = false

  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    const url = `${apiBase}/users/${encodeURIComponent(options.login)}/events/public?per_page=${PER_PAGE}&page=${page}`

    let response: Response
    try {
      response = await fetchWithTimeout(url, { headers })
    } catch {
      // Network unavailable, DNS failure, timeout, aborted request, etc.
      // Fall back to whatever cache exists; there is nothing else to try.
      return cached ?? null
    }

    if (response.status === 404) {
      // Handle does not exist. No cache fallback: a 404 means the login
      // itself is wrong, not a transient outage, so a stale cache for a
      // different assumption would be misleading.
      return null
    }

    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining')
      if (remaining === '0' || response.status === 429) {
        rateLimited = true
        break
      }
      // A 403 that is not the rate-limit shape (e.g. blocked/abuse
      // detection) is still a failure path that must not throw.
      return cached ?? null
    }

    if (!response.ok) {
      // Any other non-success status on the first page is a hard failure;
      // on a later page, treat it as "no more pages" and use what we have.
      if (page === 1) return cached ?? null
      break
    }

    let batch: unknown
    try {
      batch = await response.json()
    } catch {
      // Malformed or truncated JSON.
      return cached ?? null
    }

    if (!Array.isArray(batch)) {
      return cached ?? null
    }

    events.push(...batch)

    if (batch.length < PER_PAGE) break
  }

  if (rateLimited && events.length === 0) {
    return cached ?? null
  }

  const { commitsByDay, gardenCommitsByDay, totalCommits } = summarizeEvents(
    events,
    options.gardenRepo
  )

  const stats: GithubStats = {
    login: options.login,
    totalCommits,
    commitsByDay,
    gardenCommitsByDay,
    currentStreakDays: computeCurrentStreak(commitsByDay),
    fetchedAt: new Date().toISOString(),
  }

  writeGithubCacheWithSource(stats, 'events', cachePath)

  return stats
}

/**
 * Path 1. Never throws, and never falls back to the on-disk cache itself:
 * any problem just returns `null`, and the caller (`fetchGithubStatsInner`)
 * moves on to `fetchViaEvents`, which does its own cache fallback. Letting
 * this function fall back to cache too would risk serving stale
 * GraphQL-sourced data instead of a fresh, accurate REST fetch.
 *
 * UNTESTED against a live token; see the module header for why, and the
 * exact query text there for review.
 */
async function fetchViaGraphQL(
  options: GithubFetchOptions,
  token: string,
  apiBase: string,
  cachePath: string
): Promise<GithubStats | null> {
  const to = new Date()
  const from = new Date(to.getTime() - CONTRIBUTIONS_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'terrarium-creature-build',
    Authorization: `Bearer ${token}`,
  }

  const body = JSON.stringify({
    query: GRAPHQL_CONTRIBUTIONS_QUERY,
    variables: {
      login: options.login,
      from: from.toISOString(),
      to: to.toISOString(),
    },
  })

  let response: Response
  try {
    response = await fetchWithTimeout(`${apiBase}/graphql`, {
      method: 'POST',
      headers,
      body,
    })
  } catch {
    // Network unavailable, DNS failure, timeout, aborted request, etc.
    return null
  }

  if (!response.ok) {
    // Covers 401 (bad token), 403 (rate limited or blocked), 5xx, etc.
    // No need to distinguish further: every case here just means "try the
    // REST path instead."
    return null
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    // Malformed or truncated JSON.
    return null
  }

  if (!json || typeof json !== 'object') return null
  const payload = json as Record<string, unknown>

  // GraphQL can return 200 with an `errors` array and null/partial `data`,
  // e.g. for a login that does not resolve to a user. Treat any non-empty
  // `errors` as a failure of this path.
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return null
  }

  const repos = extractCommitContributionsByRepository(payload)
  if (!repos) return null

  const commitsByDay: Record<string, number> = {}
  const gardenCommitsByDay: Record<string, number> = {}
  let totalCommits = 0

  for (const entry of repos) {
    const repoName = entry.repositoryName
    const isGarden = Boolean(options.gardenRepo) && repoName === options.gardenRepo

    for (const node of entry.nodes) {
      const day = node.occurredAt.slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      if (node.commitCount <= 0) continue

      commitsByDay[day] = (commitsByDay[day] ?? 0) + node.commitCount
      totalCommits += node.commitCount

      if (isGarden) {
        // Same `node.commitCount` added to both maps in the same
        // iteration, so gardenCommitsByDay stays a true subset of
        // commitsByDay by construction, exactly as in the events path.
        gardenCommitsByDay[day] = (gardenCommitsByDay[day] ?? 0) + node.commitCount
      }
    }
  }

  const stats: GithubStats = {
    login: options.login,
    totalCommits,
    commitsByDay,
    gardenCommitsByDay,
    currentStreakDays: computeCurrentStreak(commitsByDay),
    fetchedAt: new Date().toISOString(),
  }

  writeGithubCacheWithSource(stats, 'graphql', cachePath)

  return stats
}

interface CommitContributionsByRepositoryEntry {
  repositoryName: string
  nodes: { occurredAt: string; commitCount: number }[]
}

/**
 * Defensively walks the GraphQL response shape, returning null on anything
 * that does not look exactly like what the query above asks for. Never
 * throws: every field access is guarded rather than assumed.
 */
function extractCommitContributionsByRepository(
  payload: Record<string, unknown>
): CommitContributionsByRepositoryEntry[] | null {
  const data = payload.data
  if (!data || typeof data !== 'object') return null
  const user = (data as Record<string, unknown>).user
  if (!user || typeof user !== 'object') return null
  const contributionsCollection = (user as Record<string, unknown>)
    .contributionsCollection
  if (!contributionsCollection || typeof contributionsCollection !== 'object') {
    return null
  }
  const rawRepos = (contributionsCollection as Record<string, unknown>)
    .commitContributionsByRepository
  if (!Array.isArray(rawRepos)) return null

  const result: CommitContributionsByRepositoryEntry[] = []

  for (const rawRepo of rawRepos) {
    if (!rawRepo || typeof rawRepo !== 'object') continue
    const repoEntry = rawRepo as Record<string, unknown>
    const repository = repoEntry.repository
    const repositoryName =
      repository && typeof repository === 'object'
        ? (repository as Record<string, unknown>).name
        : null
    if (typeof repositoryName !== 'string') continue

    const contributions = repoEntry.contributions
    const rawNodes =
      contributions && typeof contributions === 'object'
        ? (contributions as Record<string, unknown>).nodes
        : null
    if (!Array.isArray(rawNodes)) continue

    const nodes: { occurredAt: string; commitCount: number }[] = []
    for (const rawNode of rawNodes) {
      if (!rawNode || typeof rawNode !== 'object') continue
      const node = rawNode as Record<string, unknown>
      if (
        typeof node.occurredAt === 'string' &&
        typeof node.commitCount === 'number' &&
        Number.isFinite(node.commitCount)
      ) {
        nodes.push({ occurredAt: node.occurredAt, commitCount: node.commitCount })
      }
    }

    result.push({ repositoryName, nodes })
  }

  return result
}

async function fetchWithTimeout(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string }
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Walks the public events feed, bucketing PushEvent commit counts by day.
 * `gardenCommitsByDay` is built by adding to both maps from the same event,
 * so it is a true subset of `commitsByDay` by construction: it can never
 * gain a day or a count that `commitsByDay` does not already have.
 */
function summarizeEvents(
  events: unknown[],
  gardenRepo: string | undefined
): {
  commitsByDay: Record<string, number>
  gardenCommitsByDay: Record<string, number>
  totalCommits: number
} {
  const commitsByDay: Record<string, number> = {}
  const gardenCommitsByDay: Record<string, number> = {}
  let totalCommits = 0

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as Record<string, unknown>
    if (event.type !== 'PushEvent') continue

    const createdAt = typeof event.created_at === 'string' ? event.created_at : null
    if (!createdAt) continue
    const day = createdAt.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue

    const payload = event.payload as Record<string, unknown> | undefined
    // GitHub's public events API historically embedded a `commits` array (or
    // at minimum `size` / `distinct_size`) on PushEvent payloads. As
    // observed live against this account's real feed, none of the three are
    // present any more: a payload here is just `{ push_id, ref, head,
    // before, repository_id }`. This is a real, currently-live API
    // narrowing, not a hypothetical. The fallback chain below still prefers
    // the richer shapes in case they reappear (some accounts/event ages do
    // still carry `size`), and degrades to "1 commit per push" when GitHub
    // gives nothing else to count. That floor undercounts multi-commit
    // pushes, which is a known, disclosed limitation of this endpoint
    // rather than a guess dressed up as a fact.
    const commits = Array.isArray(payload?.commits) ? payload!.commits : null
    const distinctSize =
      typeof payload?.distinct_size === 'number' ? payload.distinct_size : null
    const size = typeof payload?.size === 'number' ? payload.size : null
    const count = commits ? commits.length : distinctSize ?? size ?? 1
    if (count <= 0) continue

    commitsByDay[day] = (commitsByDay[day] ?? 0) + count
    totalCommits += count

    const repo = event.repo as Record<string, unknown> | undefined
    const repoName = typeof repo?.name === 'string' ? repo.name : ''
    const repoShortName = repoName.includes('/') ? repoName.split('/')[1] : repoName

    if (gardenRepo && repoShortName === gardenRepo) {
      // Added from the same `count` used for `commitsByDay` above, so
      // gardenCommitsByDay[day] can never exceed commitsByDay[day].
      gardenCommitsByDay[day] = (gardenCommitsByDay[day] ?? 0) + count
    }
  }

  return { commitsByDay, gardenCommitsByDay, totalCommits }
}

// Moved to `streak.ts` so `repo-creature.ts` can use it without importing this
// filesystem-bound module into the browser bundle. Re-exported here so existing
// server-side callers keep working unchanged. A bare `export ... from` does not
// bind the name locally, and this module calls it directly, hence the import.
export { computeCurrentStreak } from './streak'

function isValidGithubStats(value: unknown): value is GithubStats {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.login === 'string' &&
    typeof v.totalCommits === 'number' &&
    isRecordOfNumbers(v.commitsByDay) &&
    isRecordOfNumbers(v.gardenCommitsByDay) &&
    typeof v.currentStreakDays === 'number' &&
    typeof v.fetchedAt === 'string' &&
    !Number.isNaN(Date.parse(v.fetchedAt))
  )
}

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (n) => typeof n === 'number' && Number.isFinite(n)
  )
}
