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
}

interface FetchHealth {
  successfulRequests: number
  failedRequests: number
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
    return { input: emptyInput(), login: options.login, status: 'unavailable' }
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
  const client = options.fetch ?? globalThis.fetch
  if (typeof client !== 'function') return { input: emptyInput(), login: options.login, status: 'unavailable' }
  const health: FetchHealth = { successfulRequests: 0, failedRequests: 0 }

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

  // For each repo, pull the activity. A repo that fails is skipped, never fatal.
  for (const repo of repoRefs) {
    const [repoCommits, prs, rels, issues, checks] = await Promise.all([
      fetchUserCommits(client, apiBase, headers, repo, options.login, health),
      fetchMergedPullRequests(client, apiBase, headers, repo, options.login, health),
      fetchReleases(client, apiBase, headers, repo, options.login, health),
      fetchClosedIssues(client, apiBase, headers, repo, options.login, health),
      fetchCheckRuns(client, apiBase, headers, repo, health),
    ])
    commits.push(...repoCommits)
    mergedPullRequests.push(...prs)
    releases.push(...rels)
    linkedIssues.push(...issues)
    ciChecks.push(...checks)
  }

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
  }
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
  }
  return out
}

async function fetchCheckRuns(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repo: GithubRepoRef,
  health: FetchHealth,
): Promise<GitHubCiCheckRecord[]> {
  const out: GitHubCiCheckRecord[] = []
  // We need merged PRs to tie CI checks to. Fetch recent check runs against
  // the default branch's commits; map success back to a PR by head sha is
  // approximate but keeps the check in the eligible set.
  const url = `${apiBase}/repos/${repoPath(repo)}/commits?per_page=${DEFAULT_PAGE_SIZE}`
  const commits = await fetchJsonPage(client, url, headers, health)
  if (!commits) return out
  for (const commit of commits) {
    const commitSha = optionalString(stringField(commit, 'sha'))
    if (!commitSha) continue
    const checksUrl = `${apiBase}/repos/${repoPath(repo)}/commits/${encodeURIComponent(commitSha)}/check-runs?per_page=30`
    const checks = await fetchJsonPage(client, checksUrl, headers, health)
    if (!checks) continue
    for (const check of checks) {
      const conclusion = optionalString(stringField(check, 'conclusion'))
      const status = optionalString(stringField(check, 'status'))
      const checkName = optionalString(stringField(check, 'name'))
      const completedAt = stringField(check, 'completed_at')
      if (conclusion?.toLowerCase() !== 'success') continue
      if (!completedAt) continue
      out.push({
        id: stringField(check, 'node_id') ?? String(numberField(check, 'id') ?? 0),
        repositoryId: repositoryId(repo),
        completedAt,
        conclusion,
        status,
        commitSha: commitSha,
        ...(checkName ? { name: checkName } : {}),
      })
    }
  }
  return out
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
  for (const attributionField of ['author', 'committer'] as const) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${apiBase}/repos/${repoPath(repo)}/commits?${attributionField}=${encodeURIComponent(login)}&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
      const items = await fetchJsonPage(client, url, headers, health)
      if (!items) break
      for (const item of items) {
      const sha = stringField(item, 'sha')
      if (!sha || seenShas.has(sha) || !attributedCommitToLogin(item, login)) continue
      seenShas.add(sha)
      const detail = recordWithStats(item)
        ? item
        : await fetchJsonObject(
            client,
            `${apiBase}/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
            headers,
            health,
          )
      if (!detail) continue
      const commit = itemRecord(detail.commit)
      const author = commit ? itemRecord(commit.author) : null
      const committer = commit ? itemRecord(commit.committer) : null
      const occurredAt =
        stringField(author ?? {}, 'date') ??
        stringField(committer ?? {}, 'date') ??
        stringField(item, 'created_at')
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
      if (items.length < DEFAULT_PAGE_SIZE) break
    }
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
    if (!response.ok) {
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
  // Real GitHub REST responses include this field. The permissive fallback is
  // useful for provider fixtures and does not weaken live attribution.
  return actorLogin === null || actorLogin.toLowerCase() === login.trim().toLowerCase()
}

function attributedCommitToLogin(item: Record<string, unknown>, login: string): boolean {
  const normalizedLogin = login.trim().toLowerCase()
  const authors = [itemRecord(item.author), itemRecord(item.committer)]
    .map((actor) => actor ? stringField(actor, 'login')?.toLowerCase() ?? null : null)
    .filter((actor): actor is string => actor !== null)
  // GitHub normally supplies at least one linked actor. The fallback keeps
  // fixture/provider adapters useful when a source only supplies a SHA; live
  // activity is still constrained by the `author=login` API query.
  return authors.length === 0 || authors.includes(normalizedLogin)
}

function recordWithStats(item: Record<string, unknown>): Record<string, unknown> | null {
  return itemRecord(item.stats) ? item : null
}
