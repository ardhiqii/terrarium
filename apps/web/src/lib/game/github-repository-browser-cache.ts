/**
 * Browser-held copy of the GitHub repository listing.
 *
 * `/github` used to have no memory: every visit mounted a fresh panel that
 * immediately asked the server for the repository list, and the server asked
 * GitHub (up to five paged requests). Navigating away and back, saving
 * choices, and syncing could produce ~20 GitHub requests from one visit, which
 * burned the account's hourly budget and greeted the user with a rate-limit
 * wall and zero repositories. This module keeps the last successful listing in
 * browser storage so the picker paints instantly and the request is only a
 * refresh rather than the only source of truth.
 *
 * One slot, one active GitHub account per profile. The entry carries its
 * `githubId` so a copy that does not belong to the account the server answers
 * for is discarded rather than merged. A fresh page load cannot know the
 * account id before that answer arrives, so it does not paint the stored copy
 * until this mount confirms the same immutable account; the response remains
 * the source of truth.
 *
 * Pure browser module: no `node:*`, no server imports, no React, so the
 * client-bundle safety guard stays green.
 */

import type { GithubRepository } from '../sync/github-repositories'
import type { BrowserProductStorage } from './product-browser-storage'

export const GITHUB_REPOSITORY_CACHE_KEY = 'terrarium:github-repositories-cache'
/** How long a stored listing is treated as fresh, matching the server copy. */
export const GITHUB_REPOSITORY_CACHE_FRESH_MS = 5 * 60 * 1000
/**
 * Browser storage is shared with the ledger and snapshots, so the listing is
 * capped well below the localStorage budget. A 5-page listing of 100
 * repositories is a few tens of kilobytes; anything past the cap is a sign the
 * payload is not a repository listing and is not stored at all.
 */
export const GITHUB_REPOSITORY_CACHE_MAX_BYTES = 256 * 1024

/** The public settings shape the repository route returns. */
export interface GithubRepositoryCacheSettings {
  readonly trackedRepositoryIds: readonly string[]
  readonly excludedRepositoryIds: readonly string[]
  readonly autoIncludePersonal: boolean
  readonly autoIncludeOrganizations: readonly string[]
  readonly lastSyncedAt: string | null
}

export interface GithubRepositoryCacheEntry {
  readonly githubId: number
  readonly savedAt: number
  readonly repositories: readonly GithubRepository[]
  readonly settings: GithubRepositoryCacheSettings
  readonly approvedRepositoryCount: number
  readonly trackedRepositoryCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseRepository(value: unknown): GithubRepository | null {
  if (!isRecord(value)) return null
  const { id, name, fullName, ownerLogin } = value
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof fullName !== 'string' ||
    typeof ownerLogin !== 'string'
  ) return null
  return {
    id,
    name,
    fullName,
    ownerLogin,
    ownerType: value.ownerType === 'Organization' ? 'Organization' : 'User',
    private: value.private === true,
    visibility: typeof value.visibility === 'string' ? value.visibility : 'private',
    defaultBranch: typeof value.defaultBranch === 'string' ? value.defaultBranch : null,
    archived: value.archived === true,
    canRead: value.canRead !== false,
  }
}

function parseSettings(value: unknown): GithubRepositoryCacheSettings | null {
  if (!isRecord(value)) return null
  if (!isStringArray(value.trackedRepositoryIds)) return null
  if (!isStringArray(value.excludedRepositoryIds)) return null
  if (typeof value.autoIncludePersonal !== 'boolean') return null
  if (!isStringArray(value.autoIncludeOrganizations)) return null
  const lastSyncedAt = typeof value.lastSyncedAt === 'string' && !Number.isNaN(Date.parse(value.lastSyncedAt))
    ? value.lastSyncedAt
    : null
  return {
    trackedRepositoryIds: value.trackedRepositoryIds,
    excludedRepositoryIds: value.excludedRepositoryIds,
    autoIncludePersonal: value.autoIncludePersonal,
    autoIncludeOrganizations: value.autoIncludeOrganizations,
    lastSyncedAt,
  }
}

function parseEntry(value: unknown): GithubRepositoryCacheEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.githubId !== 'number' || !Number.isFinite(value.githubId)) return null
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
  if (!Array.isArray(value.repositories)) return null
  const settings = parseSettings(value.settings)
  if (!settings) return null
  const repositories = value.repositories
    .map(parseRepository)
    .filter((repository): repository is GithubRepository => repository !== null)
  return {
    githubId: value.githubId,
    savedAt: value.savedAt,
    repositories,
    settings,
    approvedRepositoryCount: typeof value.approvedRepositoryCount === 'number'
      ? value.approvedRepositoryCount
      : repositories.length,
    trackedRepositoryCount: typeof value.trackedRepositoryCount === 'number'
      ? value.trackedRepositoryCount
      : 0,
  }
}

function serializedByteLength(serialized: string): number {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(serialized).byteLength
  return serialized.length
}

/**
 * Reads the stored listing. Corrupt JSON or a shape that is not a listing is
 * ignored (returns null) rather than thrown: a broken copy must never break
 * the picker, it just means the next fetch is the source of truth again.
 *
 * When `expectedGithubId` is known -- the account a successful response has
 * already confirmed -- a copy stored for any other account is discarded. One
 * browser profile can be shared by two GitHub accounts, and the stored copy
 * holds repository names (including private ones); it must never be painted
 * for the wrong account. An omitted expectation is the first paint of an
 * unknown session, which the server response replaces.
 */
export function loadGithubRepositoryCache(
  storage: BrowserProductStorage,
  expectedGithubId?: number,
): GithubRepositoryCacheEntry | null {
  try {
    const serialized = storage.getItem(GITHUB_REPOSITORY_CACHE_KEY)
    if (!serialized) return null
    const entry = parseEntry(JSON.parse(serialized) as unknown)
    if (!entry) return null
    if (expectedGithubId !== undefined && entry.githubId !== expectedGithubId) return null
    return entry
  } catch {
    return null
  }
}

/**
 * Whether a failed refresh may keep showing the stored listing. Only a copy
 * the server has confirmed for the account that answered is safe: a null
 * account id is not confirmation, because a shared profile may hold another
 * account's copy, and an unconfirmed first paint must not survive a failure.
 */
export function cachedGithubRepositoryMatchesAccount(
  entry: GithubRepositoryCacheEntry | null,
  accountGithubId: number | null,
): boolean {
  return entry !== null && accountGithubId !== null && entry.githubId === accountGithubId
}

/**
 * What a failed repository refresh means for the listing already on screen.
 *
 * - `keep-listing` the visible listing provably belongs to the account the
 *   server answered for (the failure named that account, or the stored copy
 *   was confirmed for it), so the picker can keep working and say it is
 *   degraded.
 * - `drop-listing` the server answered for a DIFFERENT account than the one
 *   on screen. A mount-scoped "a listing was confirmed" flag is not enough:
 *   a shared browser profile can switch accounts in another tab, and account
 *   A's private repository names must not stay visible for account B just
 *   because A was confirmed earlier.
 * - `fail-load` nothing proves the visible copy belongs to the answering
 *   account -- including a failure that names no account at all; show the
 *   failure instead of a possibly foreign listing.
 */
export type FailedListingRefreshOutcome = 'keep-listing' | 'drop-listing' | 'fail-load'

export function decideFailedListingRefresh(options: {
  cached: GithubRepositoryCacheEntry | null
  confirmedGithubId: number | null
  failedGithubId: number | null
}): FailedListingRefreshOutcome {
  const { cached, confirmedGithubId, failedGithubId } = options
  // A failure that names no account proves nothing about the session that
  // answered: a shared profile can switch accounts in another tab, and our own
  // 500 body is account-less. Do not keep a possibly foreign listing.
  if (failedGithubId === null) return 'fail-load'
  if (confirmedGithubId !== null && confirmedGithubId !== failedGithubId) {
    return 'drop-listing'
  }
  if (confirmedGithubId === failedGithubId) return 'keep-listing'
  return cachedGithubRepositoryMatchesAccount(cached, failedGithubId) ? 'keep-listing' : 'fail-load'
}

/**
 * Stores the last successful listing. Best effort, mirroring
 * `saveSyncScheduleState`: browser storage can refuse a write (private mode,
 * quota) and the panel's in-memory state is still correct.
 *
 * Returns whether the write happened, which is what the tests assert on.
 */
export function saveGithubRepositoryCache(
  storage: BrowserProductStorage,
  entry: GithubRepositoryCacheEntry,
): boolean {
  try {
    // The stored `savedAt` is the time the SERVER read the listing, so a
    // degraded response can carry a read time older than the copy already on
    // disk (a second server instance, a rolling restart). A one-slot cache
    // must not let that regress to the older listing: the freshness label
    // would move backwards and a later failed refresh would fall back to it.
    // The incoming settings still win -- they were read from the server at
    // request time, after the older listing's settings.
    const existing = loadGithubRepositoryCache(storage, entry.githubId)
    const merged = existing && existing.savedAt > entry.savedAt
      ? {
          ...entry,
          savedAt: existing.savedAt,
          repositories: existing.repositories,
          approvedRepositoryCount: existing.approvedRepositoryCount,
        }
      : entry
    const serialized = JSON.stringify({
      githubId: merged.githubId,
      savedAt: merged.savedAt,
      repositories: merged.repositories,
      settings: merged.settings,
      approvedRepositoryCount: merged.approvedRepositoryCount,
      trackedRepositoryCount: merged.trackedRepositoryCount,
    })
    if (serializedByteLength(serialized) > GITHUB_REPOSITORY_CACHE_MAX_BYTES) return false
    storage.setItem(GITHUB_REPOSITORY_CACHE_KEY, serialized)
    return true
  } catch {
    return false
  }
}

/** Drops the stored listing, e.g. after the user disconnects GitHub. */
export function clearGithubRepositoryCache(storage: BrowserProductStorage): void {
  try {
    storage.removeItem(GITHUB_REPOSITORY_CACHE_KEY)
  } catch {
    // Best effort; the next load simply overwrites the entry.
  }
}

/** Age of a stored listing in milliseconds. */
export function githubRepositoryCacheAgeMs(
  entry: GithubRepositoryCacheEntry,
  now: number = Date.now(),
): number {
  return Math.max(0, now - entry.savedAt)
}

/**
 * Whether the stored listing is still within the fresh window. The panel does
 * not skip its fetch when this is true -- the server copy makes the refresh
 * cheap and settings stay server-authoritative -- but it labels the list so
 * the user knows how old it is.
 */
export function isGithubRepositoryCacheFresh(
  entry: GithubRepositoryCacheEntry,
  now: number = Date.now(),
): boolean {
  return githubRepositoryCacheAgeMs(entry, now) < GITHUB_REPOSITORY_CACHE_FRESH_MS
}
