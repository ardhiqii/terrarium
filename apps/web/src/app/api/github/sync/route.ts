/**
 * `POST /api/github/sync` — read approved/tracked GitHub activity and return
 * provider-neutral verified events.
 *
 * Repository choices and the OAuth token come from the authenticated server
 * account, never from the request body. The first sync of each repository is
 * a baseline: existing history is visible to GitHub but cannot produce
 * retroactive XP. Later syncs catch up from that checkpoint and the normalizer
 * applies account-wide activity caps by the activity date.
 */

import { NextRequest } from 'next/server'
import { normalizeGitHubEvents, type GitHubEventNormalizationInput } from '@/lib/game/github-events'
import { fetchGitHubEvents, type GithubRepoRef } from '@/lib/game/github-events-fetch'
import { checkRateLimit } from '@/lib/game/api-cache'
import { getGithubAccountStore, type GithubAccountSettings } from '@/lib/sync/github-account-store'
import { fetchGithubRepositories, type GithubRepository } from '@/lib/sync/github-repositories'
import { getSessionProvider } from '@/lib/sync/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const SYNC_PAYLOAD_LIMIT_BYTES = 16 * 1024
const MAX_SYNC_REPOSITORIES = 25

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function parseCompanionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200
    ? value.trim()
    : null
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

function occurredAfterBaseline(
  repositoryId: string,
  occurredAt: string,
  baselines: Readonly<Record<string, string>>,
): boolean {
  const baseline = baselines[repositoryId]
  if (!baseline) return false
  const eventTime = Date.parse(occurredAt)
  const baselineTime = Date.parse(baseline)
  return Number.isFinite(eventTime) && Number.isFinite(baselineTime) && eventTime > baselineTime
}

function filterInputAfterBaselines(
  input: GitHubEventNormalizationInput,
  baselines: Readonly<Record<string, string>>,
): GitHubEventNormalizationInput {
  return {
    ...input,
    commits: input.commits?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.occurredAt, baselines),
    ),
    mergedPullRequests: input.mergedPullRequests?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.mergedAt, baselines),
    ),
    releases: input.releases?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.publishedAt, baselines),
    ),
    linkedIssues: input.linkedIssues?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.closedAt, baselines),
    ),
    ciChecks: input.ciChecks?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.completedAt, baselines),
    ),
  }
}

function activitySummary(events: readonly { category: string }[]) {
  const summary: Record<string, number> = {}
  for (const event of events) summary[event.category] = (summary[event.category] ?? 0) + 1
  return summary
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in with GitHub to sync activity.' })
  const rateLimit = checkRateLimit(`github-sync:${session.githubId}`, 20, 60_000)
  if (!rateLimit.allowed) return json(429, { error: 'Sync limit reached. Try again shortly.' })
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > SYNC_PAYLOAD_LIMIT_BYTES) {
    return json(413, { error: 'Sync payload is too large.' })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return json(400, { error: 'Body must be valid JSON.' })
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json(400, { error: 'Body must contain activeCompanionId.' })
  }
  const activeCompanionId = parseCompanionId((payload as Record<string, unknown>).activeCompanionId)
  if (!activeCompanionId) return json(400, { error: 'activeCompanionId is required.' })

  try {
    const store = getGithubAccountStore()
    const token = await store.getToken(session.githubId)
    if (!token) return json(401, { error: 'GitHub access is unavailable. Reconnect GitHub.' })
    const settings = await store.getSettings(session.githubId)
    const repositoryResult = await fetchGithubRepositories({ token })
    if (repositoryResult.status === 'unauthorized') {
      return json(401, { error: 'GitHub access was revoked or expired. Reconnect GitHub.' })
    }
    if (repositoryResult.status !== 'ok') {
      return json(502, { error: 'GitHub could not be reached. Try again shortly.' })
    }

    const repositories = repositoryResult.repositories
    const eligibleCandidates = repositories.filter((repository) => repositoryIsTracked(repository, settings))
    const eligible = eligibleCandidates.slice(0, MAX_SYNC_REPOSITORIES)
    const skippedRepositoryCount = Math.max(0, eligibleCandidates.length - eligible.length)
    const trackedRepositoryIds = new Set(
      settings.trackedRepositoryIds.filter((id) => !settings.excludedRepositoryIds.includes(id)),
    )
    for (const repository of eligible) trackedRepositoryIds.add(repository.id)

    const now = new Date().toISOString()
    const baselineByRepositoryId = { ...settings.baselineByRepositoryId }
    const newBaselineRepositoryIds: string[] = []

    let events: ReturnType<typeof normalizeGitHubEvents> = []
    let fetchStatus: 'ok' | 'partial' | 'unavailable' = eligible.length === 0 ? 'ok' : 'unavailable'
    if (eligible.length > 0) {
      const refs: GithubRepoRef[] = eligible.map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
      }))
      const fetched = await fetchGitHubEvents({
        login: session.handle,
        sourceId: String(session.githubId),
        repos: refs,
        token,
      })
      fetchStatus = fetched.status
      if (fetched.status !== 'unavailable' && fetched.input.sourceId) {
        if (fetched.status === 'ok') {
          for (const repository of eligible) {
            if (baselineByRepositoryId[repository.id]) continue
            baselineByRepositoryId[repository.id] = now
            newBaselineRepositoryIds.push(repository.id)
          }
        }
        const eligibleInput = filterInputAfterBaselines(fetched.input, baselineByRepositoryId)
        events = normalizeGitHubEvents({
          ...eligibleInput,
          companionId: activeCompanionId,
        })
      }
    }

    const nextSettings: GithubAccountSettings = {
      ...settings,
      trackedRepositoryIds: [...trackedRepositoryIds].sort(),
      baselineByRepositoryId,
      lastSyncedAt: fetchStatus === 'ok' ? now : settings.lastSyncedAt,
    }
    await store.saveSettings(session.githubId, nextSettings)

    if (fetchStatus === 'unavailable') {
      return json(502, { error: 'GitHub activity could not be read completely. No new baseline was recorded.' })
    }

    return json(200, {
      kind: fetchStatus === 'partial'
        ? 'partial'
        : events.length === 0 && newBaselineRepositoryIds.length > 0
          ? 'baseline'
          : 'synced',
      events,
      repositoryCount: eligible.length,
      eligibleRepositoryCount: eligibleCandidates.length,
      skippedRepositoryCount,
      newBaselineRepositoryIds,
      lastSyncedAt: now,
      syncStatus: fetchStatus,
      summary: activitySummary(events),
    })
  } catch {
    return json(500, { error: 'GitHub activity could not be synced.' })
  }
}
