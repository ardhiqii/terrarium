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
 *   - Issues: closed user-authored issues are linked through their GitHub
 *     timeline cross-references and only linked PRs already proven as merged
 *     are passed to the normalizer.
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
 * costs one request. A bounded continuation window reads at most three pages
 * (180 candidates across the author and committer attribution lists) and carries
 * the next page forward when the window is full. The shortfall is reported as
 * truncation instead of being silently assumed complete.
 */
const MAX_COMMITS_PER_REPO = DEFAULT_PAGE_SIZE * MAX_PAGES * 2

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
  /** Existing per-repository checkpoints used to ignore old history before bounded pages. */
  baselineByRepositoryId?: Readonly<Record<string, string>>
  /** Signed continuation cursors from a prior incomplete catch-up. */
  continuation?: GithubEventsContinuation
}

export interface GithubRepoRef {
  readonly fullName: string
  readonly id?: string
}

/**
 * A bounded catch-up cursor. Page numbers are opaque server-issued state; a
 * retry resumes the next three pages instead of rereading the same full page
 * forever. The route signs this map before it reaches the browser.
 */
export interface GithubEventsContinuationCursor {
  /** Legacy cursor accepted for tokens minted before per-feed pages existed. */
  readonly page?: number
  readonly commitsPageByAttribution?: Readonly<Partial<Record<'author' | 'committer', number>>>
  readonly pullRequestsPage?: number
  readonly releasesPage?: number
  readonly issuesPage?: number
  readonly issueTimelinePages?: Readonly<Record<string, number>>
  readonly checkRunsPageBySha?: Readonly<Record<string, number>>
  readonly pendingCheckShas?: readonly string[]
}

export type GithubEventsContinuation = Readonly<Record<string, GithubEventsContinuationCursor>>

export type GithubEventsFetchStatus = 'ok' | 'partial' | 'unavailable'

interface PagedFetchResult<T> {
  readonly items: readonly T[]
  readonly truncated: boolean
  readonly nextPage?: number
}

interface IssueFetchResult {
  readonly items: readonly GitHubLinkedIssueRecord[]
  readonly truncated: boolean
  readonly nextPage?: number
  readonly issueTimelinePages: Readonly<Record<string, number>>
}

interface CommitFetchResult {
  readonly items: readonly GitHubCommitRecord[]
  readonly truncated: boolean
  readonly nextPage?: Readonly<Partial<Record<'author' | 'committer', number>>>
}

interface CheckFetchResult {
  readonly items: readonly GitHubCiCheckRecord[]
  readonly truncated: boolean
  readonly checkRunsPageBySha: Readonly<Record<string, number>>
  readonly pendingCheckShas: readonly string[]
}

export interface GitHubEventsFetchResult {
  input: GitHubEventNormalizationInput
  /** The account login the events were attributed to. */
  login: string
  status: GithubEventsFetchStatus
  /**
   * True when a bounded scan reached its page ceiling with a full final page, so
   * the adapter cannot honestly claim to have read the whole history.
   *
   * Truncation remains an adapter-level status detail so callers can show the
   * bounded window, but the sync route treats it as retryable incomplete work
   * and does not advance a baseline or mint a checkpoint. A caller that has a
   * durable continuation can choose to resume; this route currently asks the
   * user to retry or narrow the tracked sources.
   */
  truncated: boolean
  /** Next bounded page window when the read is incomplete. */
  continuation?: GithubEventsContinuation
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
  const nextContinuation: Record<string, GithubEventsContinuationCursor> = {}

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
    const baseline = repo.id === undefined
      ? undefined
      : options.baselineByRepositoryId?.[repo.id]
    const cursorKey = repositoryId(repo)
    const cursor = options.continuation?.[cursorKey]
    const legacyPage = Math.max(1, Math.floor(cursor?.page ?? 1))
    const pullRequestPage = Math.max(1, Math.floor(cursor?.pullRequestsPage ?? legacyPage))
    const releasePage = Math.max(1, Math.floor(cursor?.releasesPage ?? legacyPage))
    const issuePage = Math.max(1, Math.floor(cursor?.issuesPage ?? legacyPage))
    const prs = await fetchMergedPullRequests(
      client, apiBase, headers, repo, options.login, health, baseline, pullRequestPage,
    )
    const [repoCommits, rels, issues, checks] = await Promise.all([
      fetchUserCommits(client, apiBase, headers, repo, options.login, health, baseline, cursor?.commitsPageByAttribution),
      fetchReleases(client, apiBase, headers, repo, options.login, health, baseline, releasePage),
      fetchClosedIssues(
        client, apiBase, headers, repo, options.login, health, prs.items, baseline, issuePage,
        cursor?.issueTimelinePages,
      ),
      fetchCheckRuns(
        client, apiBase, headers, repo, health,
        cursor?.pendingCheckShas && cursor.pendingCheckShas.length > 0
          ? [...cursor.pendingCheckShas, ...Object.keys(cursor.checkRunsPageBySha ?? {})]
          : mergedPullRequestShas(prs.items),
        cursor?.checkRunsPageBySha,
      ),
    ])
    const retryPullRequestPageForTimeline = Object.keys(issues.issueTimelinePages).length > 0
    const retryPullRequestPageForChecks = checks.pendingCheckShas.length > 0 || Object.keys(checks.checkRunsPageBySha).length > 0
    const nextCursor: GithubEventsContinuationCursor = {
      ...(retryPullRequestPageForTimeline || retryPullRequestPageForChecks
        ? { pullRequestsPage: pullRequestPage }
        : prs.nextPage
          ? { pullRequestsPage: prs.nextPage }
          : {}),
      ...(rels.nextPage ? { releasesPage: rels.nextPage } : {}),
      ...(repoCommits.nextPage ? { commitsPageByAttribution: repoCommits.nextPage } : {}),
      ...(issues.nextPage ? { issuesPage: issues.nextPage } : {}),
      ...(Object.keys(issues.issueTimelinePages).length > 0 ? { issueTimelinePages: issues.issueTimelinePages } : {}),
      ...(Object.keys(checks.checkRunsPageBySha).length > 0 ? { checkRunsPageBySha: checks.checkRunsPageBySha } : {}),
      ...(checks.pendingCheckShas.length > 0 ? { pendingCheckShas: checks.pendingCheckShas } : {}),
    }
    if (Object.keys(nextCursor).length > 0) nextContinuation[cursorKey] = nextCursor
    commits.push(...repoCommits.items)
    mergedPullRequests.push(...prs.items)
    releases.push(...rels.items)
    linkedIssues.push(...issues.items)
    ciChecks.push(...checks.items)
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
    ...(Object.keys(nextContinuation).length > 0 ? { continuation: nextContinuation } : {}),
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

function isAfterBaseline(timestamp: string, baseline?: string): boolean {
  if (!baseline) return true
  const eventTime = Date.parse(timestamp)
  const baselineTime = Date.parse(baseline)
  // GitHub activity timestamps have second precision, while our checkpoint
  // carries milliseconds. Re-read the boundary second; stable event IDs make
  // that overlap idempotent and prevent a same-second event from being lost.
  const boundary = Number.isFinite(baselineTime) ? Math.floor(baselineTime / 1000) * 1000 : Number.NaN
  return Number.isFinite(eventTime) && Number.isFinite(boundary)
    ? eventTime >= boundary
    : true
}

function commitListTimestamp(item: Record<string, unknown>): string {
  const commit = itemRecord(item.commit)
  const author = commit ? itemRecord(commit.author) : null
  const committer = commit ? itemRecord(commit.committer) : null
  return stringField(author ?? {}, 'date') ??
    stringField(committer ?? {}, 'date') ??
    stringField(item, 'created_at') ?? ''
}

async function fetchMergedPullRequests(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  login: string,
  health: FetchHealth,
  baseline?: string,
  startPage = 1,
): Promise<PagedFetchResult<GitHubMergedPullRequestRecord>> {
  const out: GitHubMergedPullRequestRecord[] = []
  let nextPage: number | undefined
  for (let page = startPage; page < startPage + MAX_PAGES; page++) {
    const url = `${apiBase}/repos/${repoPath(repo)}/pulls?state=closed&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
    const items = await fetchJsonPage(client, url, headers, health)
    if (!items) break
    for (const item of items) {
      if (!attributedToLogin(item, login, 'user')) continue
      const mergedAt = stringField(item, 'merged_at')
      if (!mergedAt || !isAfterBaseline(mergedAt, baseline)) continue // not merged or already checkpointed
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
    if (page === startPage + MAX_PAGES - 1) {
      health.truncatedScans += 1
      nextPage = page + 1
    }
  }
  return { items: out, truncated: nextPage !== undefined, ...(nextPage ? { nextPage } : {}) }
}

async function fetchReleases(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  login: string,
  health: FetchHealth,
  baseline?: string,
  startPage = 1,
): Promise<PagedFetchResult<GitHubReleaseRecord>> {
  const out: GitHubReleaseRecord[] = []
  let nextPage: number | undefined
  for (let page = startPage; page < startPage + MAX_PAGES; page += 1) {
    const url = `${apiBase}/repos/${repoPath(repo)}/releases?per_page=${DEFAULT_PAGE_SIZE}${page === 1 ? '' : `&page=${page}`}`
    const items = await fetchJsonPage(client, url, headers, health)
    if (!items) break
    for (const item of items) {
      if (!attributedToLogin(item, login, 'author')) continue
      const publishedAt = stringField(item, 'published_at')
      const draft = booleanField(item, 'draft') ?? false
      if (draft || !publishedAt || !isAfterBaseline(publishedAt, baseline)) continue
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
    if (items.length < DEFAULT_PAGE_SIZE) break
    if (page === startPage + MAX_PAGES - 1) {
      health.truncatedScans += 1
      nextPage = page + 1
    }
  }
  return { items: out, truncated: nextPage !== undefined, ...(nextPage ? { nextPage } : {}) }
}

async function fetchClosedIssues(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  login: string,
  health: FetchHealth,
  mergedPullRequests: readonly GitHubMergedPullRequestRecord[],
  baseline?: string,
  startPage = 1,
  issueTimelinePages: Readonly<Record<string, number>> = {},
): Promise<IssueFetchResult> {
  const candidates: Array<{ item: Record<string, unknown>; issueNumber: number; closedAt: string }> = []
  let nextPage: number | undefined
  let pendingTimeline = false
  const nextIssueTimelinePages: Record<string, number> = {}
  for (let page = startPage; page < startPage + MAX_PAGES; page++) {
    const url = `${apiBase}/repos/${repoPath(repo)}/issues?state=closed&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
    const items = await fetchJsonPage(client, url, headers, health)
    if (!items) break
    for (const item of items) {
      const pullReq = itemRecord(item.pull_request)
      if (pullReq) continue // skip PRs, the issues endpoint lists them too
      if (!attributedToLogin(item, login, 'user')) continue
      const closedAt = stringField(item, 'closed_at')
      const issueNumber = numberField(item, 'number')
      if (!closedAt || !isAfterBaseline(closedAt, baseline) || issueNumber === null) continue
      candidates.push({ item, issueNumber, closedAt })
    }
    if (items.length < DEFAULT_PAGE_SIZE) break
    if (page === startPage + MAX_PAGES - 1) {
      health.truncatedScans += 1
      nextPage = page + 1
    }
  }

  const mergedById = new Map<string, GitHubMergedPullRequestRecord>()
  for (const pullRequest of mergedPullRequests) {
    mergedById.set(pullRequest.id, pullRequest)
    if (pullRequest.number !== undefined) mergedById.set(String(pullRequest.number), pullRequest)
  }
  const linked = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, async ({ item, issueNumber, closedAt }): Promise<GitHubLinkedIssueRecord | null> => {
    const timeline = await fetchIssueTimeline(
      client,
      apiBase,
      headers,
      repo,
      issueNumber,
      health,
      Math.max(1, Math.floor(issueTimelinePages[String(issueNumber)] ?? 1)),
    )
    if (timeline.truncated && timeline.nextPage) {
      pendingTimeline = true
      nextIssueTimelinePages[String(issueNumber)] = timeline.nextPage
    }
    const linkedPullRequestIds = [...new Set(timeline.items.flatMap((id) => {
      const pullRequest = mergedById.get(id)
      return pullRequest
        ? [pullRequest.id, ...(pullRequest.number === undefined ? [] : [String(pullRequest.number)])]
        : []
    }))]
    if (linkedPullRequestIds.length === 0) return null
    return {
      id: stringField(item, 'node_id') ?? String(numberField(item, 'id') ?? 0),
      repositoryId: repositoryId(repo),
      number: issueNumber,
      closedAt,
      linkedPullRequestIds,
      linkedPullRequestId: linkedPullRequestIds[0],
    }
  })
  const items = linked.filter((issue): issue is GitHubLinkedIssueRecord => issue !== null)
  return {
    items,
    // Revisit the same issue page until its nested timeline cursor clears; a
    // page cursor alone would skip the issue whose older cross-reference is
    // still pending.
    ...(pendingTimeline
      ? { nextPage: startPage }
      : nextPage
        ? { nextPage }
        : {}),
    truncated: pendingTimeline || nextPage !== undefined,
    issueTimelinePages: nextIssueTimelinePages,
  }
}

/** Read issue timeline cross-references and return source issue IDs that
 * represent pull requests. The normalizer intersects these IDs with the
 * merged PR records already fetched for this repository. */
async function fetchIssueTimeline(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  issueNumber: number,
  health: FetchHealth,
  startPage = 1,
): Promise<PagedFetchResult<string>> {
  const ids = new Set<string>()
  let nextPage: number | undefined
  for (let page = startPage; page < startPage + MAX_PAGES; page += 1) {
    const url = `${apiBase}/repos/${repoPath(repo)}/issues/${issueNumber}/timeline?per_page=${DEFAULT_PAGE_SIZE}${page === 1 ? '' : `&page=${page}`}`
    const items = await fetchJsonPage(client, url, headers, health)
    if (!items) return { items: [...ids], truncated: false }
    for (const item of items) {
      const source = itemRecord(item.source)
      const sourceIssue = source ? itemRecord(source.issue) : null
      const pullRequest = sourceIssue ? itemRecord(sourceIssue.pull_request) : null
      if (!sourceIssue || !pullRequest) continue
      const id = stringField(sourceIssue, 'node_id') ?? stringField(pullRequest, 'node_id') ?? String(numberField(sourceIssue, 'id') ?? numberField(pullRequest, 'id') ?? '')
      if (id) ids.add(id)
      const number = numberField(sourceIssue, 'number') ?? numberField(pullRequest, 'number')
      if (number !== null) ids.add(String(number))
    }
    if (items.length < DEFAULT_PAGE_SIZE) break
    if (page === startPage + MAX_PAGES - 1) {
      health.truncatedScans += 1
      nextPage = page + 1
    }
  }
  return { items: [...ids], truncated: nextPage !== undefined, ...(nextPage ? { nextPage } : {}) }
}

async function fetchCheckRuns(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  health: FetchHealth,
  commitShas: readonly string[],
  pageBySha: Readonly<Record<string, number>> = {},
): Promise<CheckFetchResult> {
  const out: GitHubCiCheckRecord[] = []
  const uniqueShas = [...new Set(commitShas.filter((sha) => sha.trim().length > 0))]
  const selectedShas = uniqueShas.slice(0, MAX_CHECK_RUN_COMMITS)
  const pendingCheckShas = uniqueShas.slice(MAX_CHECK_RUN_COMMITS)
  const nextPageBySha: Record<string, number> = {}
  if (pendingCheckShas.length > 0) health.truncatedScans += 1
  // CI checks are only ever awarded when they match a merged pull request, so
  // they are looked up from the merged PRs' head and merge SHAs rather than by
  // walking the default branch. The previous walk cost up to 3 commit pages and
  // then up to 3 check-run pages for each of up to 90 commits, per repository,
  // and the normalizer discarded every check that did not match a merged PR.
  // Looked up concurrently: awaiting one SHA at a time added a full round trip
  // of latency per merged pull request, which on its own could exceed the window
  // a serverless function is given.
  const perCommit = await mapWithConcurrency(
    selectedShas,
    DETAIL_CONCURRENCY,
    async (commitSha) => {
    const checks: GitHubCiCheckRecord[] = []
    let fetchedCheckCount = 0
    let reportedCheckCount: number | undefined
    let nextPage: number | undefined
    const startPage = Math.max(1, Math.floor(pageBySha[commitSha] ?? 1))
    for (let page = startPage; page < startPage + MAX_PAGES; page += 1) {
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
      if (page === startPage + MAX_PAGES - 1) {
        nextPage = page + 1
      }
    }
    const countTruncated = reportedCheckCount !== undefined && fetchedCheckCount < reportedCheckCount
    if (countTruncated && nextPage === undefined) nextPage = startPage + MAX_PAGES
    const truncated = nextPage !== undefined || countTruncated
    return {
      checks,
      truncated,
      ...(truncated && nextPage ? { nextPage } : {}),
    }
  })

  for (let index = 0; index < perCommit.length; index += 1) {
    const result = perCommit[index]
    if (!result) continue
    out.push(...result.checks)
    const sha = selectedShas[index]
    if (result.truncated) health.truncatedScans += 1
    if (result.truncated && sha && result.nextPage) nextPageBySha[sha] = result.nextPage
  }
  return {
    items: out,
    truncated: pendingCheckShas.length > 0 || Object.keys(nextPageBySha).length > 0,
    checkRunsPageBySha: nextPageBySha,
    pendingCheckShas,
  }
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
  baseline?: string,
  pageByAttribution: Readonly<Partial<Record<'author' | 'committer', number>>> = {},
): Promise<CommitFetchResult> {
  const out: GitHubCommitRecord[] = []
  const nextPageByAttribution: Partial<Record<'author' | 'committer', number>> = {}
  const seenShas = new Set<string>()
  // Pass one: collect the commits worth reading. Listing is cheap; the detail
  // endpoint is the expensive part, because GitHub only returns `stats` there,
  // so one request per commit is unavoidable.
  const candidates: Array<{ sha: string; item: Record<string, unknown> }> = []
  let candidateOverflow = false
  for (const attributionField of ['author', 'committer'] as const) {
    const startPage = Math.max(1, Math.floor(pageByAttribution[attributionField] ?? 1))
    for (let page = startPage; page < startPage + MAX_PAGES; page += 1) {
      const url = `${apiBase}/repos/${repoPath(repo)}/commits?${attributionField}=${encodeURIComponent(login)}&per_page=${DEFAULT_PAGE_SIZE}&page=${page}${baseline ? `&since=${encodeURIComponent(baseline)}` : ''}`
      const items = await fetchJsonPage(client, url, headers, health)
      if (!items) break
      for (const item of items) {
        const sha = stringField(item, 'sha')
        const occurredAt = commitListTimestamp(item)
        if (!sha || seenShas.has(sha) || !attributedCommitToLogin(item, login) || !isAfterBaseline(occurredAt, baseline)) continue
        seenShas.add(sha)
        // Bounded on the count of commits *encountered*, not the count that
        // produced a record: a commit failing the stats or date check never
        // reaches the output, so capping on the output would leave the walk
        // unbounded. The ceiling costs nothing that could have been awarded,
        // because the baseline recorded for a sync is `now`.
        if (candidates.length >= MAX_COMMITS_PER_REPO) {
          candidateOverflow = true
          continue
        }
        candidates.push({ sha, item })
      }
      if (items.length < DEFAULT_PAGE_SIZE) break
      if (page === startPage + MAX_PAGES - 1) {
        health.truncatedScans += 1
        nextPageByAttribution[attributionField] = page + 1
      }
    }
  }

  if (candidateOverflow) health.truncatedScans += 1

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
  return {
    items: out,
    truncated: candidateOverflow || Object.keys(nextPageByAttribution).length > 0,
    ...(Object.keys(nextPageByAttribution).length > 0 ? { nextPage: nextPageByAttribution } : {}),
  }
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
