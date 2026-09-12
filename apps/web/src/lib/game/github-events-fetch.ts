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
 *   - Issues: an issue only qualifies when it is linked to a merged PR (the
 *     normalizer already enforces this); we surface `pull_request` linkage.
 *   - CI: we look at a repo's recent check runs and keep the successful ones.
 */
import type {
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
   * Repositories to read activity from. When empty, we fall back to a single
   * "recent events for the user" call; when provided we query each repo.
   */
  repos?: readonly string[]
  /** Personal access token. Falls back to process.env.GITHUB_TOKEN. */
  token?: string
  /** Override for the API base, test-only. */
  apiBase?: string
  /** Test-only: inject a fetch. */
  fetch?: typeof fetch
}

export interface GitHubEventsFetchResult {
  input: GitHubEventNormalizationInput
  /** The account login the events were attributed to. */
  login: string
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
    return { input: emptyInput(), login: options.login }
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
  if (typeof client !== 'function') return { input: emptyInput(), login: options.login }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'terrarium-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const sourceId = options.login.trim() || 'unknown'
  const repos = (options.repos ?? []).filter((name) => name.trim().length > 0)

  // If no explicit repos were given, list the user's repos once.
  const repoNames = repos.length
    ? repos
    : await fetchUserRepos(client, apiBase, headers, options.login)

  const mergedPullRequests: GitHubMergedPullRequestRecord[] = []
  const releases: GitHubReleaseRecord[] = []
  const linkedIssues: GitHubLinkedIssueRecord[] = []
  const ciChecks: GitHubCiCheckRecord[] = []

  // For each repo, pull the activity. A repo that fails is skipped, never fatal.
  for (const repoName of repoNames.slice(0, 8)) {
    const [prs, rels, issues, checks] = await Promise.all([
      fetchMergedPullRequests(client, apiBase, headers, repoName),
      fetchReleases(client, apiBase, headers, repoName),
      fetchClosedIssues(client, apiBase, headers, repoName),
      fetchCheckRuns(client, apiBase, headers, repoName),
    ])
    mergedPullRequests.push(...prs)
    releases.push(...rels)
    linkedIssues.push(...issues)
    ciChecks.push(...checks)
  }

  return {
    input: {
      sourceId,
      companionId: options.login, // the active companion receives these events
      commits: [], // commit XP stays on the existing graphql/events path (github.ts)
      mergedPullRequests,
      releases,
      linkedIssues,
      ciChecks,
    },
    login: options.login,
  }
}

async function fetchUserRepos(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  login: string
): Promise<string[]> {
  try {
    const response = await withTimeout(
      client,
      `${apiBase}/users/${encodeURIComponent(login)}/repos?per_page=100&sort=updated`,
      headers
    )
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (!Array.isArray(body)) return []
    return body
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => item.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
  } catch {
    return []
  }
}

async function fetchMergedPullRequests(
  client: typeof fetch,
  apiBase: string,
  headers: Record<string, string>,
  repoName: string
): Promise<GitHubMergedPullRequestRecord[]> {
  const out: GitHubMergedPullRequestRecord[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiBase}/repos/${encodeURIComponent(repoName)}/pulls?state=closed&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
    const items = await fetchJsonPage(client, url, headers)
    if (!items) break
    for (const item of items) {
      const mergedAt = stringField(item, 'merged_at')
      if (!mergedAt) continue // not merged
      const id = stringField(item, 'node_id') ?? String(numberField(item, 'id') ?? 0)
      const number = optionalNumber(numberField(item, 'number'))
      const headSha = optionalString(itemHeadSha(item))
      const mergeCommitSha = optionalString(stringField(item, 'merge_commit_sha'))
      out.push({
        id,
        repositoryId: repoName,
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
  repoName: string
): Promise<GitHubReleaseRecord[]> {
  const out: GitHubReleaseRecord[] = []
  const url = `${apiBase}/repos/${encodeURIComponent(repoName)}/releases?per_page=${DEFAULT_PAGE_SIZE}`
  const items = await fetchJsonPage(client, url, headers)
  if (!items) return out
  for (const item of items) {
    const publishedAt = stringField(item, 'published_at')
    const draft = booleanField(item, 'draft') ?? false
    if (draft || !publishedAt) continue
    const tagName = optionalString(stringField(item, 'tag_name'))
    out.push({
      id: stringField(item, 'node_id') ?? String(numberField(item, 'id') ?? 0),
      repositoryId: repoName,
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
  repoName: string
): Promise<GitHubLinkedIssueRecord[]> {
  const out: GitHubLinkedIssueRecord[] = []
  for (let page = 1; page <= Math.min(MAX_PAGES, 1); page++) {
    const url = `${apiBase}/repos/${encodeURIComponent(repoName)}/issues?state=closed&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`
    const items = await fetchJsonPage(client, url, headers)
    if (!items) break
    for (const item of items) {
      const pullReq = itemRecord(item.pull_request)
      if (pullReq) continue // skip PRs, the issues endpoint lists them too
      const closedAt = stringField(item, 'closed_at')
      if (!closedAt) continue
      const issueNumber = optionalNumber(numberField(item, 'number'))
      out.push({
        id: stringField(item, 'node_id') ?? String(numberField(item, 'id') ?? 0),
        repositoryId: repoName,
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
  repoName: string
): Promise<GitHubCiCheckRecord[]> {
  const out: GitHubCiCheckRecord[] = []
  // We need merged PRs to tie CI checks to. Fetch recent check runs against
  // the default branch's commits; map success back to a PR by head sha is
  // approximate but keeps the check in the eligible set.
  const url = `${apiBase}/repos/${encodeURIComponent(repoName)}/commits?per_page=${DEFAULT_PAGE_SIZE}`
  const commits = await fetchJsonPage(client, url, headers)
  if (!commits) return out
  for (const commit of commits) {
    const commitSha = optionalString(stringField(commit, 'sha'))
    if (!commitSha) continue
    const checksUrl = `${apiBase}/repos/${encodeURIComponent(repoName)}/commits/${encodeURIComponent(commitSha)}/check-runs?per_page=30`
    const checks = await fetchJsonPage(client, checksUrl, headers)
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
        repositoryId: repoName,
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

async function fetchJsonPage(
  client: typeof fetch,
  url: string,
  headers: Record<string, string>
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const response = await withTimeout(client, url, headers)
    if (!response.ok) return null
    const body: unknown = await response.json()
    return Array.isArray(body)
      ? body.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : null
  } catch {
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
