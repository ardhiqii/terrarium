/**
 * `POST /api/github/sync` — read approved/tracked GitHub activity and return
 * provider-neutral verified events.
 *
 * Repository choices and the OAuth token come from the authenticated server
 * account, never from the request body. The first sync of each repository is
 * a baseline: existing history is visible to GitHub but cannot produce
 * retroactive XP. Every repository still awaiting its baseline is registered
 * in a single sync — a baseline costs no GitHub read — while a bounded window
 * rotates through the oldest recorded baselines. Later syncs catch up from
 * that checkpoint and the normalizer applies account-wide activity caps by the
 * activity date.
 */

import { NextRequest } from 'next/server'
import { asCompanionId } from '@/lib/game/events'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { normalizeGitHubEvents } from '@/lib/game/github-events'
import { fetchGitHubEvents, type GithubEventsContinuation, type GitHubEventsProgress, type GithubRepoRef } from '@/lib/game/github-events-fetch'
import { fetchGithubRepositoriesById, type GithubRepository } from '@/lib/sync/github-repositories'
import { checkRateLimit } from '@/lib/game/api-cache'
import { getGithubAccountStore, type GithubAccountSettings } from '@/lib/sync/github-account-store'
import { getGithubRepositoriesCached } from '@/lib/sync/github-repository-cache'
import { getSessionProvider } from '@/lib/sync/session'
import { getProductStore } from '@/lib/sync/product-store'
import { requestAccountMatchesSession } from '@/lib/sync/request-account-guard'
import { trustStoredProductSnapshot } from '@/lib/sync/trusted-product-snapshot'
import { productSnapshotEvent } from '@/lib/sync/product-snapshot'
import { issueGithubSyncCheckpoint, MAX_CHECKPOINT_BASELINE_ENTRIES } from '@/lib/sync/github-sync-checkpoint'
import {
  githubSyncContinuationMatchesBaseline,
  issueGithubSyncContinuation,
  verifyGithubSyncContinuation,
} from '@/lib/sync/github-sync-continuation'
import { issueVerifiedEventProof, verifiedEventProofPayloadDigest } from '@/lib/sync/verified-event-proof'
import {
  repositoryIsTracked,
  selectGithubSyncRepositories,
  filterInputAfterBaselines,
} from '@/lib/sync/github-source-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/**
 * A sync reads a window of repositories and can run for a while. A function
 * ceiling in front of it would cut the read off mid-flight, and a truncated
 * response is indistinguishable from a hang on the client. `maxDuration` is a
 * deployment hint for Vercel only; this app is served by the docker-compose
 * node server behind a Cloudflare tunnel, where it is inert, so it is kept as
 * an upper hint rather than relied on for correctness.
 */
export const maxDuration = 60
const SYNC_PAYLOAD_LIMIT_BYTES = 16 * 1024

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
    },
  })
}

function parseCompanionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200
    ? value.trim()
    : null
}

function parseContinuation(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 * 1024
    ? value
    : null
}

function activitySummary(events: readonly { category: string }[]) {
  const summary: Record<string, number> = {}
  for (const event of events) summary[event.category] = (summary[event.category] ?? 0) + 1
  return summary
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in with GitHub to sync activity.' })
  if (!requestAccountMatchesSession(request, session.githubId)) {
    return json(409, { error: 'account_changed' })
  }
  const rateLimit = checkRateLimit(`github-sync:${session.githubId}`, 20, 60_000)
  if (!rateLimit.allowed) return json(429, { error: 'Sync limit reached. Try again shortly.' })
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > SYNC_PAYLOAD_LIMIT_BYTES) {
    return json(413, { error: 'Sync payload is too large.' })
  }

  let payload: unknown
  try {
    // The content-length header is a client claim and a chunked body has none,
    // so the actual body is what is bounded. An oversized payload is rejected
    // instead of being parsed.
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > SYNC_PAYLOAD_LIMIT_BYTES) {
      return json(413, { error: 'Sync payload is too large.' })
    }
    payload = JSON.parse(raw) as unknown
  } catch {
    return json(400, { error: 'Body must be valid JSON.' })
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json(400, { error: 'Body must contain activeCompanionId.' })
  }
  const activeCompanionId = parseCompanionId((payload as Record<string, unknown>).activeCompanionId)
  if (!activeCompanionId) return json(400, { error: 'activeCompanionId is required.' })
  if (!PROTOTYPE_COMPANION_CATALOG.get(activeCompanionId)) {
    return json(400, { error: 'activeCompanionId is not a recognized companion.' })
  }
  const continuationToken = parseContinuation((payload as Record<string, unknown>).continuation)
  if ('continuation' in (payload as Record<string, unknown>) &&
    (payload as Record<string, unknown>).continuation !== null &&
    continuationToken === null) {
    return json(400, { error: 'continuation must be a bounded signed token.' })
  }

  try {
    const store = getGithubAccountStore()
    const token = await store.getToken(session.githubId)
    if (!token) return json(401, { error: 'GitHub access is unavailable. Reconnect GitHub.' })
    const settings = await store.getSettings(session.githubId)
    const continuation = continuationToken
      ? verifyGithubSyncContinuation(continuationToken, session.githubId)
      : null
    if (continuationToken && !continuation) {
      return json(400, { error: 'continuation is invalid or expired.' })
    }
    if (continuation && !githubSyncContinuationMatchesBaseline(continuation, settings.baselineByRepositoryId)) {
      return json(409, { error: 'GitHub activity changed while the bounded read was being continued. Sync again.' })
    }

    // A stable GitHub event belongs to the companion that first accepted it.
    // Read the account condition before minting receipts so a later provider
    // replay after an active-companion switch cannot move already-awarded XP.
    // A concurrent first upload can still win the race; the product merge then
    // applies the same stable-ID rule when that response is uploaded.
    const existingGithubCompanionByEventId = new Map<string, string>()
    let productAccountSnapshotPresent = false
    let requestedCompanionOwned = true
    let requestedCompanionIsActive = true
    try {
      const productRecord = await getProductStore().getRecord(session.githubId, session.handle)
      const trustedSnapshot = productRecord
        ? trustStoredProductSnapshot(productRecord.snapshot, session.githubId)
        : null
      productAccountSnapshotPresent = trustedSnapshot !== null
      requestedCompanionOwned = !trustedSnapshot || new Set(
        trustedSnapshot.collection.map((reference) => reference.companionId),
      ).has(activeCompanionId)
      requestedCompanionIsActive = !trustedSnapshot || trustedSnapshot.activeCompanionId === activeCompanionId
      for (const event of trustedSnapshot?.events ?? []) {
        if (event.source === 'github' && event.provenance === 'verified') {
          existingGithubCompanionByEventId.set(event.eventId, event.companionId)
        }
      }
    } catch {
      // Ownership cannot be established safely when the trusted account row is
      // unavailable or corrupt. Do not mint receipts against an unverified
      // active companion.
      return json(503, { error: 'storage_unavailable' })
    }
    // The listing comes from the per-account TTL cache. Back-to-back syncs and
    // the picker share it, so a sync right after opening `/github` costs no
    // extra GitHub requests at all.
    const repositoryOutcome = await getGithubRepositoriesCached({ githubId: session.githubId, token })
    const repositoryResult = repositoryOutcome.result
    if (repositoryResult.status === 'unauthorized') {
      return json(401, { error: 'GitHub access was revoked or expired. Reconnect GitHub.' })
    }
    if (repositoryResult.status === 'rate-limited') {
      return json(429, { error: 'GitHub rate limit reached. Try again once the limit resets.' })
    }
    if (repositoryResult.status !== 'ok') {
      return json(502, { error: 'GitHub could not be reached. Try again shortly.' })
    }

    let repositories: readonly GithubRepository[] = repositoryResult.repositories
    if (repositoryResult.truncated === true) {
      const knownIds = new Set(repositories.map((repository) => repository.id))
      const missingTrackedIds = settings.trackedRepositoryIds.filter((id) => !knownIds.has(id))
      if (missingTrackedIds.length > 0) {
        const hydrated = await fetchGithubRepositoriesById({ token, repositoryIds: missingTrackedIds })
        if (hydrated.status === 'unauthorized') {
          return json(401, { error: 'GitHub access was revoked or expired. Reconnect GitHub.' })
        }
        if (hydrated.status === 'rate-limited') {
          return json(429, { error: 'GitHub rate limit reached. Try again once the limit resets.' })
        }
        if (hydrated.status === 'unavailable') {
          return json(502, { error: 'GitHub could not verify all tracked repositories. Try again shortly.' })
        }
        repositories = [...repositories, ...hydrated.repositories]
      }
    }
    const eligibleCandidates = repositories.filter((repository) => repositoryIsTracked(repository, settings))
    // Keep explicit choices explicit. Auto-included repositories are selected
    // by policy for this sync, but must not be written into the explicit list;
    // otherwise turning auto-inclusion off would not actually stop tracking.
    const trackedRepositoryIds = new Set(
      settings.trackedRepositoryIds.filter((id) => !settings.excludedRepositoryIds.includes(id)),
    )

    const now = new Date().toISOString()
    const baselineByRepositoryId = { ...settings.baselineByRepositoryId }
    const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
    // Pruning is only safe from a COMPLETE listing. A stale listing was served
    // because GitHub could not be read, and a truncated listing filled the last
    // permitted page, so both can be missing a repository GitHub still has. A
    // temporarily missing repository would look deleted, its baseline would be
    // dropped, and its activity would be re-baselined as if it were new work.
    const completeListing = !repositoryOutcome.stale && repositoryResult.truncated !== true
    if (completeListing) {
      for (const repositoryId of Object.keys(baselineByRepositoryId)) {
        const repository = repositoriesById.get(repositoryId)
        // A complete repository refresh is the access checkpoint. A missing,
        // archived, or currently untracked repository must start fresh if it
        // becomes eligible again; otherwise paused-time activity backfills XP.
        if (!repository || !repositoryIsTracked(repository, settings)) {
          delete baselineByRepositoryId[repositoryId]
        }
      }
    }
    // First-use baselines cost no GitHub read, so they are not squeezed into
    // the bounded read window: one checkpoint registers every repository still
    // awaiting a baseline, up to the capacity the checkpoint itself can carry.
    // Only the remainder is a window of repositories the read rotates through.
    const baselineBudget = Math.max(
      0,
      MAX_CHECKPOINT_BASELINE_ENTRIES - Object.keys(baselineByRepositoryId).length,
    )
    const repositoryWindow = selectGithubSyncRepositories(
      repositories,
      { ...settings, baselineByRepositoryId },
      baselineBudget,
    )
    const eligible = repositoryWindow.readWindow
    const skippedRepositoryCount = repositoryWindow.skippedCount
    const newBaselineRepositoryIds: string[] = []

    let events: ReturnType<typeof normalizeGitHubEvents> = []
    let fetchStatus: 'ok' | 'partial' | 'unavailable' = eligible.length === 0 ? 'ok' : 'unavailable'
    let truncated = false
    let nextContinuation: GithubEventsContinuation | undefined
    let continuationReady = false
    let ownershipBlocked = false
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
      // A repository without a baseline needs no historical read: its first
      // successful listing records the baseline and cannot award old history,
      // so every one of them is registered here instead of waiting for a read
      // slot — registering four per sync used to leave a fresh account unable
      // to award anything for a dozen silent syncs. Registration must also not
      // get stuck behind an old 30-commit/release/issue page ceiling: it is
      // simply not part of the read window.
      for (const repository of repositoryWindow.pendingBaseline) {
        baselineByRepositoryId[repository.id] = now
        newBaselineRepositoryIds.push(repository.id)
      }
      if (eligible.length === 0) {
        fetchStatus = 'ok'
        return
      }
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
        baselineByRepositoryId,
        ...(continuation ? { continuation: continuation.cursors } : {}),
        ...(onProgress ? { onProgress } : {}),
      })
      fetchStatus = fetched.status
      truncated = fetched.truncated === true
      nextContinuation = fetched.continuation
      // A bounded read that hit a page ceiling and a read with failed pages
      // both leave unread activity behind; the continuation carries the exact
      // page to resume from, including a page that failed. Resuming is safe
      // because no checkpoint is issued for a partial sync, so the retry can
      // be offered instead of a dead-end error.
      continuationReady = fetched.status !== 'unavailable' &&
        fetched.truncated === true &&
        fetched.continuation !== undefined
      // A bounded read cannot safely advance an existing checkpoint: activity
      // between the checkpoint and the oldest fetched page could otherwise age
      // out forever. Keep the fetch adapter's useful `ok + truncated` detail,
      // but make the sync itself retryable and issue no baseline/checkpoint.
      if (truncated && fetchStatus === 'ok') fetchStatus = 'partial'
      if (fetched.status !== 'unavailable' && fetched.input.sourceId) {
        // Existing baselines are applied before normalization. If the bounded
        // adapter reports truncation, the caller below fails closed and this
        // in-memory baseline map is never persisted.
        const eligibleInput = filterInputAfterBaselines(fetched.input, baselineByRepositoryId)
        events = normalizeGitHubEvents({
          ...eligibleInput,
          companionId: activeCompanionId,
        })
        if (productAccountSnapshotPresent && (!requestedCompanionOwned || !requestedCompanionIsActive)) {
          // A browser can replay a stable event after a local companion switch,
          // but a batch with even one new event would otherwise mint a receipt
          // and checkpoint for an unowned active companion. Block the whole
          // batch rather than issuing a mixed set of trusted and untrusted
          // receipts. Existing verified replays remain a compatibility path.
          const hasOwnedReplay = events.some((event) => (
            existingGithubCompanionByEventId.has(productSnapshotEvent(event).eventId)
          ))
          const hasNewEvent = events.some((event) => (
            !existingGithubCompanionByEventId.has(productSnapshotEvent(event).eventId)
          ))
          ownershipBlocked = events.length === 0 || !hasOwnedReplay || hasNewEvent
        }
      }
      if (!truncated && fetched.status === 'ok') {
        // A complete read closes the selected repository window. Advancing all
        // selected baselines (not only first-use baselines) is what rotates an
        // account fairly: the next sync can select the oldest untouched
        // repository instead of retrying the same first window forever.
        for (const repository of eligible) baselineByRepositoryId[repository.id] = now
      }
    }

    /**
     * Receipt issuance is part of the same logical checkpoint as the baseline.
     * If signing fails, the caller throws and the old baseline is left untouched
     * so the activity can be retried instead of being silently consumed.
     */
    const buildBody = (partial = false): Record<string, unknown> => {
      const verifiedEventProofs: Record<string, string> = {}
      /**
       * Mint-side payload digests, reported beside the receipts so a receipt
       * that later fails to verify can be compared against the verify-side
       * payload. A digest is not the receipt: it cannot be replayed.
       */
      const verifiedEventProofDigests: Record<string, string> = {}
      const issuedEvents = events.map((event) => {
        const candidate = productSnapshotEvent(event)
        const existingCompanionId = existingGithubCompanionByEventId.get(candidate.eventId)
        return existingCompanionId
          ? { ...event, companionId: asCompanionId(existingCompanionId) }
          : event
      })
      const snapshotEvents = issuedEvents.map((event) => productSnapshotEvent(event))
      for (const snapshotEvent of snapshotEvents) {
        verifiedEventProofs[snapshotEvent.eventId] = issueVerifiedEventProof(snapshotEvent, session.githubId)
        verifiedEventProofDigests[snapshotEvent.eventId] = verifiedEventProofPayloadDigest(snapshotEvent, session.githubId)
      }

      const nextSettings: GithubAccountSettings = {
        ...settings,
        trackedRepositoryIds: [...trackedRepositoryIds].sort(),
        baselineByRepositoryId,
        lastSyncedAt: fetchStatus === 'ok' ? now : settings.lastSyncedAt,
      }
      const checkpoint = partial
        ? null
        : issueGithubSyncCheckpoint({
            githubId: session.githubId,
            previousBaselineByRepositoryId: settings.baselineByRepositoryId,
            nextBaselineByRepositoryId: nextSettings.baselineByRepositoryId,
            nextLastSyncedAt: nextSettings.lastSyncedAt,
            eventIds: snapshotEvents.map((event) => event.eventId),
          })
      const continuationToken = partial && nextContinuation
        ? issueGithubSyncContinuation({
            githubId: session.githubId,
            baselineByRepositoryId: settings.baselineByRepositoryId,
            cursors: nextContinuation,
          })
        : null

      return {
        kind: partial
          ? 'partial'
          : eligible.length === 0 && newBaselineRepositoryIds.length > 0
            ? 'baseline'
            : 'synced',
        events: issuedEvents,
        repositoryCount: eligible.length,
        eligibleRepositoryCount: eligibleCandidates.length,
        skippedRepositoryCount,
        /**
         * Only a committed checkpoint records a baseline. A partial result
         * carries no checkpoint, keeps the saved settings untouched, and will
         * register the same first-use repositories again on the resume, so
         * reporting them here made the panel say "N repositories registered"
         * about a write that never happened.
         */
        newBaselineRepositoryIds: partial ? [] : newBaselineRepositoryIds,
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
        verifiedEventProofDigests,
        checkpoint,
        ...(continuationToken ? { continuation: continuationToken } : {}),
      }
    }

    // Nothing to read: answer directly, with no stream to maintain.
    if (eligible.length === 0) {
      await readActivity()
      if (productAccountSnapshotPresent && (!requestedCompanionOwned || !requestedCompanionIsActive)) {
        return json(400, { error: 'activeCompanionId must be owned by the product account and match its active selection.' })
      }
      return json(200, buildBody())
    }

    // A sync can run for a long time, and a silent request is indistinguishable
    // from a frozen one. Progress is streamed as newline-delimited JSON so the
    // caller can show real movement instead of an indefinite spinner.
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      // A consumer that goes away must stop the GitHub reads, not merely the
      // response. Abandoning the response alone kept every remaining repository
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
            if (ownershipBlocked) {
              write({ type: 'error', status: 400, error: 'activeCompanionId must be owned by the product account and match its active selection.' })
              return
            }
            if (fetchStatus === 'partial') {
              if (continuationReady) {
                write({ type: 'result', payload: buildBody(true) })
              } else {
                write({
                  type: 'error',
                  status: 409,
                  error: 'GitHub activity window is incomplete. No baseline or checkpoint was recorded; sync again or retry shortly.',
                })
              }
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
