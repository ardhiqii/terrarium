/**
 * Fetches a GitHub user's repo listing (name, language, age, size) at build
 * time, cached to JSON, so `/companions`'s collection view and the
 * `/api/creatures` route can enumerate "every repo creature you have"
 * without re-listing on every request.
 *
 * Mirrors `github.ts`'s conventions deliberately: never throws, returns
 * `null` on any failure, and prefers a stale on-disk cache over a network
 * failure rather than returning nothing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface RepoSummary {
  name: string
  language: string | null
  createdAt: string | null
  pushedAt: string | null
  sizeKb: number | null
  fork: boolean
}

interface RepoListCache {
  login: string
  repos: RepoSummary[]
  fetchedAt: string
}

const DEFAULT_CACHE_PATH = path.join(
  /*turbopackIgnore: true*/ process.cwd(),
  'web/src/lib/game/repos-cache.json'
)
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours, matches github.ts
const DEFAULT_API_BASE = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 10_000
const PER_PAGE = 100
/** How many repos a build ever iterates for the collection view. */
export const MAX_COLLECTION_REPOS = 24

export interface RepoListOptions {
  login: string
  token?: string
  cachePath?: string
  maxAgeMs?: number
  apiBase?: string
}

export function readRepoListCache(cachePath?: string): RepoListCache | null {
  const resolved = cachePath ?? DEFAULT_CACHE_PATH
  try {
    if (!existsSync(resolved)) return null
    const raw = readFileSync(resolved, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isValidRepoListCache(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function writeRepoListCache(cache: RepoListCache, cachePath: string): void {
  try {
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8')
  } catch {
    // Best-effort, same rationale as github.ts: a failed write must never
    // break the build.
  }
}

/**
 * Never throws. Returns `null` when nothing usable is available at all
 * (no cache, network unreachable). Repos are sorted by `pushedAt` descending
 * (most recently active first, matching GitHub's own default repo list
 * ordering) and capped at `MAX_COLLECTION_REPOS` so a build never has to
 * walk an unbounded number of repos to build the collection.
 */
export async function fetchOwnerRepos(
  options: RepoListOptions
): Promise<RepoSummary[] | null> {
  try {
    return await fetchOwnerReposInner(options)
  } catch {
    return null
  }
}

async function fetchOwnerReposInner(
  options: RepoListOptions
): Promise<RepoSummary[] | null> {
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const apiBase = options.apiBase ?? DEFAULT_API_BASE
  const token = options.token ?? process.env.GITHUB_TOKEN

  const cached = readRepoListCache(cachePath)
  if (cached && cached.login.toLowerCase() === options.login.toLowerCase()) {
    const cachedAt = Date.parse(cached.fetchedAt)
    const age = Number.isFinite(cachedAt) ? Date.now() - cachedAt : Infinity
    if (age < maxAgeMs) return cached.repos
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'digital-garden-creature-build',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const url = `${apiBase}/users/${encodeURIComponent(options.login)}/repos?per_page=${PER_PAGE}&sort=pushed&type=owner`

  let response: Response
  try {
    response = await fetchWithTimeout(url, headers)
  } catch {
    return cached && cached.login.toLowerCase() === options.login.toLowerCase()
      ? cached.repos
      : null
  }

  if (!response.ok) {
    return cached && cached.login.toLowerCase() === options.login.toLowerCase()
      ? cached.repos
      : null
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    return null
  }
  if (!Array.isArray(json)) return null

  const repos: RepoSummary[] = []
  for (const raw of json) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.name !== 'string') continue
    // Forks are excluded: they are not the repo creature's own history, and
    // showing someone else's project as your specimen would be misleading.
    if (r.fork === true) continue

    repos.push({
      name: r.name,
      language: typeof r.language === 'string' ? r.language : null,
      createdAt: typeof r.created_at === 'string' ? r.created_at : null,
      pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : null,
      sizeKb: typeof r.size === 'number' ? r.size : null,
      fork: false,
    })
  }

  const capped = repos.slice(0, MAX_COLLECTION_REPOS)

  const cache: RepoListCache = {
    login: options.login,
    repos: capped,
    fetchedAt: new Date().toISOString(),
  }
  writeRepoListCache(cache, cachePath)

  return capped
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

function isValidRepoListCache(value: unknown): value is RepoListCache {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.login !== 'string') return false
  if (typeof v.fetchedAt !== 'string' || Number.isNaN(Date.parse(v.fetchedAt))) return false
  if (!Array.isArray(v.repos)) return false
  return v.repos.every(isValidRepoSummary)
}

function isValidRepoSummary(value: unknown): value is RepoSummary {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    (v.language === null || typeof v.language === 'string') &&
    (v.createdAt === null || typeof v.createdAt === 'string') &&
    (v.pushedAt === null || typeof v.pushedAt === 'string') &&
    (v.sizeKb === null || typeof v.sizeKb === 'number') &&
    typeof v.fork === 'boolean'
  )
}
