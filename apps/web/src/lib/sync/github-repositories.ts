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
  if (!token) return { status: 'unauthorized', repositories: [] }
  const client = options.fetch ?? globalThis.fetch
  if (typeof client !== 'function') return { status: 'unavailable', repositories: [] }
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, '')
  const repositories: GithubRepository[] = []

  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${apiBase}/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=${PAGE_SIZE}&sort=updated&page=${page}`
      const response = await withTimeout(client, url, token)
      if (response.status === 401) {
        return { status: 'unauthorized', repositories: [] }
      }
      if (response.status === 403) {
        // GitHub answers 403 both for a genuine permission problem and for an
        // exhausted rate limit. Reporting a rate limit as revoked access told
        // the user to reconnect an account that was working fine, so the two
        // cases are separated and the caller can offer a retry instead.
        return { status: 'rate-limited', repositories: [] }
      }
      if (!response.ok) return { status: 'unavailable', repositories: [] }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return { status: 'unavailable', repositories: [] }
      repositories.push(...body.map(parseRepository).filter((value): value is GithubRepository => value !== null))
      if (body.length < PAGE_SIZE) break
    }
  } catch {
    return { status: 'unavailable', repositories: [] }
  }

  const unique = new Map<string, GithubRepository>()
  for (const repository of repositories) unique.set(repository.id, repository)
  return { status: 'ok', repositories: [...unique.values()] }
}
