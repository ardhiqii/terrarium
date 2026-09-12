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
import { getSessionProvider } from '@/lib/sync/session'
import { getProductStore } from '@/lib/sync/product-store'
import {
  deserializeProductSnapshot,
  mergeProductSnapshots,
  PRODUCT_SNAPSHOT_SCHEMA_VERSION,
  type ProductSnapshot,
} from '@/lib/sync/product-snapshot'
import { checkRateLimit } from '@/lib/game/api-cache'

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

  const store = getProductStore()
  const handle = session.handle.toLowerCase()

  // Load the existing server copy, then merge without double-counting.
  const server = await store.get(handle)
  const now = new Date().toISOString()

  if (server) {
    // mergeProductSnapshots requires matching guestId.
    if (server.guestId !== incoming.guestId) {
      // A different guest on the same account: treat as a fresh baseline but
      // reject replacing the server copy would silently drop history.
      return json(409, { error: 'This GitHub account already has a different guest profile.' })
    }
    const merged = mergeProductSnapshots(incoming, server)
    await store.put(handle, merged, now)
    return json(200, merged)
  }

  // No server copy yet: this is the first sync. Persist the incoming mergeable copy.
  await store.put(handle, incoming, now)
  return json(200, incoming)
}

export async function GET(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  const snapshot = await getProductStore().get(session.handle.toLowerCase())
  if (!snapshot) return json(404, { error: 'This account has never synced the product snapshot.' })
  return json(200, snapshot)
}

export async function DELETE(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  await getProductStore().remove(session.handle.toLowerCase())
  return json(204, undefined)
}
