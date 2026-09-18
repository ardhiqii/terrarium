/**
 * `POST /api/sync/product` — persist a signed-in user's richer product
 * companion snapshot, merging it with the stored server copy without
 * double-counting events.
 *
 * WHY THIS SEPARATE ROUTE: the legacy `/api/sync` persists the old closed
 * `SyncedSnapshot`. The product sync contract (`ProductSnapshot`, see
 * `product-snapshot.ts`) is a different, richer derived-only shape with its
 * own validator and a real merge function (`mergeGuestWithServer`). Keeping a
 * dedicated route + store for it avoids widening the frozen legacy `types.ts`
 * contract and lets the two sync layers evolve independently.
 *
 * THE PRIVACY BOUNDARY is identical to the legacy route: only a `ProductSnapshot`
 * (numbers, enums, and hashes — no note titles, contents, paths, or tags) is
 * ever accepted. The handle comes from the signed-in SESSION, never the body.
 * The body is validated against the exact closed shape before anything is
 * stored.
 *
 * THE CHECKPOINT TRAVELS IN THE BODY. The signed checkpoint that defers the
 * GitHub baseline commit is sent as `{ snapshot, checkpoint }`; a bare
 * `ProductSnapshot` body and the deprecated `x-github-sync-checkpoint` header
 * remain accepted for older clients. It used to be header-only, and a real
 * account's checkpoint is tens of kilobytes, so the request was rejected
 * upstream with a bodyless 500 and the baseline was never committed.
 */

import { NextRequest } from 'next/server'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { getGithubAccountStore } from '@/lib/sync/github-account-store'
import { getSessionProvider } from '@/lib/sync/session'
import { getProductStore } from '@/lib/sync/product-store'
import {
  deserializeProductSnapshot,
  mergeProductSnapshots,
  PRODUCT_SNAPSHOT_SCHEMA_VERSION,
  type ProductSnapshot,
  type ProductSnapshotCompanion,
  type ProductSnapshotEvent,
  restoreProductStateFromSnapshot,
} from '@/lib/sync/product-snapshot'
import { checkRateLimit } from '@/lib/game/api-cache'
import {
  MAX_CHECKPOINT_TOKEN_LENGTH,
  verifyGithubSyncCheckpoint,
} from '@/lib/sync/github-sync-checkpoint'
import { verifiedEventProofPayloadDigest, verifyVerifiedEventProof } from '@/lib/sync/verified-event-proof'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60 * 1000
/**
 * Payload cap for the snapshot plus its checkpoint.
 *
 * The snapshot is cumulative (it carries every event ID the account has ever
 * earned), so a small fixed cap becomes a late failure: a 44-repository account
 * already reaches about 296 KB of snapshot plus a 36 KB checkpoint after a
 * month of activity. This is a deliberately generous bound; the deployment
 * (docker-compose node server behind a Cloudflare tunnel) admits far larger
 * bodies, and anything past the bound is refused with an explicit message
 * instead of a baseline that silently never commits.
 */
const PRODUCT_PAYLOAD_LIMIT_BYTES = 2 * 1024 * 1024 // 2 MB cap on the request body
/**
 * Bound for the deprecated checkpoint header.
 *
 * A real account's checkpoint is tens of kilobytes (measured ~21 KB at 500
 * events), which exceeds the request-header budget of the platform in front of
 * the function and came back as a bodyless 500 before the route ever ran --
 * the baseline was then never committed. The current client sends the
 * checkpoint inside the body instead; the header stays readable only so an
 * already-loaded older tab can still finish a small upload.
 */
const LEGACY_CHECKPOINT_HEADER_LIMIT = 64 * 1024

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/**
 * Parsed request body.
 *
 * Two shapes are accepted:
 *   - the current envelope `{ snapshot, checkpoint? }`, and
 *   - the legacy bare `ProductSnapshot`, which predates the checkpoint field.
 * Either way the snapshot goes through the same closed-schema validator and the
 * token through the same HMAC verifier, so the tamper-proof property does not
 * depend on which shape arrived.
 */
type ParsedProductBody =
  | { readonly status: 'ok'; readonly snapshot: ProductSnapshot; readonly checkpoint: string | null }
  | { readonly status: 'invalid-snapshot' }
  | { readonly status: 'invalid-checkpoint' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the snapshot (and optional signed checkpoint) from the raw body.
 *
 * Rejects rather than coerces: an envelope whose `checkpoint` is present but
 * not a string is a client bug, and silently dropping it would look like a
 * successful upload that quietly never commits the baseline.
 */
function parseProductBody(raw: string): ParsedProductBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'invalid-snapshot' }
  }

  if (isRecord(parsed) && 'snapshot' in parsed) {
    const candidate = typeof parsed.snapshot === 'string'
      ? parsed.snapshot
      : JSON.stringify(parsed.snapshot)
    const snapshot = deserializeProductSnapshot(candidate)
    if (!snapshot) return { status: 'invalid-snapshot' }
    if (parsed.checkpoint === undefined || parsed.checkpoint === null) {
      return { status: 'ok', snapshot, checkpoint: null }
    }
    if (typeof parsed.checkpoint !== 'string' || parsed.checkpoint.length === 0) {
      return { status: 'invalid-checkpoint' }
    }
    return { status: 'ok', snapshot, checkpoint: parsed.checkpoint }
  }

  // Legacy bare-snapshot body. The deserializer needs the original text, not a
  // re-serialization, so the raw body is passed through unchanged.
  const legacy = deserializeProductSnapshot(raw)
  return legacy
    ? { status: 'ok', snapshot: legacy, checkpoint: null }
    : { status: 'invalid-snapshot' }
}

function sameTimestampMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && left[key] === right[key],
  )
}

function trustStoredEvents(snapshot: ProductSnapshot, githubId: number): ProductSnapshot {
  let changed = false
  const events = snapshot.events.flatMap((event): ProductSnapshotEvent[] => {
    const trustedGithub = event.source === 'github' &&
      event.provenance === 'verified' &&
      Boolean(event.verifiedProof) &&
      verifyVerifiedEventProof(event, githubId, event.verifiedProof as string)
    // GitHub is never a local source. Any unverified or invalid event must be
    // removed instead of downgraded, otherwise its already-derived XP survives
    // the receipt boundary through the companion totals.
    if (event.source === 'github' && !trustedGithub) {
      changed = true
      return []
    }
    if (event.provenance !== 'verified') return [event]
    changed = true
    // Verified provenance is meaningful only for server-issued GitHub
    // receipts. Remove malformed legacy records from every other source too.
    return []
  })
  if (!changed) return snapshot

  // Encounter draws do not carry a source-event foreign key in the compact
  // product contract. Once an untrusted event is removed, the safe choice is
  // to invalidate encounter-derived rewards rather than let an old draw,
  // essence balance, or collectible survive the receipt boundary.
  const sanitized = {
    ...snapshot,
    events,
    collection: snapshot.collection.filter((reference) => reference.acquisition !== 'encounter'),
    encounters: {
      ...snapshot.encounters,
      meter: 0,
      totalProgress: 0,
      nextSequence: 0,
      draws: [],
      processedTriggerIds: [],
      essenceByFamily: {},
    },
  }
  const fallbackProfile = createGuestProfile({
    guestId: snapshot.guestId,
    starterCompanionId: snapshot.activeCompanionId,
    now: snapshot.createdAt,
  })
  const rebuilt = restoreProductStateFromSnapshot(
    sanitized,
    fallbackProfile,
    PROTOTYPE_COMPANION_CATALOG,
  )
  const rebuiltById = new Map(rebuilt.companions.map((companion) => [companion.companionId, companion]))
  const companions = snapshot.companions.flatMap((companion): ProductSnapshotCompanion[] => {
    const current = rebuiltById.get(companion.companionId)
    if (!current) return []
    return [{
      ...companion,
      xp: current.xp,
      essence: current.essence,
      encounterCount: current.encounterCount,
      progression: current.progression
        ? {
            stepId: current.progression.step.id,
            formId: current.progression.form.id,
          nextStepId: current.progression.nextStep?.id ?? null,
          nextFormId: current.progression.nextForm?.id ?? null,
        }
        : null,
    }]
  })
  const activeCompanionId = rebuilt.activeCompanion?.companionId ?? sanitized.collection[0]?.companionId ?? snapshot.activeCompanionId
  return { ...sanitized, activeCompanionId, companions }
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })

  const rl = checkRateLimit(`product-sync-write:${session.handle}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (!rl.allowed) return json(429, { error: 'Rate limit exceeded. Try again shortly.' })

  // Guard the body size before parsing (derived snapshots can be large with many events).
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > PRODUCT_PAYLOAD_LIMIT_BYTES) {
    return json(413, { error: 'Payload too large.' })
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return json(400, { error: 'Request body could not be read.' })
  }

  if (raw.length > PRODUCT_PAYLOAD_LIMIT_BYTES) {
    return json(413, { error: 'Payload too large.' })
  }

  const parsed = parseProductBody(raw)
  if (parsed.status === 'invalid-checkpoint') {
    return json(400, { error: 'Sync checkpoint must be a signed token.' })
  }
  if (parsed.status !== 'ok') {
    return json(400, { error: 'Body must be a valid ProductSnapshot.' })
  }
  const incoming = parsed.snapshot
  if (incoming.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION) {
    return json(400, {
      error: `schemaVersion ${incoming.schemaVersion} is newer than this server supports (${PRODUCT_SNAPSHOT_SCHEMA_VERSION}).`,
    })
  }

  /**
   * Why one event was rejected. Naming the reason and the event matters: a
   * generic 400 made a payload that no longer matches look identical to a
   * deployment whose signing key changed, and both were indistinguishable
   * from a client that simply forgot to attach a receipt. The payload digest
   * is a one-way hash of the client's own event, so it is safe to return and
   * is directly comparable with the mint-side digest the sync route reports.
   */
  const receiptFailure = (event: ProductSnapshotEvent): string | null => {
    if (event.source === 'github') {
      if (event.provenance !== 'verified') return 'provenance-not-verified'
      if (!event.verifiedProof) return 'missing-receipt'
      return verifyVerifiedEventProof(event, session.githubId, event.verifiedProof) ? null : 'receipt-mismatch'
    }
    return event.provenance === 'verified' ? 'source-cannot-be-verified' : null
  }
  const failedEvents = incoming.events
    .map((event) => ({ event, reason: receiptFailure(event) }))
    .filter((entry): entry is { event: ProductSnapshotEvent; reason: string } => entry.reason !== null)
  if (failedEvents.length > 0) {
    return json(400, {
      error: 'Verified GitHub events must include a server-issued receipt.',
      // Bounded: a client must never be able to turn one request into a large
      // response, and the first failures are enough to identify the cause.
      receiptFailures: failedEvents.slice(0, 5).map(({ event, reason }) => ({
        eventId: event.eventId,
        reason,
        payloadDigest: verifiedEventProofPayloadDigest(event, session.githubId),
      })),
      receiptFailureCount: failedEvents.length,
    })
  }

  const legacyHeaderToken = request.headers.get('x-github-sync-checkpoint')
  if (legacyHeaderToken && legacyHeaderToken.length > LEGACY_CHECKPOINT_HEADER_LIMIT) {
    return json(413, { error: 'Sync checkpoint is too large.' })
  }
  // The body token wins: a legacy header is bounded by the request-header
  // budget and can be truncated or rejected before the route sees it.
  const checkpointToken = parsed.checkpoint ?? legacyHeaderToken
  if (checkpointToken && checkpointToken.length > MAX_CHECKPOINT_TOKEN_LENGTH) {
    return json(413, { error: 'Sync checkpoint is too large.' })
  }
  const checkpoint = checkpointToken
    ? verifyGithubSyncCheckpoint(checkpointToken, session.githubId)
    : null
  if (checkpointToken && !checkpoint) return json(400, { error: 'Sync checkpoint is invalid or expired.' })
  if (checkpoint) {
    const checkpointEventIds = new Set(checkpoint.eventIds)
    const incomingEventIds = new Set(incoming.events.map((event) => event.eventId))
    if ([...checkpointEventIds].some((eventId) => !incomingEventIds.has(eventId))) {
      return json(409, { error: 'Sync checkpoint events are missing from the product snapshot.' })
    }
    const currentSettings = await getGithubAccountStore().getSettings(session.githubId)
    if (
      !sameTimestampMap(currentSettings.baselineByRepositoryId, checkpoint.previousBaselineByRepositoryId) &&
      !sameTimestampMap(currentSettings.baselineByRepositoryId, checkpoint.nextBaselineByRepositoryId)
    ) {
      return json(409, { error: 'GitHub activity changed while this condition was being saved. Sync again.' })
    }
  }

  const store = getProductStore()
  const handle = session.handle.toLowerCase()

  // Retry a short optimistic-concurrency window. This keeps two tabs/devices
  // from silently replacing one another's event history while preserving the
  // simple provider-neutral store contract.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const serverRecord = await store.getRecord(session.githubId, handle)
    const server = serverRecord ? trustStoredEvents(serverRecord.snapshot, session.githubId) : null
    if (server && server.guestId !== incoming.guestId) {
      return json(409, { error: 'This GitHub account already has a different guest profile.' })
    }
    const merged = server ? mergeProductSnapshots(incoming, server) : incoming
    const saved = await store.put(
      session.githubId,
      handle,
      merged,
      new Date().toISOString(),
      serverRecord?.updatedAt ?? null,
    )
    if (saved) {
      if (checkpoint) {
        const advanced = await getGithubAccountStore().advanceBaseline(
          session.githubId,
          checkpoint.previousBaselineByRepositoryId,
          checkpoint.nextBaselineByRepositoryId,
          checkpoint.nextLastSyncedAt,
        )
        if (!advanced) {
          return json(409, { error: 'GitHub activity changed while this condition was being saved. Sync again.' })
        }
      }
      return json(200, merged)
    }
  }

  return json(409, { error: 'This condition changed on another device. Sync again to merge the latest state.' })
}

export async function GET(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  const record = await getProductStore().getRecord(session.githubId, session.handle)
  const snapshot = record ? trustStoredEvents(record.snapshot, session.githubId) : null
  if (!snapshot) return json(404, { error: 'This account has never synced the product snapshot.' })
  return json(200, snapshot)
}

export async function DELETE(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  await getProductStore().remove(session.githubId, session.handle)
  return json(204, undefined)
}
