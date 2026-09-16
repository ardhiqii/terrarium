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
import { verifyGithubSyncCheckpoint } from '@/lib/sync/github-sync-checkpoint'
import { verifyVerifiedEventProof } from '@/lib/sync/verified-event-proof'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const PRODUCT_PAYLOAD_LIMIT_BYTES = 512 * 1024 // 512 KB cap on the snapshot JSON

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** Try to parse a `ProductSnapshot` from an unknown value. Returns null on failure. */
function parseProductPayload(value: unknown): ProductSnapshot | null {
  // First round-trip a string body through the deserializer (validates the
  // exact closed schema). Non-string bodies are rejected up front.
  if (typeof value !== 'string') return null
  return deserializeProductSnapshot(value)
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

  const incoming = parseProductPayload(raw)
  if (!incoming) {
    return json(400, { error: 'Body must be a valid ProductSnapshot.' })
  }
  if (incoming.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION) {
    return json(400, {
      error: `schemaVersion ${incoming.schemaVersion} is newer than this server supports (${PRODUCT_SNAPSHOT_SCHEMA_VERSION}).`,
    })
  }

  const untrustedEvent = incoming.events.find((event) =>
    event.source === 'github'
      ? event.provenance !== 'verified' ||
        !event.verifiedProof ||
        !verifyVerifiedEventProof(event, session.githubId, event.verifiedProof)
      : event.provenance === 'verified',
  )
  if (untrustedEvent) {
    return json(400, { error: 'Verified GitHub events must include a server-issued receipt.' })
  }

  const checkpointToken = request.headers.get('x-github-sync-checkpoint')
  if (checkpointToken && checkpointToken.length > 64 * 1024) return json(413, { error: 'Sync checkpoint is too large.' })
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
