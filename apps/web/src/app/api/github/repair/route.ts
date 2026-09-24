/**
 * `POST /api/github/repair` — re-issue receipts for a bounded set of failed
 * product event IDs.
 *
 * The browser sends opaque IDs plus either the short-lived signed checkpoint
 * that originally named them or the old server receipt for each legacy event.
 * The server owns the repository selection, GitHub attribution, event
 * normalization, companion fallback, and receipt minting.
 * This route never advances a baseline or writes a product
 * snapshot; the normal product upload remains the transaction that commits the
 * signed checkpoint.
 */

import { NextRequest } from 'next/server'
import { asCompanionId } from '@/lib/game/events'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { fetchGitHubEvents, type GitHubEventsProgress, type GithubRepoRef } from '@/lib/game/github-events-fetch'
import { normalizeGitHubEvents } from '@/lib/game/github-events'
import { checkRateLimit } from '@/lib/game/api-cache'
import { getGithubAccountStore } from '@/lib/sync/github-account-store'
import { getGithubRepositoriesCached } from '@/lib/sync/github-repository-cache'
import { getProductStore } from '@/lib/sync/product-store'
import { trustStoredProductSnapshot } from '@/lib/sync/trusted-product-snapshot'
import { getSessionProvider } from '@/lib/sync/session'
import { requestAccountMatchesSession } from '@/lib/sync/request-account-guard'
import { productSnapshotEvent } from '@/lib/sync/product-snapshot'
import {
  issueVerifiedEventProof,
  verifiedEventProofPayloadDigest,
  verifyVerifiedEventProof,
} from '@/lib/sync/verified-event-proof'
import { MAX_CHECKPOINT_TOKEN_LENGTH, verifyGithubSyncCheckpoint } from '@/lib/sync/github-sync-checkpoint'
import {
  PRODUCT_EVENT_ID_PATTERN,
  MAX_RECEIPT_REPAIR_EVENT_IDS,
} from '@/lib/sync/github-receipt-repair'
import { selectGithubRepositoryWindow } from '@/lib/sync/github-source-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The signed checkpoint can legitimately be larger than a request header for
// a large account. Keep the repair envelope bounded, but leave room for that
// token plus the small bounded event-ID list.
const REPAIR_PAYLOAD_LIMIT_BYTES = MAX_CHECKPOINT_TOKEN_LENGTH + 8 * 1024
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60 * 1000

type RepairRequest = {
  readonly activeCompanionId: string
  readonly eventIds: readonly string[]
  readonly checkpoint: string | null
  readonly proofs: Readonly<Record<string, string>>
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRepairRequest(value: unknown): RepairRequest | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value).sort()
  if (
    keys.length !== 4 ||
    keys[0] !== 'activeCompanionId' ||
    keys[1] !== 'checkpoint' ||
    keys[2] !== 'eventIds' ||
    keys[3] !== 'proofs'
  ) return null
  if (typeof value.activeCompanionId !== 'string' || value.activeCompanionId.trim().length === 0) return null
  const checkpoint = value.checkpoint === null
    ? null
    : typeof value.checkpoint === 'string' && value.checkpoint.length > 0 && value.checkpoint.length <= MAX_CHECKPOINT_TOKEN_LENGTH
      ? value.checkpoint
      : undefined
  if (checkpoint === undefined) return null
  if (!Array.isArray(value.eventIds) || value.eventIds.length === 0 || value.eventIds.length > MAX_RECEIPT_REPAIR_EVENT_IDS) return null
  const eventIds = value.eventIds.map((eventId) => typeof eventId === 'string' ? eventId : '')
  if (!eventIds.every((eventId) => PRODUCT_EVENT_ID_PATTERN.test(eventId))) return null
  if (new Set(eventIds).size !== eventIds.length) return null
  if (!isRecord(value.proofs)) return null
  const proofs: Record<string, string> = {}
  for (const [eventId, proof] of Object.entries(value.proofs)) {
    if (
      !PRODUCT_EVENT_ID_PATTERN.test(eventId) ||
      !eventIds.includes(eventId) ||
      typeof proof !== 'string' ||
      proof.length === 0 ||
      proof.length > 128
    ) return null
    proofs[eventId] = proof
  }
  if (Object.keys(proofs).length > MAX_RECEIPT_REPAIR_EVENT_IDS) return null
  return {
    activeCompanionId: value.activeCompanionId.trim(),
    eventIds,
    checkpoint,
    proofs,
  }
}

function blocked(eventIds: readonly string[], reason: string): Array<{ eventId: string; reason: string }> {
  return eventIds.map((eventId) => ({ eventId, reason }))
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in with GitHub to repair receipts.' })
  if (!requestAccountMatchesSession(request, session.githubId)) {
    return json(409, { error: 'account_changed' })
  }

  const rateLimit = checkRateLimit(`github-receipt-repair:${session.githubId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (!rateLimit.allowed) return json(429, { error: 'Receipt repair limit reached. Try again shortly.' })

  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > REPAIR_PAYLOAD_LIMIT_BYTES) {
    return json(413, { error: 'Receipt repair payload is too large.' })
  }

  let payload: unknown
  try {
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > REPAIR_PAYLOAD_LIMIT_BYTES) {
      return json(413, { error: 'Receipt repair payload is too large.' })
    }
    payload = JSON.parse(raw) as unknown
  } catch {
    return json(400, { error: 'Body must be valid JSON.' })
  }
  const parsed = parseRepairRequest(payload)
  if (!parsed) {
    return json(400, {
      error: `Body must contain at most ${MAX_RECEIPT_REPAIR_EVENT_IDS} unique product event IDs, activeCompanionId, a signed checkpoint, and optional existing receipts.`,
    })
  }
  // A fresh checkpoint authorizes the IDs it names. For the long-lived legacy
  // case, an old server receipt is an equally strong capability: it must verify
  // against the provider-derived canonical event below before it can authorize
  // a repair. This lets an expired checkpoint be repaired without accepting
  // arbitrary historical event IDs.
  const checkpoint = parsed.checkpoint
    ? verifyGithubSyncCheckpoint(parsed.checkpoint, session.githubId)
    : null
  const checkpointEventIds = new Set(checkpoint?.eventIds ?? [])
  if (!checkpoint && parsed.eventIds.some((eventId) => !parsed.proofs[eventId])) {
    return json(400, { error: 'Receipt repair needs a valid signed checkpoint or an existing server receipt for every event.' })
  }
  if (checkpoint && parsed.eventIds.some((eventId) => !checkpointEventIds.has(eventId) && !parsed.proofs[eventId])) {
    return json(409, { error: 'Receipt repair events must come from the signed GitHub sync checkpoint or include an existing server receipt.' })
  }
  if (!PROTOTYPE_COMPANION_CATALOG.get(parsed.activeCompanionId)) {
    return json(400, { error: 'activeCompanionId is not a recognized companion.' })
  }

  try {
    const accountStore = getGithubAccountStore()
    const token = await accountStore.getToken(session.githubId)
    if (!token) return json(401, { error: 'GitHub access is unavailable. Reconnect GitHub.' })
    const settings = await accountStore.getSettings(session.githubId)

    // Repair is an authority check, not a best-effort cache read. A stale
    // listing can contain a repository whose access was revoked, so never mint
    // a receipt from it. The normal sync remains allowed to use its degraded
    // cache behavior; repair fails closed instead.
    const repositoryOutcome = await getGithubRepositoriesCached({
      githubId: session.githubId,
      token,
      force: true,
    })
    if (repositoryOutcome.result.status === 'unauthorized') {
      return json(401, { error: 'GitHub access was revoked or expired. Reconnect GitHub.' })
    }
    if (repositoryOutcome.result.status === 'rate-limited') {
      return json(429, { error: 'GitHub rate limit reached. Try again once the limit resets.' })
    }
    if (repositoryOutcome.result.status !== 'ok') {
      return json(502, { error: 'GitHub could not be reached. Try again shortly.' })
    }

    const window = selectGithubRepositoryWindow(repositoryOutcome.result.repositories, settings)
    if (repositoryOutcome.stale) {
      return json(200, {
        repaired: [],
        blocked: blocked(parsed.eventIds, 'repository-list-stale'),
        requestsDone: 0,
        repositoryCount: window.eligible.length,
        skippedRepositoryCount: window.skippedCount,
        syncStatus: 'unavailable',
        truncated: false,
      })
    }

    // A previously accepted event's companion is server-owned. If the cloud
    // row has no trusted copy (the incident's zero-event case), the active
    // companion is the only permitted fallback. The client separately checks
    // that fallback against its preserved local owner before replacing a proof.
    const existingGithubCompanionByEventId = new Map<string, string>()
    try {
      const record = await getProductStore().getRecord(session.githubId, session.handle)
      const trusted = record ? trustStoredProductSnapshot(record.snapshot, session.githubId) : null
      for (const event of trusted?.events ?? []) {
        if (event.source === 'github' && event.provenance === 'verified') {
          existingGithubCompanionByEventId.set(event.eventId, event.companionId)
        }
      }
    } catch {
      // A missing cloud row is expected during the incident recovery. Do not
      // turn an optional owner lookup into a receipt minting outage.
    }

    if (window.eligible.length === 0) {
      const reason = window.eligibleCandidateCount > 0
        ? 'outside-repair-window'
        : 'repository-not-tracked'
      return json(200, {
        repaired: [],
        blocked: blocked(parsed.eventIds, reason),
        requestsDone: 0,
        repositoryCount: 0,
        skippedRepositoryCount: window.skippedCount,
        syncStatus: 'ok',
        truncated: false,
      })
    }

    const requests: GithubRepoRef[] = window.eligible.map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
    }))
    let requestsDone = 0
    const fetched = await fetchGitHubEvents({
      login: session.handle,
      sourceId: String(session.githubId),
      repos: requests,
      token,
      onProgress: (progress: GitHubEventsProgress) => {
        requestsDone = Math.max(requestsDone, progress.requestsDone)
      },
    })

    const repairedById = new Map<string, {
      eventId: string
      proof: string
      payloadDigest: string
      event: ReturnType<typeof productSnapshotEvent>
    }>()
    const proofAuthorizedIds = new Set<string>()
    const ownerUnavailableIds = new Set<string>()
    if (
      fetched.status !== 'unavailable' &&
      fetched.input.sourceId === String(session.githubId) &&
      fetched.login.trim().toLowerCase() === session.handle.trim().toLowerCase()
    ) {
      const normalized = normalizeGitHubEvents({
        ...fetched.input,
        // Ignore the provider adapter's display companion and bind the repair
        // to the account's requested companion or an existing owner below.
        sourceId: String(session.githubId),
        companionId: asCompanionId(parsed.activeCompanionId),
      })
      const requested = new Set(parsed.eventIds)
      for (const event of normalized) {
        const candidate = productSnapshotEvent(event)
        if (!requested.has(candidate.eventId) || repairedById.has(candidate.eventId)) continue
        const existingProof = parsed.proofs[candidate.eventId]
        const storedOwner = existingGithubCompanionByEventId.get(candidate.eventId)
        let owner = storedOwner ?? parsed.activeCompanionId
        let ownedEvent = productSnapshotEvent({ ...event, companionId: asCompanionId(owner) })
        let proofAuthorizes = Boolean(
          existingProof && verifyVerifiedEventProof(ownedEvent, session.githubId, existingProof),
        )
        // If the cloud row is blank during recovery, the preserved server
        // receipt is the only trusted record of the original companion owner.
        // Try the catalog identities rather than silently rebinding an old
        // event to whichever companion happens to be active now.
        if (existingProof && !proofAuthorizes && !storedOwner) {
          for (const definition of PROTOTYPE_COMPANION_CATALOG.list()) {
            const candidateOwnedEvent = productSnapshotEvent({
              ...event,
              companionId: asCompanionId(definition.id),
            })
            if (verifyVerifiedEventProof(candidateOwnedEvent, session.githubId, existingProof)) {
              owner = definition.id
              ownedEvent = candidateOwnedEvent
              proofAuthorizes = true
              break
            }
          }
        }
        const checkpointAuthorizes = checkpointEventIds.has(candidate.eventId)
        // A checkpoint proves that the server observed this stable event, but
        // the legacy token does not bind its companion owner. Never mint a new
        // receipt for an ownerless checkpoint event: require either the
        // preserved receipt or a trusted cloud owner. The browser keeps the
        // event and can retry once that ownership evidence is available.
        // A preserved legacy receipt may have been signed over an older
        // canonical cap/metadata shape, so it can fail verification against
        // today's provider payload while still being the only ownership hint
        // the recovery has. The client must compare the returned owner-bound
        // payload with its preserved local event before upload. A checkpoint
        // with no receipt or cloud owner remains blocked.
        if (checkpointAuthorizes && !storedOwner && !proofAuthorizes && !existingProof) {
          ownerUnavailableIds.add(candidate.eventId)
          continue
        }
        if (!checkpointAuthorizes && !proofAuthorizes) continue
        if (proofAuthorizes) proofAuthorizedIds.add(candidate.eventId)
        const proof = issueVerifiedEventProof(ownedEvent, session.githubId)
        repairedById.set(candidate.eventId, {
          eventId: candidate.eventId,
          proof,
          payloadDigest: verifiedEventProofPayloadDigest(ownedEvent, session.githubId),
          event: ownedEvent,
        })
      }
    }

    const repaired = parsed.eventIds
      .map((eventId) => repairedById.get(eventId))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
    const repairedIds = new Set(repaired.map((item) => item.eventId))
    const blockedItems = parsed.eventIds
      .filter((eventId) => !repairedIds.has(eventId))
      .map((eventId) => ({
        eventId,
        reason: ownerUnavailableIds.has(eventId)
          ? 'event-owner-unavailable'
          : !checkpointEventIds.has(eventId) && proofAuthorizedIds.has(eventId)
            ? 'activity-not-found'
            : !checkpointEventIds.has(eventId) && parsed.proofs[eventId]
              ? 'legacy-receipt-invalid'
              : !checkpointEventIds.has(eventId)
                ? parsed.checkpoint && !checkpoint
                  ? 'checkpoint-invalid-or-expired'
                  : 'repair-authorization-missing'
                : fetched.status === 'unavailable'
                  ? 'activity-unavailable'
                  : fetched.status === 'partial'
                    ? 'activity-read-incomplete'
                    : window.skippedCount > 0
                      ? 'outside-repair-window-or-not-found'
                      : 'activity-not-found',
      }))

    return json(200, {
      repaired,
      // Also expose a bounded map for older panels/diagnostics that only keep
      // opaque receipts. The array remains the canonical response contract.
      verifiedEventProofs: Object.fromEntries(repaired.map((item) => [item.eventId, item.proof])),
      blocked: blockedItems,
      requestsDone,
      repositoryCount: window.eligible.length,
      eligibleRepositoryCount: window.eligibleCandidateCount,
      skippedRepositoryCount: window.skippedCount,
      syncStatus: fetched.status,
      truncated: fetched.truncated,
    })
  } catch {
    return json(500, { error: 'GitHub receipt repair could not be completed.' })
  }
}
