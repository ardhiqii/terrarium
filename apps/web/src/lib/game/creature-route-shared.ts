/**
 * Shared helpers for `apps/web/src/app/api/creature/route.ts` and
 * `apps/web/src/app/api/creature.svg/route.ts`.
 *
 * These two routes both resolve an arbitrary GitHub handle (and optionally
 * a repo) to a `CreatureState`, and both need the same disk-cache path, the
 * same GitHub existence checks, and the same request-shape validation to
 * stay in sync. Before this module existed, each route defined its own copy
 * of `diskCachePathFor` independently. Identical today, but nothing enforced
 * that: if the two implementations had ever drifted, the badge route and the
 * JSON API route would compute different cache paths for the same handle
 * and silently double the upstream GitHub calls. Extracting to one module
 * makes that divergence impossible rather than merely unlikely.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cacheGetFresh, cacheSet } from '@/lib/game/api-cache'

// GitHub handle rules: 1-39 chars, alphanumeric or single hyphens, cannot
// start with a hyphen, no consecutive hyphens.
export const HANDLE_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/
// GitHub repo name rules: 1-100 chars, alphanumeric, hyphen, underscore, dot.
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

export const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour, matches s-maxage=3600
export const DISK_CACHE_MAX_AGE_MS = 60 * 60 * 1000

export const RATE_LIMIT_MAX = 30
export const RATE_LIMIT_WINDOW_MS = 60 * 1000

export const EXISTS_TTL_MS = 24 * 60 * 60 * 1000
export const NOT_FOUND_TTL_MS = 60 * 60 * 1000
export const UNKNOWN_EXISTENCE_TTL_MS = 60 * 1000

export function isValidRepoName(repo: string): boolean {
  if (repo === '.' || repo === '..') return false
  return REPO_NAME_RE.test(repo)
}

export function getClientIp(request: {
  headers: { get(name: string): string | null }
}): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const real = request.headers.get('x-real-ip')
  if (real) return real
  return 'unknown'
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

// ---------------------------------------------------------------------------
// Existence checks
//
// `fetchGithubStats` (frozen) returns `null` for several unrelated reasons:
// handle does not exist, rate limited with no cache, network unavailable.
// Route behaviour differs sharply between "does not exist" (404, or a
// not-found badge message) and "GitHub is having a bad day" (200 degraded
// fallback), so existence is resolved separately here rather than inferred
// from that null. Both routes share the same cache keys
// (`exists:user:...`, `exists:repo:...`) so a lookup made by one route
// serves the other's cache too.
// ---------------------------------------------------------------------------

export type Existence = 'exists' | 'not-found' | 'unknown'

export async function checkUserExists(
  login: string,
  token: string | undefined,
  userAgent: string
): Promise<Existence> {
  return checkExistence(
    `exists:user:${login.toLowerCase()}`,
    `https://api.github.com/users/${encodeURIComponent(login)}`,
    token,
    userAgent
  )
}

export async function checkRepoExists(
  owner: string,
  repo: string,
  token: string | undefined,
  userAgent: string
): Promise<Existence> {
  return checkExistence(
    `exists:repo:${owner.toLowerCase()}/${repo.toLowerCase()}`,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token,
    userAgent
  )
}

async function checkExistence(
  cacheKey: string,
  url: string,
  token: string | undefined,
  userAgent: string
): Promise<Existence> {
  const cached = cacheGetFresh<Existence>(cacheKey)
  if (cached) return cached

  const result = await fetchExistence(url, token, userAgent)

  const ttl =
    result === 'exists'
      ? EXISTS_TTL_MS
      : result === 'not-found'
        ? NOT_FOUND_TTL_MS
        : UNKNOWN_EXISTENCE_TTL_MS
  cacheSet(cacheKey, result, ttl)
  return result
}

async function fetchExistence(
  url: string,
  token: string | undefined,
  userAgent: string
): Promise<Existence> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': userAgent,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (response.status === 404) return 'not-found'
    if (response.ok) return 'exists'
    // 403/429 (rate limited), 5xx, anything else unexpected: we cannot
    // confirm either way, so do not risk a false 404.
    return 'unknown'
  } catch {
    // Network unavailable, timeout, DNS failure.
    return 'unknown'
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Repo metadata (language, age, size), for species assignment
//
// The repo creature route already fetches `/repos/{owner}/{repo}` once in
// `checkRepoExists` and discards the body. Species assignment (T19) needs
// `language` (plus age/size as a fallback signal) from that exact same
// endpoint, so this reuses the request shape rather than adding a second
// unrelated call. Cached under its own key (`repometa:...`) so a cache hit
// here is independent of the existence check's own cache entry, since a
// consumer might want metadata without having called `checkRepoExists`
// first.
// ---------------------------------------------------------------------------

export interface RepoMeta {
  language: string | null
  createdAt: string | null
  pushedAt: string | null
  sizeKb: number | null
}

export async function fetchRepoMeta(
  owner: string,
  repo: string,
  token: string | undefined,
  userAgent: string
): Promise<RepoMeta | null> {
  const cacheKey = `repometa:${owner.toLowerCase()}/${repo.toLowerCase()}`
  const cached = cacheGetFresh<RepoMeta>(cacheKey)
  if (cached) return cached

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': userAgent,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, signal: controller.signal }
    )
    if (!response.ok) return null
    const json = (await response.json()) as Record<string, unknown>
    const meta: RepoMeta = {
      language: typeof json.language === 'string' ? json.language : null,
      createdAt: typeof json.created_at === 'string' ? json.created_at : null,
      pushedAt: typeof json.pushed_at === 'string' ? json.pushed_at : null,
      sizeKb: typeof json.size === 'number' ? json.size : null,
    }
    cacheSet(cacheKey, meta, EXISTS_TTL_MS)
    return meta
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Disk cache path
// ---------------------------------------------------------------------------

/**
 * A per-(user[, repo]) disk cache path under the OS temp directory, isolated
 * from the committed build-time cache at `apps/web/src/lib/game/github-cache.json`.
 * Deliberately never reuses that path: `fetchGithubStats`'s own on-disk
 * cache does not check that a cached entry's `login` matches the requested
 * login, so pointing two different handles at the same cache file would let
 * one handle's fetch return with another handle's cached data. Best-effort:
 * if the directory cannot be created (read-only filesystem, no /tmp), the
 * write inside `fetchGithubStats` silently no-ops, exactly as documented
 * there, and callers still work from the in-process cache alone.
 *
 * Both `/api/creature` and `/api/creature.svg` call this same function, so
 * they always agree on the path for a given handle and share disk-cached
 * GitHub responses instead of doubling API calls.
 */
export function diskCachePathFor(user: string, repo?: string): string {
  ensureDiskCacheDir()
  const safeUser = user.toLowerCase().replace(/[^a-z0-9-]/g, '_')
  const safeRepo = repo
    ? `__${repo.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`
    : ''
  return path.join(diskCacheDir(), `${safeUser}${safeRepo}.json`)
}

function diskCacheDir(): string {
  return path.join(os.tmpdir(), 'terrarium-creature-cache')
}

let diskCacheDirEnsured = false
function ensureDiskCacheDir(): void {
  if (diskCacheDirEnsured) return
  diskCacheDirEnsured = true
  try {
    mkdirSync(diskCacheDir(), { recursive: true })
  } catch {
    // Best-effort. See diskCachePathFor's comment.
  }
}

// ---------------------------------------------------------------------------
// Garden repo name
// ---------------------------------------------------------------------------

/**
 * The repo name treated as "this garden" for the higher commit-to-garden XP
 * rate, read from package.json's `name` rather than hardcoded twice. Falls
 * back to the known literal only if package.json is somehow unreadable at
 * runtime, which should not happen in a normal deployment. Computed once
 * (module load) and reused by both routes.
 */
export function readGardenRepoName(): string {
  try {
    const pkgPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { name?: unknown }
    if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name
  } catch {
    // Fall through to the default below.
  }
  return 'terrarium'
}
