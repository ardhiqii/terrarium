/**
 * Fetches the raw GitHub activity the ledger needs and maps it into the
 * provider-neutral records `normalizeGitHubEvents` consumes.
 *
 * The normalizer in `github-events.ts` is already built and tested against
 * these record shapes. What was missing was an adapter at the GitHub boundary
 * that actually pulls merged PRs, releases, closed linked issues, and
 * successful CI checks. This module is that adapter.
 *
 * DESIGN RULE, same as everywhere in this repo: every failure path returns an
 * empty list (or null) rather than throwing. A sync/build must never be taken
 * down by a rate limit, a missing token, or a network blip.
 *
 * The live GitHub REST shape differs from our records in a few deliberate ways
 * and each is mapped here:
 *   - PRs: GitHub `pull_request` events list merged pulls; we keep `merged_at`.
 *   - Releases: we filter out drafts (matches the normalizer's own draft rule).
 *   - Issues: closed user-authored issues are passed as candidates; the
 *     normalizer only awards linked issues, and timeline-based linkage remains
 *     a later adapter enhancement.
 *   - CI: we look at a repo's recent check runs and keep the successful ones.
 */
import type {
  GitHubCommitRecord,
  GitHubMergedPullRequestRecord,
  GitHubReleaseRecord,
  GitHubLinkedIssueRecord,
  GitHubCiCheckRecord,
  GitHubEventNormalizationInput,
} from './github-events'

const DEFAULT_API_BASE = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 10_000
const DEFAULT_PAGE_SIZE = 30
const MAX_PAGES = 3
/** Minimum gap between streamed progress events, in milliseconds. */
const PROGRESS_THROTTLE_MS = 250
/** Upper bound on merged-PR SHAs we will look up check runs for, per repo. */
const MAX_CHECK_RUN_COMMITS = 15
/**
 * Upper bound on commits whose detail endpoint we will call, per repository.
 *
 * GitHub returns `stats` only on the single-commit endpoint, so every commit
 * costs one request. An unbounded walk fetched details for up to 180 commits per
 * repository (2 attribution fields x 3 pages x 30), which made a 25-repository
 * sync spend roughly 7,000 requests against GitHub's 5,000/hour budget and never
 * finish. Only the newest activity can ever be awarded, because the baseline
 * recorded for a sync is `now`, so the walk is bounded here and the shortfall is
 * reported as truncation instead of being silently assumed complete.
 */
const MAX_COMMITS_PER_REPO = 30

export interface FetchGitHubEventsOptions {
  /** GitHub login of the connected account, e.g. 'ardhiqi'. */
  login: string
  /**
   * Repositories to read activity from. Stable repository IDs are preferred;
   * strings remain supported for fixtures and older callers.
   */
  repos?: readonly (string | GithubRepoRef)[]
  /** Personal access token. Falls back to process.env.GITHUB_TOKEN. */
  token?: string
  /** Stable GitHub account identity used for event IDs and caps. */
  sourceId?: string
  /** Override for the API base, test-only. */
  apiBase?: string
  /** Test-only: inject a fetch. */
  fetch?: typeof fetch
  /**
   * Called as each repository is read, so a long sync can stream progress to
   * whoever is waiting on it instead of appearing frozen.
   */
  onProgress?: (progress: GitHubEventsProgress) => void
  /**
   * Aborts the read. Cancelling a sync must actually stop the GitHub requests
   * rather than only abandoning the response, otherwise a cancelled sync keeps
   * burning the account's hourly request budget in the background.
   */
  signal?: AbortSignal
}

export interface GithubRepoRef {
  readonly fullName: string
  readonly id?: string
}

export type GithubEventsFetchStatus = 'ok' | 'partial' | 'unavailable'

export interface GitHubEventsFetchResult {
  input: GitHubEventNormalizationInput
  /** The account login the events were attributed to. */
  login: string
  status: GithubEventsFetchStatus
  /**
   * True when a bounded scan reached its page ceiling with a full final page, so
   * the adapter cannot honestly claim to have read the whole history.
   *
   * Truncation is deliberately NOT a failure. Every list is read newest-first,
   * so a truncated scan still captured the most recent activity; only material
   * older than that was missed, and the baseline recorded for this sync is
   * `now`, which is newer still. Counting truncation as a failure made every
   * repo with a long history report `partial`, which withheld the baseline and
   * stranded the account at zero XP permanently.
   */
  truncated: boolean
}

/** Progress payload for a long-running sync, emitted between repository reads. */
export interface GitHubEventsProgress {
  /** 1-based index of the repository currently being read. */
  repositoryIndex: number
  repositoryCount: number
  /** `owner/name` of the repository currently being read. */
  repository: string
  /** Monotonic count of completed HTTP requests, for a live activity read-out. */
  requestsDone: number
}

interface FetchHealth {
  successfulRequests: number
  failedRequests: number
  /**
   * Bounded-scan truncations, tracked separately from `failedRequests`.
   * A full third page is the ordinary state of any repository with a long
   * history, so it must not be reported as an error.
   */
  truncatedScans: number
  /** Monotonic HTTP request counter feeding {@link GitHubEventsProgress}. */
  requestsDone: number
  /** Invoked after every completed HTTP round trip. */
  onRequest?: () => void
}

function withTimeout(client: typeof fetch, url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  return client(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timeout))
}

/**
 * Never throws. Returns an empty input on any failure.
 */
export async function fetchGitHubEvents(
  options: FetchGitHubEventsOptions
): Promise<GitHubEventsFetchResult> {
  try {
    return await fetchGitHubEventsInner(options)
  } catch {
    return { input: emptyInput(), login: options.login, status: 'unavailable', truncated: false }
  }
}

function emptyInput(): GitHubEventNormalizationInput {
  return { sourceId: '', companionId: '' }
}

async function fetchGitHubEventsInner(
  options: FetchGitHubEventsOptions
): Promise<GitHubEventsFetchResult> {
  const token = options.token ?? process.env.GITHUB_TOKEN
  const apiBase = options.apiBase ?? DEFAULT_API_BASE
  const rawClient = options.fetch ?? globalThis.fetch
  if (typeof rawClient !== 'function') {
    return { input: emptyInput(), login: options.login, status: 'unavailable', truncated: false }
  }
  // The caller's abort signal is merged in at the client boundary so that every
  // request helper observes it without each one having to thread it through,
  // and so the per-request timeout signal keeps working alongside it.
  const externalSignal = options.signal
  const client: typeof fetch = externalSignal
    ? ((input: RequestInfo | URL, init?: RequestInit) => {
        const timeoutSignal = init?.signal ?? null
        const merged = new AbortController()
        const forward = (): void => merged.abort()
        if (timeoutSignal?.aborted || externalSignal.aborted) merged.abort()
        else {
          timeoutSignal?.addEventListener('abort', forward, { once: true })
          externalSignal.addEventListener('abort', forward, { once: true })
        }
        return rawClient(input, { ...init, signal: merged.signal }).finally(() => {
          timeoutSignal?.removeEventListener('abort', forward)
          externalSignal.removeEventListener('abort', forward)
        })
      })
    : rawClient
  const health: FetchHealth = {
    successfulRequests: 0,
    failedRequests: 0,
    truncatedScans: 0,
    requestsDone: 0,
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'terrarium-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const sourceId = options.sourceId?.trim() || options.login.trim() || 'unknown'
  const repos = (options.repos ?? [])
    .map(toRepoRef)
    .filter((repo): repo is GithubRepoRef => repo !== null)

  // If no explicit repos were given, list the user's repos once.
  const repoRefs = repos.length
    ? repos
    : await fetchUserRepos(client, apiBase, headers, options.login, health)

  const mergedPullRequests: GitHubMergedPullRequestRecord[] = []
  const releases: GitHubReleaseRecord[] = []
  const linkedIssues: GitHubLinkedIssueRecord[] = []
  const ciChecks: GitHubCiCheckRecord[] = []
  const commits: GitHubCommitRecord[] = []

  const repositoryCount = repoRefs.length
  let repositoryIndex = 0
  let currentRepository = repoRefs[0]?.fullName ?? ''
  let lastEmitAt = 0
  const emitProgress = (force = false): void => {
    if (!options.onProgress) return
    const now = Date.now()
    // Progress exists for a human watching a long sync, so a burst of parallel
    // requests must not flood the stream. Repo boundaries always emit.
    if (!force && now - lastEmitAt < PROGRESS_THROTTLE_MS) return
    lastEmitAt = now
    options.onProgress({
      repositoryIndex,
      repositoryCount,
      repository: currentRepository,
      requestsDone: health.requestsDone,
    })
  }
  health.onRequest = () => {
    health.requestsDone += 1
    emitProgress()
  }

  // For each repo, pull the activity. A repo that fails is skipped, never fatal.
  for (const repo of repoRefs) {
    // A cancelled sync stops reading immediately instead of walking every
    // remaining repository against the account's hourly request budget.
    if (options.signal?.aborted) break
    repositoryIndex += 1
    currentRepository = repo.fullName
    emitProgress(true)

    // Pull requests are read first because CI checks are looked up from the SHAs
    // of the merged PRs, not from a walk of every recent default-branch commit.
    // The normalizer only ever awards a check that matches a merged PR, so the
    // old walk spent ~90-190 requests per repo to discover CI it then discarded.
    const prs = await fetchMergedPullRequests(client, apiBase, headers, repo, options.login, health)
    const [repoCommits, rels, issues, checks] = await Promise.all([
      fetchUserCommits(client, apiBase, headers, repo, options.login, health),
      fetchReleases(client, apiBase, headers, repo, options.login, health),
      fetchClosedIssues(client, apiBase, headers, repo, options.login, health),
      fetchCheckRuns(client, apiBase, headers, repo, health, mergedPullRequestShas(prs)),
    ])
    commits.push(...repoCommits)
    mergedPullRequests.push(...prs)
    releases.push(...rels)
    linkedIssues.push(...issues)
    ciChecks.push(...checks)
  }
  emitProgress(true)

  return {
    input: {
      sourceId,
      companionId: options.login, // the active companion receives these events
      commits,
      mergedPullRequests,
      releases,
      linkedIssues,
      ciChecks,
    },
    login: options.login,
    status: health.successfulRequests === 0
      ? 'unavailable'
      : health.failedRequests === 0
        ? 'ok'
        : 'partial',
    truncated: health.truncatedScans > 0,
  }
}

/**
 * SHAs worth looking up check runs for: the merged PR's own head and the merge
 * commit GitHub created for it. `normalizeGitHubEvents` matches a check to a PR
 * by exactly these two fields, so any other SHA is unusable by design.
 */
function mergedPullRequestShas(prs: readonly GitHubMergedPullRequestRecord[]): string[] {
  const shas: string[] = []
  const seen = new Set<string>()
  for (const pr of prs) {
    for (const sha of [pr.headSha, pr.mergeCommitSha]) {
      if (!sha || seen.has(sha)) continue
      seen.add(sha)
      shas.push(sha)
    }
  }
  return shas
}

async function fetchUserRepos(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  login: string,
  health: FetchHealth,
): Promise<GithubRepoRef[]> {
  try {
    const body = await fetchJsonPage(
      client,
      `${apiBase}/users/${encodeURIComponent(login)}/repos?per_page=100&sort=updated`,
      headers,
      health,
    )
    return body
      ?.map((item) => {
        const fullName = stringField(item, 'full_name') ?? stringField(item, 'name')
        if (!fullName) return null
        const id = numberField(item, 'id')
        return { fullName, ...(id === null ? {} : { id: String(id) }) }
      })
      .filter((repo): repo is GithubRepoRef => repo !== null) ?? []
  } catch {
    return []
  }
}

async function fetchMergedPullRequests(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  login: string,
  health: FetchHealth,
): Promise<GitHubMergedPullRequestRecord[]> {
  const out: GitHubMergedPullRequestRecord[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiBase}/repos/${repoPath(repo)}/pulls?state=closed&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
    const items = await fetchJsonPage(client, url, headers, health)
    if (!items) break
    for (const item of items) {
      if (!attributedToLogin(item, login, 'user')) continue
      const mergedAt = stringField(item, 'merged_at')
      if (!mergedAt) continue // not merged
      const id = stringField(item, 'node_id') ?? String(numberField(item, 'id') ?? 0)
      const number = optionalNumber(numberField(item, 'number'))
      const headSha = optionalString(itemHeadSha(item))
      const mergeCommitSha = optionalString(stringField(item, 'merge_commit_sha'))
      out.push({
        id,
        repositoryId: repositoryId(repo),
        ...(number === undefined ? {} : { number }),
        mergedAt,
        ...(headSha ? { headSha } : {}),
        ...(mergeCommitSha ? { mergeCommitSha } : {}),
      })
    }
    if (items.length < DEFAULT_PAGE_SIZE) break
    // A full final page means GitHub may still hold more, so the bounded scan
    // cannot claim completeness. That is truncation, not failure.
    if (page === MAX_PAGES) health.truncatedScans += 1
  }
  return out
}

async function fetchReleases(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  login: string,
  health: FetchHealth,
): Promise<GitHubReleaseRecord[]> {
  const out: GitHubReleaseRecord[] = []
  const url = `${apiBase}/repos/${repoPath(repo)}/releases?per_page=${DEFAULT_PAGE_SIZE}`
  const items = await fetchJsonPage(client, url, headers, health)
  if (!items) return out
  for (const item of items) {
    if (!attributedToLogin(item, login, 'author')) continue
    const publishedAt = stringField(item, 'published_at')
    const draft = booleanField(item, 'draft') ?? false
    if (draft || !publishedAt) continue
    const tagName = optionalString(stringField(item, 'tag_name'))
    out.push({
      id: stringField(item, 'node_id') ?? String(numberField(item, 'id') ?? 0),
      repositoryId: repositoryId(repo),
      ...(tagName ? { tagName } : {}),
      publishedAt,
      draft: false,
      published: true,
    })
  }
  return out
}

async function fetchClosedIssues(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  login: string,
  health: FetchHealth,
): Promise<GitHubLinkedIssueRecord[]> {
  const out: GitHubLinkedIssueRecord[] = []
  for (let page = 1; page <= Math.min(MAX_PAGES, 1); page++) {
    const url = `${apiBase}/repos/${repoPath(repo)}/issues?state=closed&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
    const items = await fetchJsonPage(client, url, headers, health)
    if (!items) break
    for (const item of items) {
      const pullReq = itemRecord(item.pull_request)
      if (pullReq) continue // skip PRs, the issues endpoint lists them too
      if (!attributedToLogin(item, login, 'user')) continue
      const closedAt = stringField(item, 'closed_at')
      if (!closedAt) continue
      const issueNumber = optionalNumber(numberField(item, 'number'))
      out.push({
        id: stringField(item, 'node_id') ?? String(numberField(item, 'id') ?? 0),
        repositoryId: repositoryId(repo),
        ...(issueNumber === undefined ? {} : { number: issueNumber }),
        closedAt,
      })
    }
    if (items.length < DEFAULT_PAGE_SIZE) break
    if (page === Math.min(MAX_PAGES, 1)) health.truncatedScans += 1
  }
  return out
}

async function fetchCheckRuns(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  health: FetchHealth,
  commitShas: readonly string[],
): Promise<GitHubCiCheckRecord[]> {
  const out: GitHubCiCheckRecord[] = []
  // CI checks are only ever awarded when they match a merged pull request, so
  // they are looked up from the merged PRs' head and merge SHAs rather than by
  // walking the default branch. The previous walk cost up to 3 commit pages and
  // then up to 3 check-run pages for each of up to 90 commits, per repository,
  // and the normalizer discarded every check that did not match a merged PR.
  // Looked up concurrently: awaiting one SHA at a time added a full round trip
  // of latency per merged pull request, which on its own could exceed the window
  // a serverless function is given.
  const perCommit = await mapWithConcurrency(
    commitShas.slice(0, MAX_CHECK_RUN_COMMITS),
    DETAIL_CONCURRENCY,
    async (commitSha) => {
    const checks: GitHubCiCheckRecord[] = []
    let fetchedCheckCount = 0
    let reportedCheckCount: number | undefined
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const checksUrl = `${apiBase}/repos/${repoPath(repo)}/commits/${encodeURIComponent(commitSha)}/check-runs?per_page=${DEFAULT_PAGE_SIZE}${page === 1 ? '' : `&page=${page}`}`
      const checksPage = await fetchCheckRunsPage(client, checksUrl, headers, health)
      if (!checksPage) break
      fetchedCheckCount += checksPage.items.length
      reportedCheckCount = checksPage.totalCount ?? reportedCheckCount
      for (const check of checksPage.items) {
        const conclusion = optionalString(stringField(check, 'conclusion'))
        const status = optionalString(stringField(check, 'status'))
        const checkName = optionalString(stringField(check, 'name'))
        const completedAt = stringField(check, 'completed_at')
        if (conclusion?.toLowerCase() !== 'success') continue
        if (!completedAt) continue
        checks.push({
          id: stringField(check, 'node_id') ?? String(numberField(check, 'id') ?? 0),
          repositoryId: repositoryId(repo),
          completedAt,
          conclusion,
          status,
          commitSha,
          ...(checkName ? { name: checkName } : {}),
        })
      }
      if (checksPage.items.length < DEFAULT_PAGE_SIZE) break
      if (reportedCheckCount !== undefined && fetchedCheckCount >= reportedCheckCount) break
    }
    return {
      checks,
      // A bounded scan must not claim to be complete when GitHub reports more
      // check runs than the adapter was able to read. This is truncation, not
      // failure: the unread checks belong to older PRs and can never be
      // awarded, because the baseline for this sync is `now`.
      truncated: reportedCheckCount !== undefined && fetchedCheckCount < reportedCheckCount,
    }
  })

  for (const result of perCommit) {
    out.push(...result.checks)
    if (result.truncated) health.truncatedScans += 1
  }
  return out
}

/** Upper bound on in-flight GitHub requests for one repository's details. */
const DETAIL_CONCURRENCY = 6

/**
 * Runs `worker` over `items` with a bounded number of requests in flight.
 *
 * The commit-detail lookup is inherently one request per commit, and awaiting
 * them one at a time costs roughly 200ms each: thirty commits across twenty-five
 * repositories is over two minutes of pure round-trip latency, well beyond the
 * window a serverless function is allowed to run. The bound keeps the burst
 * polite enough not to trip GitHub's secondary abuse limits.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runnerCount = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: runnerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

async function fetchUserCommits(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  login: string,
  health: FetchHealth,
): Promise<GitHubCommitRecord[]> {
  const out: GitHubCommitRecord[] = []
  const seenShas = new Set<string>()
  // Pass one: collect the commits worth reading. Listing is cheap; the detail
  // endpoint is the expensive part, because GitHub only returns `stats` there,
  // so one request per commit is unavoidable.
  const candidates: Array<{ sha: string; item: Record<string, unknown> }> = []
  for (const attributionField of ['author', 'committer'] as const) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${apiBase}/repos/${repoPath(repo)}/commits?${attributionField}=${encodeURIComponent(login)}&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
      const items = await fetchJsonPage(client, url, headers, health)
      if (!items) break
      for (const item of items) {
        const sha = stringField(item, 'sha')
        if (!sha || seenShas.has(sha) || !attributedCommitToLogin(item, login)) continue
        seenShas.add(sha)
        // Bounded on the count of commits *encountered*, not the count that
        // produced a record: a commit failing the stats or date check never
        // reaches the output, so capping on the output would leave the walk
        // unbounded. The ceiling costs nothing that could have been awarded,
        // because the baseline recorded for a sync is `now`.
        if (candidates.length >= MAX_COMMITS_PER_REPO) continue
        candidates.push({ sha, item })
      }
      if (items.length < DEFAULT_PAGE_SIZE) break
      if (page === MAX_PAGES) health.truncatedScans += 1
    }
  }

  // Pass two: fetch details with bounded concurrency rather than one await at a
  // time, which was the dominant wall-clock cost of a whole sync.
  const details = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, ({ sha, item }) =>
    recordWithStats(item)
      ? Promise.resolve(item)
      : fetchJsonObject(
          client,
          `${apiBase}/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
          headers,
          health,
        ),
  )

  for (let index = 0; index < candidates.length; index += 1) {
      const sha = (candidates[index] as { sha: string }).sha
      const detail = details[index]
      if (!detail) continue
      const commit = itemRecord(detail.commit)
      const author = commit ? itemRecord(commit.author) : null
      const committer = commit ? itemRecord(commit.committer) : null
      const occurredAt =
        stringField(author ?? {}, 'date') ??
        stringField(committer ?? {}, 'date') ??
        stringField(detail, 'created_at')
      if (!occurredAt) continue
      const stats = itemRecord(detail.stats)
      // Without GitHub's detail stats we cannot distinguish a meaningful
      // change from an empty or metadata-only commit, so fail closed.
      if (!stats) continue
      const additions = numberField(stats ?? {}, 'additions')
      const deletions = numberField(stats ?? {}, 'deletions')
      const files = Array.isArray(detail.files) ? detail.files : []
      // GitHub's `stats.total` is changed lines, not changed files. The file
      // list is the only accurate count for the provider-neutral contract.
      const changedFiles = files.length > 0
        ? files.length
        : additions === 0 && deletions === 0
          ? 0
          : null
      const changedPaths = files
        .map((file) => itemRecord(file))
        .map((file) => file ? stringField(file, 'filename') : null)
        .filter((filename): filename is string => filename !== null)
      const hasZeroStats =
        changedFiles === 0 && additions === 0 && deletions === 0
      out.push({
        id: sha,
        repositoryId: repositoryId(repo),
        occurredAt,
        ...(additions === null ? {} : { additions }),
        ...(deletions === null ? {} : { deletions }),
        ...(changedFiles === null ? {} : { changedFiles }),
        ...(changedPaths.length ? { changedPaths } : {}),
        isEmpty: hasZeroStats,
        contentChanged: !hasZeroStats,
      })
  }
  return out
}

async function fetchJsonPage(
  client: typeof fetch,
  url: string,
  headers: Record<string, string>,
  health: FetchHealth,
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const response = await withTimeout(client, url, headers)
    health.onRequest?.()
    if (!response.ok) {
      // An empty repository legitimately has no commits. GitHub answers 409
      // "Git Repository is empty." for it; treating that as a failed read
      // withheld the baseline for every brand-new repository.
      if (response.status === 409) {
        health.successfulRequests += 1
        return []
      }
      health.failedRequests += 1
      return null
    }
    const body: unknown = await response.json()
    if (!Array.isArray(body)) {
      health.failedRequests += 1
      return null
    }
    health.successfulRequests += 1
    return body.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
  } catch {
    health.failedRequests += 1
    return null
  }
}

async function fetchJsonObject(
  client: typeof fetch,
  url: string,
  headers: Record<string, string>,
  health: FetchHealth,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await withTimeout(client, url, headers)
    health.onRequest?.()
    if (!response.ok) {
      health.failedRequests += 1
      return null
    }
    const body: unknown = await response.json()
    const result = itemRecord(body)
    if (result) health.successfulRequests += 1
    else health.failedRequests += 1
    return result
  } catch {
    health.failedRequests += 1
    return null
  }
}

/** GitHub's check-runs list is wrapped in `{ check_runs: [...] }`. */
interface CheckRunsPage {
  items: Array<Record<string, unknown>>
  totalCount?: number
}

async function fetchCheckRunsPage(
  client: typeof fetch,
  url: string,
  headers: Record<string, string>,
  health: FetchHealth,
): Promise<CheckRunsPage | null> {
  try {
    const response = await withTimeout(client, url, headers)
    health.onRequest?.()
    if (!response.ok) {
      // No commits means no check runs; an empty repo is a successful empty read.
      if (response.status === 409) {
        health.successfulRequests += 1
        return { items: [] }
      }
      health.failedRequests += 1
      return null
    }
    const body: unknown = await response.json()
    const bodyRecord = itemRecord(body)
    const items = Array.isArray(body) ? body : bodyRecord?.check_runs
    if (!Array.isArray(items)) {
      health.failedRequests += 1
      return null
    }
    health.successfulRequests += 1
    const records = items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    const totalCount = bodyRecord ? numberField(bodyRecord, 'total_count') : null
    return {
      items: records,
      ...(totalCount === null ? {} : { totalCount }),
    }
  } catch {
    health.failedRequests += 1
    return null
  }
}

function itemRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringField(item: Record<string, unknown>, key: string): string | null {
  const value = item[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function numberField(item: Record<string, unknown>, key: string): number | null {
  const value = item[key]
  return typeof value === 'number' ? value : null
}

function booleanField(item: Record<string, unknown>, key: string): boolean | null {
  const value = item[key]
  return typeof value === 'boolean' ? value : null
}

function optionalString(value: string | null): string | undefined {
  return value === null ? undefined : value
}

function optionalNumber(value: number | null): number | undefined {
  return value === null ? undefined : value
}

function itemHeadSha(item: Record<string, unknown>): string | null {
  const head = itemRecord(item.head)
  return head ? stringField(head, 'sha') : null
}

function toRepoRef(value: string | GithubRepoRef): GithubRepoRef | null {
  if (typeof value === 'string') {
    const fullName = value.trim()
    return fullName ? { fullName } : null
  }
  const fullName = value.fullName.trim()
  return fullName ? { fullName, ...(value.id?.trim() ? { id: value.id.trim() } : {}) } : null
}

function repositoryId(repo: GithubRepoRef): string {
  return repo.id?.trim() || repo.fullName
}

function repoPath(repo: GithubRepoRef): string {
  return repo.fullName.split('/').map((part) => encodeURIComponent(part)).join('/')
}

function attributedToLogin(
  item: Record<string, unknown>,
  login: string,
  field: 'author' | 'user',
): boolean {
  const actor = itemRecord(item[field])
  const actorLogin = actor ? stringField(actor, 'login') : null
  // These list endpoints are not filtered to the signed-in user. Missing
  // attribution is therefore not evidence of ownership and must not receive a
  // server-issued product receipt.
  return actorLogin !== null && actorLogin.toLowerCase() === login.trim().toLowerCase()
}

function attributedCommitToLogin(item: Record<string, unknown>, login: string): boolean {
  const normalizedLogin = login.trim().toLowerCase()
  const authors = [itemRecord(item.author), itemRecord(item.committer)]
    .map((actor) => actor ? stringField(actor, 'login')?.toLowerCase() ?? null : null)
    .filter((actor): actor is string => actor !== null)
  // The list query is user-filtered, but a missing actor still leaves the
  // adapter without evidence to carry into a server-issued receipt. Fail
  // closed rather than crediting an unattributed commit.
  return authors.length > 0 && authors.includes(normalizedLogin)
}

function recordWithStats(item: Record<string, unknown>): Record<string, unknown> | null {
  return itemRecord(item.stats) ? item : null
}
