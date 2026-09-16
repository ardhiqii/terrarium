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
import { fetchGitHubEvents, type GitHubEventsProgress, type GithubRepoRef } from '@/lib/game/github-events-fetch'
import { checkRateLimit } from '@/lib/game/api-cache'
import { getGithubAccountStore, type GithubAccountSettings } from '@/lib/sync/github-account-store'
import { fetchGithubRepositories, type GithubRepository } from '@/lib/sync/github-repositories'
import { getSessionProvider } from '@/lib/sync/session'
import { productSnapshotEvent } from '@/lib/sync/product-snapshot'
import { issueGithubSyncCheckpoint } from '@/lib/sync/github-sync-checkpoint'
import { issueVerifiedEventProof } from '@/lib/sync/verified-event-proof'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/**
 * A sync reads up to {@link MAX_SYNC_REPOSITORIES} repositories and can run for
 * a while. Vercel's default function ceiling would cut the read off mid-flight,
 * and a truncated response is indistinguishable from a hang on the client.
 * Vercel clamps this to the maximum its plan allows.
 */
export const maxDuration = 60
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
    if (repositoryResult.status === 'rate-limited') {
      return json(429, { error: 'GitHub rate limit reached. Try again once the limit resets.' })
    }
    if (repositoryResult.status !== 'ok') {
      return json(502, { error: 'GitHub could not be reached. Try again shortly.' })
    }

    const repositories = repositoryResult.repositories
    const eligibleCandidates = repositories.filter((repository) => repositoryIsTracked(repository, settings))
    const eligible = eligibleCandidates.slice(0, MAX_SYNC_REPOSITORIES)
    const skippedRepositoryCount = Math.max(0, eligibleCandidates.length - eligible.length)
    // Keep explicit choices explicit. Auto-included repositories are selected
    // by policy for this sync, but must not be written into the explicit list;
    // otherwise turning auto-inclusion off would not actually stop tracking.
    const trackedRepositoryIds = new Set(
      settings.trackedRepositoryIds.filter((id) => !settings.excludedRepositoryIds.includes(id)),
    )

    const now = new Date().toISOString()
    const baselineByRepositoryId = { ...settings.baselineByRepositoryId }
    const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
    for (const repositoryId of Object.keys(baselineByRepositoryId)) {
      const repository = repositoriesById.get(repositoryId)
      // A complete repository refresh is the access checkpoint. A missing,
      // archived, or currently untracked repository must start fresh if it
      // becomes eligible again; otherwise paused-time activity backfills XP.
      if (!repository || !repositoryIsTracked(repository, settings)) {
        delete baselineByRepositoryId[repositoryId]
      }
    }
    const newBaselineRepositoryIds: string[] = []

    let events: ReturnType<typeof normalizeGitHubEvents> = []
    let fetchStatus: 'ok' | 'partial' | 'unavailable' = eligible.length === 0 ? 'ok' : 'unavailable'
    let truncated = false
    // Aborted when the consumer stops reading, so the GitHub requests actually
    // stop rather than continuing with nobody waiting for the result.
    const abort = new AbortController()

    /**
     * Reads activity for every eligible repository. `onProgress` is optional so
     * the no-repositories path can reuse this without a stream to write to.
     */
    const readActivity = async (
      onProgress?: (progress: GitHubEventsProgress) => void,
    ): Promise<void> => {
      if (eligible.length === 0) return
      const refs: GithubRepoRef[] = eligible.map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
      }))
      const fetched = await fetchGitHubEvents({
        login: session.handle,
        sourceId: String(session.githubId),
        repos: refs,
        token,
        signal: abort.signal,
        ...(onProgress ? { onProgress } : {}),
      })
      fetchStatus = fetched.status
      truncated = fetched.truncated === true
      if (fetched.status !== 'unavailable' && fetched.input.sourceId) {
        // A truncated read is still a successful read: every list is walked
        // newest-first, so the material it could not reach is older than the
        // baseline `now` we record below and can never be awarded anyway.
        // Only a genuine failure withholds the baseline.
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

    /**
     * Receipt issuance is part of the same logical checkpoint as the baseline.
     * If signing fails, the caller throws and the old baseline is left untouched
     * so the activity can be retried instead of being silently consumed.
     */
    const buildBody = (): Record<string, unknown> => {
      const verifiedEventProofs: Record<string, string> = {}
      const snapshotEvents = events.map((event) => productSnapshotEvent(event))
      for (const snapshotEvent of snapshotEvents) {
        verifiedEventProofs[snapshotEvent.eventId] = issueVerifiedEventProof(snapshotEvent, session.githubId)
      }

      const nextSettings: GithubAccountSettings = {
        ...settings,
        trackedRepositoryIds: [...trackedRepositoryIds].sort(),
        baselineByRepositoryId,
        lastSyncedAt: fetchStatus === 'ok' ? now : settings.lastSyncedAt,
      }
      const checkpoint = issueGithubSyncCheckpoint({
        githubId: session.githubId,
        previousBaselineByRepositoryId: settings.baselineByRepositoryId,
        nextBaselineByRepositoryId: nextSettings.baselineByRepositoryId,
        nextLastSyncedAt: nextSettings.lastSyncedAt,
        eventIds: snapshotEvents.map((event) => event.eventId),
      })

      return {
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
        /**
         * True when the bounded scan reached its page ceiling. Reported so the
         * panel can say the window was reached instead of implying that every
         * historical activity was read and rejected.
         */
        truncated,
        summary: activitySummary(events),
        verifiedEventProofs,
        checkpoint,
      }
    }

    // Nothing to read: answer directly, with no stream to maintain.
    if (eligible.length === 0) {
      await readActivity()
      return json(200, buildBody())
    }

    // A sync can run for a long time, and a silent request is indistinguishable
    // from a frozen one. Progress is streamed as newline-delimited JSON so the
    // caller can show real movement instead of an indefinite spinner.
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      // A consumer that goes away must stop the GitHub reads, not merely the
      // response. Abandoning the response alone kept up to 25 repositories
      // being fetched against the account's hourly request budget.
      cancel() {
        abort.abort()
      },
      start(controller) {
        let closed = false
        const close = (): void => {
          if (closed) return
          closed = true
          try {
            controller.close()
          } catch {
            // The consumer already went away; nothing left to close.
          }
        }
        const write = (value: unknown): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
          } catch {
            // A cancelled or errored stream must not take the sync down.
            closed = true
          }
        }

        void (async () => {
          try {
            write({
              type: 'start',
              repositoryCount: eligible.length,
              repositoryNames: eligible.map((repository) => repository.fullName),
            })
            await readActivity((progress) => write({ type: 'progress', ...progress }))
            // A cancelled read is not a result: it must never be presented as
            // a completed sync, and no baseline may be implied from it.
            if (abort.signal.aborted) {
              write({ type: 'error', status: 499, error: 'Sync cancelled.' })
              return
            }
            if (fetchStatus === 'unavailable') {
              write({
                type: 'error',
                status: 502,
                error: 'GitHub activity could not be read completely. No new baseline was recorded.',
              })
              return
            }
            write({ type: 'result', payload: buildBody() })
          } catch {
            write({ type: 'error', status: 500, error: 'GitHub activity could not be synced.' })
          } finally {
            close()
          }
        })()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        // A buffering proxy would hold every progress line until the end and
        // make the indicator useless, so buffering is disabled explicitly.
        'X-Accel-Buffering': 'no',
      },
    })
  } catch {
    return json(500, { error: 'GitHub activity could not be synced.' })
  }
}
