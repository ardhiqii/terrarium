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
import { requestAccountMatchesSession } from '@/lib/sync/request-account-guard'
import { trustStoredProductSnapshot } from '@/lib/sync/trusted-product-snapshot'
import {
  buildProductSnapshot,
  deserializeProductSnapshot,
  mergeProductSnapshots,
  PRODUCT_SNAPSHOT_SCHEMA_VERSION,
  restoreProductStateFromSnapshot,
  validateProductSnapshot,
  validateProductSnapshotForCatalog,
  toOpaqueProductId,
  type ProductSnapshot,
  type ProductSnapshotEvent,
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
const DELETE_PAYLOAD_LIMIT_BYTES = 4 * 1024
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

function json(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined
      ? { 'Cache-Control': 'no-store, private', ...extraHeaders }
      : {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, private',
          ...extraHeaders,
        },
  })
}

function storageUnavailable(): Response {
  return json(503, { error: 'storage_unavailable' })
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

/**
 * Recompute the derived companion fields at the storage boundary. The browser
 * normally sends a snapshot built by the same engine, but XP, progression,
 * and encounter counts are not trusted merely because the outer shape passed
 * validation. Preserve the opaque baseline/warning fields and the receipts
 * while rebuilding the fields that can be derived from the event ledger.
 */
function unknownCompanionIds(snapshot: ProductSnapshot): string[] {
  const ids = new Set<string>([
    snapshot.activeCompanionId,
    snapshot.activeSelection.companionId,
    ...snapshot.companions.map((companion) => companion.companionId),
    ...snapshot.collection.map((reference) => reference.companionId),
    ...snapshot.legacyCredits.map((credit) => credit.companionId),
    ...snapshot.events.map((event) => event.companionId),
    ...snapshot.encounters.draws.flatMap((draw) => [
      draw.selectedCompanionId,
      ...draw.weights.map((weight) => weight.companionId),
    ]),
  ])
  return [...ids].filter((id) => !PROTOTYPE_COMPANION_CATALOG.get(id)).sort()
}

function unownedCompanionIds(snapshot: ProductSnapshot): string[] {
  const owned = new Set(snapshot.collection.map((reference) => reference.companionId))
  const referenced = new Set([
    snapshot.activeCompanionId,
    snapshot.activeSelection.companionId,
    ...snapshot.companions.map((companion) => companion.companionId),
    ...snapshot.legacyCredits.map((credit) => credit.companionId),
    ...snapshot.events.map((event) => event.companionId),
    ...snapshot.encounters.draws.map((draw) => draw.selectedCompanionId),
  ])
  return [...referenced].filter((id) => !owned.has(id)).sort()
}

function hasIncompleteEncounterWeights(snapshot: ProductSnapshot): boolean {
  const catalogIds = new Set(PROTOTYPE_COMPANION_CATALOG.list().map((definition) => definition.id))
  return snapshot.encounters.draws.some((draw) => {
    const weightIds = new Set(draw.weights.map((weight) => weight.companionId))
    return weightIds.size !== draw.weights.length || weightIds.size !== catalogIds.size || [...catalogIds].some((id) => !weightIds.has(id))
  })
}

function canonicalLegacyFingerprint(value: string): string {
  // Migration credits already carry a bounded, non-reversible fingerprint.
  // Rehashing it changes the trust-boundary format and makes a legitimate
  // server-issued migration disappear on the next product upload.
  return /^legacy:[0-9a-f]{8}-[0-9a-f]{8}$/u.test(value)
    ? value
    : toOpaqueProductId(value, 'fingerprint')
}

function normalizeOpaqueSnapshotFields(snapshot: ProductSnapshot): ProductSnapshot {
  return {
    ...snapshot,
    legacyCredits: snapshot.legacyCredits.map((credit) => ({
      ...credit,
      sourceFingerprint: canonicalLegacyFingerprint(credit.sourceFingerprint),
    })),
    sourceBaselines: snapshot.sourceBaselines.map((baseline) => ({
      ...baseline,
      sourceIdHash: toOpaqueProductId(baseline.sourceIdHash, 'source'),
      fingerprintHash: toOpaqueProductId(baseline.fingerprintHash, 'fingerprint'),
    })),
    events: snapshot.events.map((event) => ({
      ...event,
      eventId: toOpaqueProductId(event.eventId, 'event'),
      ...(event.cap ? { cap: { ...event.cap, key: toOpaqueProductId(event.cap.key, 'cap') } } : {}),
      ...(event.metadata
        ? {
            metadata: {
              ...event.metadata,
              ...(event.metadata.repositoryIdHash
                ? { repositoryIdHash: toOpaqueProductId(event.metadata.repositoryIdHash, 'repo') }
                : {}),
              ...(event.metadata.linkedPullRequestIdHash
                ? { linkedPullRequestIdHash: toOpaqueProductId(event.metadata.linkedPullRequestIdHash, 'pr') }
                : {}),
              ...(event.metadata.pullRequestIdHash
                ? { pullRequestIdHash: toOpaqueProductId(event.metadata.pullRequestIdHash, 'pr') }
                : {}),
            },
          }
        : {}),
    })),
    encounters: {
      ...snapshot.encounters,
      processedTriggerIds: snapshot.encounters.processedTriggerIds.map((id) => toOpaqueProductId(id, 'trigger')),
      progressByTriggerId: Object.fromEntries(
        Object.entries(snapshot.encounters.progressByTriggerId ?? {})
          .map(([id, progress]) => [toOpaqueProductId(id, 'trigger'), progress]),
      ),
      draws: snapshot.encounters.draws.map((draw) => ({
        ...draw,
        id: toOpaqueProductId(draw.id, 'draw'),
        triggerId: toOpaqueProductId(draw.triggerId, 'trigger'),
        seed: toOpaqueProductId(draw.seed, 'seed'),
      })),
    },
  }
}

/**
 * Client snapshots are derived state, but migration credits and history
 * references are server-owned. A browser may replay a credit already present
 * in the account row; it may not mint a new aggregate grant or history-owned
 * companion by posting a catalog-valid payload.
 */
function sanitizeIncomingSnapshot(
  snapshot: ProductSnapshot,
  server: ProductSnapshot | null,
): ProductSnapshot {
  // Migration credits and collection references are server-owned. Matching an
  // opaque reference ID is not enough: a client can replay that ID with a
  // different companion, acquisition, or timestamp. Copy the complete trusted
  // server reference and ignore every conflicting client version. Keeping the
  // full server collection also prevents omission from deleting ownership.
  const collection = server
    ? server.collection.map((reference) => ({ ...reference }))
    : [
        snapshot.collection.find((reference) => reference.acquisition === 'starter') ?? {
          referenceId: `${snapshot.guestId}:starter`,
          companionId: 'pikachu-family',
          acquiredAt: snapshot.createdAt,
          acquisition: 'starter' as const,
        },
      ]
  const owned = new Set(collection.map((reference) => reference.companionId))
  const legacyCredits = server
    ? server.legacyCredits.map((credit) => ({ ...credit }))
    : []
  const companions = server
    ? [
        ...server.companions.map((companion) => ({ ...companion })),
        ...snapshot.companions
          .filter((companion) => owned.has(companion.companionId))
          .filter((companion) => !server.companions.some((trusted) => trusted.companionId === companion.companionId)),
      ]
    : snapshot.companions.filter((companion) => owned.has(companion.companionId))
  const activeCompanionId = server && owned.has(server.activeCompanionId)
    ? server.activeCompanionId
    : owned.has(snapshot.activeCompanionId)
      ? snapshot.activeCompanionId
      : collection[0].companionId
  const activeSelection = server && server.activeSelection.companionId === activeCompanionId
    ? { ...server.activeSelection }
    : activeCompanionId === snapshot.activeCompanionId && owned.has(snapshot.activeSelection.companionId)
      ? { ...snapshot.activeSelection }
      : {
          companionId: activeCompanionId,
          provenance: collection.find((reference) => reference.companionId === activeCompanionId && reference.acquisition === 'starter')
            ? 'starter' as const
            : 'user' as const,
          selectedAt: snapshot.updatedAt,
        }
  // Encounter draws and Essence are rewards, not client-authenticated facts.
  // Existing account rows remain authoritative for all encounter state. On a
  // first upload only bounded meter/progress evidence is retained; draws and
  // their reward aggregate are never minted by the upload itself.
  const encounters = server
    ? {
        ...server.encounters,
        processedTriggerIds: [...server.encounters.processedTriggerIds],
        draws: [...server.encounters.draws],
        essenceByFamily: { ...server.encounters.essenceByFamily },
      }
    : {
        meter: snapshot.encounters.meter,
        totalProgress: snapshot.encounters.totalProgress,
        nextSequence: snapshot.encounters.nextSequence,
        draws: [],
        processedTriggerIds: snapshot.encounters.processedTriggerIds,
        essenceByFamily: {},
        progressByTriggerId: { ...snapshot.encounters.progressByTriggerId },
      }
  return normalizeOpaqueSnapshotFields({
    ...snapshot,
    activeCompanionId,
    activeSelection,
    ...(server?.migrationVersion ?? (legacyCredits.length > 0 ? snapshot.migrationVersion : undefined)
      ? { migrationVersion: server?.migrationVersion ?? snapshot.migrationVersion }
      : {}),
    legacyCredits,
    companions,
    collection,
    ...(server ? { catalogVersion: server.catalogVersion } : {}),
    events: snapshot.events.filter((event) => owned.has(event.companionId)),
    encounters,
  })
}

function canonicalizeDerivedSnapshot(snapshot: ProductSnapshot): ProductSnapshot {
  const fallbackProfile = createGuestProfile({
    guestId: snapshot.guestId,
    starterCompanionId: snapshot.activeCompanionId,
    now: snapshot.createdAt,
  })
  const state = restoreProductStateFromSnapshot(
    snapshot,
    fallbackProfile,
    PROTOTYPE_COMPANION_CATALOG,
  )
  const proofs = Object.fromEntries(
    snapshot.events.flatMap((event) => event.verifiedProof
      ? [[event.eventId, event.verifiedProof] as const]
      : []),
  )
  const rebuilt = buildProductSnapshot(state, snapshot.generatedAt, proofs)
  const canonical: ProductSnapshot = {
    ...rebuilt,
    guestId: snapshot.guestId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    generatedAt: snapshot.generatedAt,
    activeCompanionId: snapshot.activeCompanionId,
    sourceBaselines: snapshot.sourceBaselines,
    recoverabilityWarning: snapshot.recoverabilityWarning,
  }
  validateProductSnapshot(canonical)
  return canonical
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  if (!requestAccountMatchesSession(request, session.githubId)) {
    return json(409, { error: 'account_changed' })
  }

  const rl = checkRateLimit(`product-sync-write:${session.githubId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
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

  if (Buffer.byteLength(raw, 'utf8') > PRODUCT_PAYLOAD_LIMIT_BYTES) {
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
    const checkpointEvents = new Map(incoming.events.map((event) => [event.eventId, event]))
    const checkpointEventIds = new Set(checkpoint.eventIds)
    if ([...checkpointEventIds].some((eventId) => !checkpointEvents.has(eventId))) {
      return json(409, { error: 'Sync checkpoint events are missing from the product snapshot.' })
    }
    if ([...checkpointEventIds].some((eventId) => {
      const event = checkpointEvents.get(eventId)
      // A signed checkpoint is a baseline commit for verified GitHub activity,
      // not a generic list of client-chosen IDs. This closes the substitution
      // gap where a local event reused a checkpoint ID and advanced the source
      // baseline without carrying the server-issued receipt.
      return !event || event.source !== 'github' || event.provenance !== 'verified' || !event.verifiedProof
    })) {
      return json(409, { error: 'Sync checkpoint events must be verified GitHub events.' })
    }
    try {
      const currentSettings = await getGithubAccountStore().getSettings(session.githubId)
      if (
        !sameTimestampMap(currentSettings.baselineByRepositoryId, checkpoint.previousBaselineByRepositoryId) &&
        !sameTimestampMap(currentSettings.baselineByRepositoryId, checkpoint.nextBaselineByRepositoryId)
      ) {
        return json(409, { error: 'GitHub activity changed while this condition was being saved. Sync again.' })
      }
    } catch {
      return storageUnavailable()
    }
  }

  const handle = session.handle.toLowerCase()

  // Retry a short optimistic-concurrency window. This keeps two tabs/devices
  // from silently replacing one another's event history while preserving the
  // simple provider-neutral store contract. Sanitization is deliberately
  // repeated inside the retry: a concurrent writer may have added a trusted
  // collection reference after the first read.
  try {
    const store = getProductStore()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const serverRecord = await store.getRecord(session.githubId, handle)
      const server = serverRecord ? trustStoredProductSnapshot(serverRecord.snapshot, session.githubId) : null
      // A first upload has no trusted ownership source, so it must prove its
      // own collection. Once an account row exists, these checks are deferred
      // until after server-owned references have replaced conflicting client
      // fields; otherwise a forged version of a trusted starter ID would be
      // rejected before it could be safely ignored.
      if (!server) {
        const unknownIds = unknownCompanionIds(incoming)
        if (unknownIds.length > 0) {
          return json(400, { error: 'Product snapshot contains an unrecognized companion.', companionIds: unknownIds.slice(0, 5) })
        }
        const unownedIds = unownedCompanionIds(incoming)
        if (unownedIds.length > 0 || hasIncompleteEncounterWeights(incoming)) {
          return json(400, { error: 'Product snapshot references a companion outside its collection.', companionIds: unownedIds.slice(0, 5) })
        }
        try {
          validateProductSnapshotForCatalog(incoming, PROTOTYPE_COMPANION_CATALOG)
        } catch {
          return json(400, { error: 'Product snapshot active companion or migration credit is invalid.' })
        }
      }
      let canonicalIncoming: ProductSnapshot
      try {
        canonicalIncoming = canonicalizeDerivedSnapshot(sanitizeIncomingSnapshot(incoming, server))
      } catch {
        return json(400, { error: 'Product snapshot is inconsistent after server-owned fields were sanitized.' })
      }
      if (server && server.guestId !== canonicalIncoming.guestId) {
        return json(409, { error: 'This GitHub account already has a different guest profile.' })
      }
      let merged: ProductSnapshot
      try {
        merged = server ? mergeProductSnapshots(canonicalIncoming, server) : canonicalIncoming
      } catch {
        // Two individually valid snapshots can still exceed a cumulative
        // bound when their event IDs are unioned. That is a retryable conflict,
        // not a storage outage and must not be reported as one.
        return json(409, { error: 'This condition is too large to merge in one upload. Sync again from the latest account state.' })
      }
      const authoritative = server
        ? {
            ...merged,
            // Selection changes are committed by the account activation path;
            // an uploaded snapshot, even with a future selectedAt, cannot
            // replace the trusted server selection.
            activeCompanionId: server.activeCompanionId,
            activeSelection: { ...server.activeSelection },
          }
        : merged
      try {
        // The structural validator protects the transport. This second check
        // protects the catalog/ownership invariant after merge, where a
        // conflicting client collection reference could otherwise make a
        // formerly owned companion appear newly acquired.
        validateProductSnapshotForCatalog(authoritative, PROTOTYPE_COMPANION_CATALOG)
      } catch {
        return json(400, { error: 'Product snapshot is invalid after merge.' })
      }
      if (checkpoint) {
        const authoritativeEventIds = new Set(authoritative.events.map((event) => event.eventId))
        if (checkpoint.eventIds.some((eventId) => !authoritativeEventIds.has(eventId))) {
          // Sanitization may intentionally discard a client event. Never
          // advance the GitHub baseline for a signed checkpoint whose events
          // did not survive the trusted merge.
          return json(409, { error: 'Sync checkpoint events were discarded by the trusted product merge.' })
        }
      }
      const saved = await store.put(
        session.githubId,
        handle,
        authoritative,
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
        return json(200, authoritative)
      }
    }
  } catch {
    return storageUnavailable()
  }

  return json(409, { error: 'This condition changed on another device. Sync again to merge the latest state.' })
}

export async function GET(request?: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  if (!requestAccountMatchesSession(request, session.githubId)) {
    return json(409, { error: 'account_changed' })
  }
  try {
    const record = await getProductStore().getRecord(session.githubId, session.handle)
    const snapshot = record ? trustStoredProductSnapshot(record.snapshot, session.githubId) : null
    if (!record || !snapshot) return json(404, { error: 'This account has never synced the product snapshot.' })
    return json(200, snapshot, { 'X-Product-Snapshot-Version': record.version })
  } catch {
    return storageUnavailable()
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  if (!requestAccountMatchesSession(request, session.githubId)) {
    return json(409, { error: 'account_changed' })
  }

  // The identity chooser's destructive "Use this browser" action supplies the
  // server row version it just displayed. Deletion without that version is
  // rejected so a stale caller cannot erase newer cloud progress.
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > DELETE_PAYLOAD_LIMIT_BYTES) {
    return json(413, { error: 'Delete payload too large.' })
  }
  let expectedVersion: string | null = request.headers.get('x-product-snapshot-version')
  try {
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > DELETE_PAYLOAD_LIMIT_BYTES) {
      return json(413, { error: 'Delete payload too large.' })
    }
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed) && parsed.expectedVersion !== undefined) {
        if (typeof parsed.expectedVersion !== 'string' || parsed.expectedVersion.length === 0) {
          return json(400, { error: 'Product snapshot version must be a non-empty string.' })
        }
        expectedVersion = parsed.expectedVersion
      }
    }
  } catch {
    return json(400, { error: 'Delete body must be valid JSON.' })
  }

  if (expectedVersion === null) {
    return json(428, { error: 'A current product snapshot version is required before deleting.' })
  }
  try {
    const store = getProductStore()
    // The version check and delete must be one conditional store operation; a
    // read followed by an unconditional delete has a race between them.
    const deleted = await store.removeIfVersion(session.githubId, expectedVersion)
    if (!deleted) {
      return json(409, { error: 'Cloud condition changed on another device. Review it again before deleting.' })
    }
    return json(204, undefined)
  } catch {
    return storageUnavailable()
  }
}
