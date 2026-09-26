/**
 * Repository picker API.
 *
 * GitHub's response is reduced to repository identity, visibility, owner type,
 * and read permission. The client can choose what is tracked, but it never
 * sees the OAuth token and it cannot invent a repository that GitHub did not
 * return for the connected account.
 */

import { NextRequest } from 'next/server'
import { getGithubAccountStore, type GithubAccountSettings } from '@/lib/sync/github-account-store'
import type { GithubRepository } from '@/lib/sync/github-repositories'
import {
  getGithubRepositoriesCached,
  purgeGithubRepositoryCache,
} from '@/lib/sync/github-repository-cache'
import { getSessionProvider } from '@/lib/sync/session'
import type { Session } from '@/lib/sync/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const SETTINGS_PAYLOAD_LIMIT_BYTES = 64 * 1024

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function publicSettings(settings: GithubAccountSettings) {
  return {
    trackedRepositoryIds: settings.trackedRepositoryIds,
    excludedRepositoryIds: settings.excludedRepositoryIds,
    autoIncludePersonal: settings.autoIncludePersonal,
    autoIncludeOrganizations: settings.autoIncludeOrganizations,
    lastSyncedAt: settings.lastSyncedAt,
  }
}

function repositoryIsTracked(
  repository: GithubRepository,
  settings: GithubAccountSettings,
): boolean {
  if (!repository.canRead || repository.archived) return false
  if (settings.excludedRepositoryIds.includes(repository.id)) return false
  if (settings.trackedRepositoryIds.includes(repository.id)) return true
  if (repository.ownerType === 'User' && settings.autoIncludePersonal) return true
  return settings.autoIncludeOrganizations.includes(repository.ownerLogin.toLowerCase())
}

async function context(): Promise<{
  session: Session
  token: string
  settings: GithubAccountSettings
} | { error: Response }> {
  const session = await getSessionProvider().current()
  if (!session) return { error: json(401, { error: 'Sign in with GitHub to manage repositories.' }) }
  const store = getGithubAccountStore()
  const token = await store.getToken(session.githubId)
  if (!token) return { error: json(401, { error: 'GitHub access is unavailable. Reconnect GitHub.' }) }
  return { session, token, settings: await store.getSettings(session.githubId) }
}

interface AvailableRepositories {
  repositories: readonly GithubRepository[]
  /** When the listing was read from GitHub. */
  fetchedAt: number
  /** True when a failed refresh fell back to the last known listing. */
  stale: boolean
  /** True when the listing filled the last permitted page. */
  truncated: boolean
}

/**
 * A listing, from the per-account TTL cache when it is fresh and from GitHub
 * otherwise. A failed read with a cached listing is served as `stale` rather
 * than as an error: the client marks it, and the picker keeps working instead
 * of showing a rate-limit wall with zero repositories.
 *
 * The status codes are unchanged. 401 still means revoked access, 429 still
 * means the rate limit was reached with nothing cached to show, and 502 still
 * means GitHub was unreachable and nothing was cached.
 */
async function availableRepositories(
  githubId: number,
  token: string,
  force = false,
): Promise<AvailableRepositories | Response> {
  const cached = await getGithubRepositoriesCached({ githubId, token, force })
  const result = cached.result
  if (result.status === 'unauthorized') {
    return json(401, { error: 'GitHub access was revoked or expired. Reconnect GitHub.' })
  }
  if (result.status === 'rate-limited') {
    // A rate limit is transient: reconnecting GitHub would not help, so the
    // user is told to retry instead of being signed out. The account id is
    // included so the client can tell which account the server answered for
    // and discard a browser copy that belongs to another one.
    return json(429, { githubId, error: 'GitHub rate limit reached. Try again once the limit resets.' })
  }
  if (result.status !== 'ok') {
    return json(502, { githubId, error: 'GitHub could not be reached. Try again shortly.' })
  }
  return {
    repositories: result.repositories,
    fetchedAt: cached.fetchedAt,
    stale: cached.stale,
    truncated: result.truncated === true,
  }
}

/** `?refresh=1` revalidates instead of accepting a fresh cache entry. */
function refreshRequested(request: NextRequest | undefined): boolean {
  const value = request?.nextUrl?.searchParams?.get('refresh')
  return value === '1' || value === 'true'
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const value = await context()
    if ('error' in value) return value.error
    const available = await availableRepositories(
      value.session.githubId,
      value.token,
      refreshRequested(request),
    )
    if (available instanceof Response) return available
    return json(200, {
      githubId: value.session.githubId,
      repositories: available.repositories,
      settings: publicSettings(value.settings),
      approvedRepositoryCount: available.repositories.length,
      trackedRepositoryCount: available.repositories.filter((repo) => repositoryIsTracked(repo, value.settings)).length,
      fetchedAt: available.fetchedAt,
      stale: available.stale,
    })
  } catch {
    return json(500, { error: 'Repository settings could not be loaded.' })
  }
}

interface SettingsPayload {
  trackedRepositoryIds: string[]
  excludedRepositoryIds: string[]
  autoIncludePersonal: boolean
  autoIncludeOrganizations: string[]
}

function parseSettings(value: unknown): SettingsPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (keys !== 'autoIncludeOrganizations,autoIncludePersonal,excludedRepositoryIds,trackedRepositoryIds') return null
  if (!Array.isArray(record.trackedRepositoryIds) || !record.trackedRepositoryIds.every(isRepositoryId)) return null
  if (!Array.isArray(record.excludedRepositoryIds) || !record.excludedRepositoryIds.every(isRepositoryId)) return null
  if (typeof record.autoIncludePersonal !== 'boolean') return null
  if (!Array.isArray(record.autoIncludeOrganizations) || !record.autoIncludeOrganizations.every(isOrganizationLogin)) return null
  return {
    trackedRepositoryIds: [...new Set(record.trackedRepositoryIds)],
    excludedRepositoryIds: [...new Set(record.excludedRepositoryIds)],
    autoIncludePersonal: record.autoIncludePersonal,
    autoIncludeOrganizations: [...new Set(record.autoIncludeOrganizations.map((value) => value.toLowerCase()))],
  }
}

function isRepositoryId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/u.test(value)
}

function isOrganizationLogin(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/u.test(value)
}

export async function PUT(request: NextRequest): Promise<Response> {
  try {
    const value = await context()
    if ('error' in value) return value.error
    const contentLength = request.headers.get('content-length')
    if (contentLength && Number(contentLength) > SETTINGS_PAYLOAD_LIMIT_BYTES) {
      return json(413, { error: 'Repository settings payload is too large.' })
    }
    let payload: unknown
    try {
      // The content-length header is a client claim and a chunked body has
      // none, so the actual body is what is bounded. A payload past the cap is
      // rejected instead of being parsed.
      const raw = await request.text()
      if (raw.length > SETTINGS_PAYLOAD_LIMIT_BYTES) {
        return json(413, { error: 'Repository settings payload is too large.' })
      }
      payload = JSON.parse(raw) as unknown
    } catch {
      return json(400, { error: 'Body must be valid JSON.' })
    }
    const settingsPayload = parseSettings(payload)
    if (!settingsPayload) {
      return json(400, { error: 'Repository settings are malformed.' })
    }

    const available = await availableRepositories(value.session.githubId, value.token)
    if (available instanceof Response) return available
    const repositories = available.repositories
    const byId = new Map(repositories.map((repo) => [repo.id, repo]))
    const existingTrackedIds = new Set(value.settings.trackedRepositoryIds)
    const existingExcludedIds = new Set(value.settings.excludedRepositoryIds)
    const unknownNewTrackedIds = settingsPayload.trackedRepositoryIds.filter((id) => {
      const repository = byId.get(id)
      return (!repository || repository.archived || !repository.canRead) && !existingTrackedIds.has(id)
    })
    const unknownNewExcludedIds = settingsPayload.excludedRepositoryIds.filter((id) => {
      return !byId.has(id) && !existingExcludedIds.has(id)
    })
    if (unknownNewTrackedIds.length > 0 || unknownNewExcludedIds.length > 0) {
      return json(400, { error: 'A selected repository is unavailable for activity tracking. Refresh the list and try again.' })
    }
    // A repository can disappear from GitHub after permission revocation or
    // deletion. Drop stale tracked IDs so they stop contributing immediately,
    // while retaining an existing exclusion in case access returns later. A
    // listing that could not be refreshed completely (stale or truncated) is
    // not proof of deletion: the user's explicit choice is preserved instead
    // of being silently unselected by a failed read.
    const completeListing = !available.stale && !available.truncated
    const trackedRepositoryIds = settingsPayload.trackedRepositoryIds.filter((id) => {
      const repository = byId.get(id)
      if (repository === undefined) return !completeListing
      return !repository.archived && repository.canRead
    })
    const excludedRepositoryIds = settingsPayload.excludedRepositoryIds.filter((id) => {
      return byId.has(id) || existingExcludedIds.has(id)
    })
    if (trackedRepositoryIds.some((id) => excludedRepositoryIds.includes(id))) {
      return json(400, { error: 'A repository cannot be both tracked and excluded.' })
    }
    const visibleOrganizations = new Set(
      repositories
        .filter((repo) => repo.ownerType === 'Organization')
        .map((repo) => repo.ownerLogin.toLowerCase()),
    )
    if (settingsPayload.autoIncludeOrganizations.some((login) => !visibleOrganizations.has(login))) {
      return json(400, { error: 'An automatic organization selection is not available to this account.' })
    }

    const nextSettings: GithubAccountSettings = {
      ...value.settings,
      trackedRepositoryIds,
      excludedRepositoryIds,
      autoIncludePersonal: settingsPayload.autoIncludePersonal,
      autoIncludeOrganizations: settingsPayload.autoIncludeOrganizations,
    }
    const baselineByRepositoryId = { ...nextSettings.baselineByRepositoryId }
    for (const repository of repositories) {
      // Re-enabling a source or resuming a repository starts a fresh
      // checkpoint. Otherwise activity performed while it was paused would
      // be discovered later and look like new work.
      if (!repositoryIsTracked(repository, value.settings) && repositoryIsTracked(repository, nextSettings)) {
        delete baselineByRepositoryId[repository.id]
      }
    }
    const savedSettings: GithubAccountSettings = { ...nextSettings, baselineByRepositoryId }
    await getGithubAccountStore().saveSettings(value.session.githubId, savedSettings)
    return json(200, {
      githubId: value.session.githubId,
      repositories,
      settings: publicSettings(savedSettings),
      approvedRepositoryCount: repositories.length,
      trackedRepositoryCount: repositories.filter((repo) => repositoryIsTracked(repo, savedSettings)).length,
      fetchedAt: available.fetchedAt,
      stale: available.stale,
    })
  } catch {
    return json(500, { error: 'Repository settings could not be saved.' })
  }
}

/**
 * `DELETE /api/github/repositories` -- disconnect GitHub.
 *
 * This is NOT the same control as `DELETE /api/sync/product`, and the two must
 * never be merged. Disconnecting drops the OAuth credential and every sync
 * baseline so nothing new can be tracked; it keeps the account row, the
 * user's repository choices, and every earned XP. Deleting synced data
 * destroys the progression snapshot and stays a separate, explicit action.
 *
 * A revoked token, a GitHub outage, a closed tab, or an expired session cookie
 * must never reach this function. Nothing here runs unless the user asked for
 * it: automatic failures only purge caches and ask for a reconnect.
 */
export async function DELETE(): Promise<Response> {
  try {
    const session = await getSessionProvider().current()
    if (!session) return json(401, { error: 'Sign in with GitHub to manage repositories.' })
    await getGithubAccountStore().clearCredential(session.githubId)
    purgeGithubRepositoryCache(session.githubId)
    return json(204, undefined)
  } catch {
    return json(500, { error: 'GitHub could not be disconnected. Try again shortly.' })
  }
}
