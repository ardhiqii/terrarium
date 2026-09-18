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
import { fetchGithubRepositories, type GithubRepository } from '@/lib/sync/github-repositories'
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

async function availableRepositories(token: string): Promise<readonly GithubRepository[] | Response> {
  const result = await fetchGithubRepositories({ token })
  if (result.status === 'unauthorized') {
    return json(401, { error: 'GitHub access was revoked or expired. Reconnect GitHub.' })
  }
  if (result.status !== 'ok') {
    return json(502, { error: 'GitHub could not be reached. Try again shortly.' })
  }
  return result.repositories
}

export async function GET(): Promise<Response> {
  try {
    const value = await context()
    if ('error' in value) return value.error
    const repositories = await availableRepositories(value.token)
    if (repositories instanceof Response) return repositories
    return json(200, {
      githubId: value.session.githubId,
      repositories,
      settings: publicSettings(value.settings),
      approvedRepositoryCount: repositories.length,
      trackedRepositoryCount: repositories.filter((repo) => repositoryIsTracked(repo, value.settings)).length,
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
      payload = await request.json()
    } catch {
      return json(400, { error: 'Body must be valid JSON.' })
    }
    const settingsPayload = parseSettings(payload)
    if (!settingsPayload) {
      return json(400, { error: 'Repository settings are malformed.' })
    }

    const repositories = await availableRepositories(value.token)
    if (repositories instanceof Response) return repositories
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
    // while retaining an existing exclusion in case access returns later.
    const trackedRepositoryIds = settingsPayload.trackedRepositoryIds.filter((id) => {
      const repository = byId.get(id)
      return repository !== undefined && !repository.archived && repository.canRead
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
    })
  } catch {
    return json(500, { error: 'Repository settings could not be saved.' })
  }
}
