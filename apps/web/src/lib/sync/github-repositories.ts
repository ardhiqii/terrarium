/**
 * GitHub repository discovery at the provider boundary.
 *
 * This endpoint only lists repositories and permission/visibility facts. It
 * never reads a repository tree, file, description, or issue body. The stable
 * numeric repository ID is what the settings store tracks, so a rename does
 * not silently create a new source.
 */

const DEFAULT_API_BASE = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 10_000
const PAGE_SIZE = 100
const MAX_PAGES = 5

export type GithubRepositoryOwnerType = 'User' | 'Organization'

export interface GithubRepository {
  readonly id: string
  readonly name: string
  readonly fullName: string
  readonly ownerLogin: string
  readonly ownerType: GithubRepositoryOwnerType
  readonly private: boolean
  readonly visibility: string
  readonly defaultBranch: string | null
  readonly archived: boolean
  readonly canRead: boolean
}

export type GithubRepositoryFetchStatus = 'ok' | 'unauthorized' | 'rate-limited' | 'unavailable'

export interface GithubRepositoryFetchResult {
  readonly status: GithubRepositoryFetchStatus
  readonly repositories: readonly GithubRepository[]
  /**
   * True when the paged walk ended on a full final page at `MAX_PAGES`.
   *
   * A truncated listing is still a successful read -- it holds every repository
   * the newest-first pages exposed -- but it is NOT a completeness proof. A
   * 501+-repository account receives 500 repositories here; treating that as
   * "the account has exactly these" would delete the sync baseline of every
   * tracked repository past page 5 and re-baseline its activity as new work.
   * Callers must skip pruning and unselection on it, exactly as for a stale
   * listing.
   */
  readonly truncated: boolean
}

export interface FetchGithubRepositoriesOptions {
  token: string
  apiBase?: string
  fetch?: typeof fetch
}

function withTimeout(client: typeof fetch, url: string, token: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  return client(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'terrarium-sync',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field.trim() : null
}

function booleanField(value: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof value[key] === 'boolean' ? value[key] as boolean : fallback
}

function parseRepository(value: unknown): GithubRepository | null {
  const item = record(value)
  const owner = item ? record(item.owner) : null
  const id = item && typeof item.id === 'number' && Number.isSafeInteger(item.id)
    ? String(item.id)
    : null
  const name = item ? stringField(item, 'name') : null
  const fullName = item ? stringField(item, 'full_name') : null
  const ownerLogin = owner ? stringField(owner, 'login') : null
  if (!id || !name || !fullName || !ownerLogin) return null
  const ownerType = owner?.type === 'Organization' ? 'Organization' : 'User'
  const permissions = item ? record(item.permissions) : null
  const canRead = permissions
    ? permissions.pull === true || permissions.push === true || permissions.admin === true
    : true

  return {
    id,
    name,
    fullName,
    ownerLogin,
    ownerType,
    private: booleanField(item!, 'private', false),
    visibility: stringField(item!, 'visibility') ?? (booleanField(item!, 'private', false) ? 'private' : 'public'),
    defaultBranch: stringField(item!, 'default_branch'),
    archived: booleanField(item!, 'archived', false),
    canRead,
  }
}

/** Never throws: a revoked token or a temporary GitHub failure becomes a UI status. */
export async function fetchGithubRepositories(
  options: FetchGithubRepositoriesOptions,
): Promise<GithubRepositoryFetchResult> {
  const token = options.token.trim()
  if (!token) return { status: 'unauthorized', repositories: [], truncated: false }
  const client = options.fetch ?? globalThis.fetch
  if (typeof client !== 'function') return { status: 'unavailable', repositories: [], truncated: false }
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, '')
  const repositories: GithubRepository[] = []
  let truncated = false
  /** GitHub's own pagination signal; a short page with `rel="next"` has more. */
  const hasNextPage = (response: Response): boolean =>
    /rel="?next"?/u.test(response.headers.get('link') ?? '')

  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${apiBase}/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=${PAGE_SIZE}&sort=updated&page=${page}`
      const response = await withTimeout(client, url, token)
      if (response.status === 401) {
        return { status: 'unauthorized', repositories: [], truncated: false }
      }
      if (response.status === 403) {
        // GitHub answers 403 both for a genuine permission problem and for an
        // exhausted rate limit. Reporting a rate limit as revoked access told
        // the user to reconnect an account that was working fine, so the two
        // cases are separated and the caller can offer a retry instead.
        return { status: 'rate-limited', repositories: [], truncated: false }
      }
      if (!response.ok) return { status: 'unavailable', repositories: [], truncated: false }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return { status: 'unavailable', repositories: [], truncated: false }
      repositories.push(...body.map(parseRepository).filter((value): value is GithubRepository => value !== null))
      // A short page is only the last page when GitHub does not advertise a
      // successor. `sort=updated` pagination is unstable, so a page can come
      // back short while later pages still exist; trusting the length alone
      // would report the listing COMPLETE and let the sync prune delete the
      // baseline of a repository the walk never reached.
      const morePages = hasNextPage(response)
      if (!morePages && body.length < PAGE_SIZE) break
      // A full page -- or an advertised successor -- on the last allowed page
      // means there may be repositories we did not request. The listing is
      // usable, but it is not a completeness proof.
      if (page === MAX_PAGES) truncated = body.length >= PAGE_SIZE || morePages
    }
  } catch {
    return { status: 'unavailable', repositories: [], truncated: false }
  }

  const unique = new Map<string, GithubRepository>()
  for (const repository of repositories) unique.set(repository.id, repository)
  return { status: 'ok', repositories: [...unique.values()], truncated }
}
