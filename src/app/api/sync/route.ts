/**
 * `POST /api/sync`   — upload the signed-in user's derived snapshot.
 * `GET /api/sync`    — fetch the signed-in user's stored snapshot.
 * `DELETE /api/sync` — forget the signed-in user's data entirely (opt-out).
 *
 * Read `tasks/T28.md`, `tasks/PHASE3.md`, and `src/lib/sync/types.ts`
 * (frozen) before touching this file.
 *
 * THE PRIVACY BOUNDARY. Only `SyncedSnapshot` (numbers and enums, see
 * `types.ts`) is ever accepted or returned. The body is validated against
 * the exact closed shape by `validateSnapshot`: an unknown field is a 400,
 * not a silently dropped field, so a client mistakenly (or maliciously)
 * sending note content fails loudly instead of almost working.
 *
 * THE HANDLE COMES FROM THE SESSION, NEVER THE REQUEST BODY. `SyncedSnapshot`
 * does not even have a `handle` field, so there is nothing to trust from the
 * client on that point, but this is called out explicitly because it is the
 * one mistake that would let any signed-in user overwrite anyone else's row.
 *
 * THE VERIFICATION ASYMMETRY. Commit XP folded into `totalXp` is verifiable
 * server-side against public GitHub data (see `src/lib/game/github.ts`).
 * Garden XP is not: notes are local and private, so this endpoint has no way
 * to check that `totalXp` genuinely reflects the client's own garden. It
 * trusts the signed-in user's own upload. Friend-scoped leaderboards (see
 * `tasks/PHASE3.md`) make that tolerable for now. Nothing in this file may
 * imply garden XP is verified; if a global leaderboard is ever built, this
 * becomes a real problem that needs solving first.
 */

import { NextRequest } from 'next/server'
import { getSessionProvider } from '@/lib/sync/session'
import { getSyncStore } from '@/lib/sync/sqlite-store'
import { validateSnapshot } from '@/lib/sync/validate-snapshot'
import { SNAPSHOT_SCHEMA_VERSION, type SyncedUser } from '@/lib/sync/types'
import { checkRateLimit } from '@/lib/game/api-cache'

// Uses node:sqlite (via sqlite-store.ts), which needs the Node runtime, not
// the edge runtime.
export const runtime = 'nodejs'
// Every response depends on the caller's session; never cache this route.
export const dynamic = 'force-dynamic'

const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60 * 1000

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) {
    return json(401, { error: 'Sign in required.' })
  }

  const rl = checkRateLimit(`sync-write:${session.handle}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (!rl.allowed) {
    return json(429, { error: 'Rate limit exceeded. Try again shortly.' })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' })
  }

  const validated = validateSnapshot(body)
  if (!validated.ok) {
    return json(400, { error: validated.error })
  }

  if (validated.value.schemaVersion > SNAPSHOT_SCHEMA_VERSION) {
    return json(400, {
      error: `schemaVersion ${validated.value.schemaVersion} is newer than this server supports (${SNAPSHOT_SCHEMA_VERSION}).`,
    })
  }

  // The handle, githubId, and avatarUrl all come from the SESSION, never
  // from `body`: `SyncedSnapshot` has no handle field to begin with, so
  // there is nothing in the validated payload that could overwrite another
  // user even if a caller tried.
  const user: SyncedUser = {
    handle: session.handle.toLowerCase(),
    githubId: session.githubId,
    avatarUrl: session.avatarUrl,
    snapshot: validated.value,
    updatedAt: new Date().toISOString(),
  }

  await getSyncStore().put(user)
  return json(200, user)
}

export async function GET(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) {
    return json(401, { error: 'Sign in required.' })
  }

  const user = await getSyncStore().get(session.handle.toLowerCase())
  if (!user) {
    return json(404, { error: 'This account has never synced.' })
  }

  return json(200, user)
}

export async function DELETE(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) {
    return json(401, { error: 'Sign in required.' })
  }

  await getSyncStore().remove(session.handle.toLowerCase())
  return json(204, undefined)
}
