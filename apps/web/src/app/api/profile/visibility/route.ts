/**
 * `GET /api/profile/visibility` — read the signed-in user's own visibility.
 * `PUT /api/profile/visibility` — set it to 'public' or 'private'.
 *
 * The privacy rule (see `profile-visibility.ts`) is that a public profile is
 * opt-in and the default is private. This route is how the owner makes that
 * choice; it is the ONLY writer of the policy store, and it always writes the
 * caller's own row (keyed by the immutable GitHub id from the session, never a
 * value from the request body).
 *
 * A caller can never set another account's visibility: `githubId` is not read
 * from the request at all.
 */

import { NextRequest } from 'next/server'
import { getSessionProvider } from '@/lib/sync/session'
import { getProfileVisibilityStore } from '@/lib/sync/profile-visibility-store'
import { parseVisibility } from '@/lib/sync/profile-visibility'
import { checkRateLimit } from '@/lib/game/api-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 60 * 1000

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export async function GET(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })

  const record = await getProfileVisibilityStore().get(session.githubId)
  // A missing record is the private default, not an error.
  return json(200, {
    visibility: record?.visibility ?? 'private',
    updatedAt: record?.updatedAt ?? null,
  })
}

export async function PUT(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })

  const rl = checkRateLimit(
    `profile-visibility:${session.githubId}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  )
  if (!rl.allowed) return json(429, { error: 'Rate limit exceeded. Try again shortly.' })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' })
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(400, { error: 'Body must be an object with a visibility field.' })
  }
  const raw = (body as Record<string, unknown>).visibility
  if (raw !== 'public' && raw !== 'private') {
    return json(400, { error: "visibility must be 'public' or 'private'." })
  }

  const store = getProfileVisibilityStore()
  const now = new Date().toISOString()

  if (raw === 'private') {
    // Opting out removes the row entirely; the account reverts to the default.
    // This is stronger than storing 'private' because no stale 'public' value
    // can survive a later mistake in the reader.
    await store.remove(session.githubId)
    return json(200, { visibility: 'private', updatedAt: now })
  }

  // Anything reaching here is a literal 'public'; parseVisibility normalizes
  // defensively so a future refactor cannot opt an account in by accident.
  const visibility = parseVisibility(raw)
  if (visibility !== 'public') {
    return json(400, { error: "visibility must be 'public' or 'private'." })
  }
  await store.put(session.githubId, session.handle, visibility, now)
  return json(200, { visibility, updatedAt: now })
}
