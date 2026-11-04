/**
 * `GET /api/profile/repo-badges` — is the signed-in user showing dressed companions on GitHub?
 * `PUT /api/profile/repo-badges` — `{ "enabled": true | false }`.
 *
 * The opt-in for the dressed-repo badge (see `repo-badge-store.ts` and
 * `docs-plan/PLAN-dressed-repo-creature.md`). Default off.
 *
 * Same rules as `/api/profile/visibility`: the row written is always the caller's
 * own, keyed by the immutable GitHub id from the session. Nothing in the request
 * body can name another account.
 *
 * Changes reach the public creature routes within a minute on this server (the
 * lookup cache). At the CDN, every response for an opted-in owner is cached for
 * at most five minutes plus five of stale-while-revalidate, so after opting out a
 * dressed badge can linger for up to ten minutes. Opting IN can take up to the
 * normal hour, because the undressed badge was cached under the long window.
 */

import { NextRequest } from 'next/server'
import { getSessionProvider } from '@/lib/sync/session'
import { getRepoBadgeStore } from '@/lib/sync/repo-badge-store'
import { checkRateLimit } from '@/lib/game/api-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 60 * 1000

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export async function GET(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })

  try {
    const record = await getRepoBadgeStore().get(session.githubId)
    return json(200, { enabled: record !== null, updatedAt: record?.updatedAt ?? null })
  } catch {
    return json(503, { error: 'Could not read the setting. Try again shortly.' })
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })

  const rl = checkRateLimit(`repo-badges:${session.githubId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (!rl.allowed) return json(429, { error: 'Rate limit exceeded. Try again shortly.' })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(400, { error: 'Body must be an object with an enabled field.' })
  }
  const enabled = (body as Record<string, unknown>).enabled
  if (enabled !== true && enabled !== false) {
    return json(400, { error: 'enabled must be true or false.' })
  }

  const store = getRepoBadgeStore()
  const now = new Date().toISOString()
  try {
    if (enabled) await store.put(session.githubId, session.handle, now)
    else await store.remove(session.githubId)
  } catch {
    return json(503, { error: 'Could not save the setting. Try again shortly.' })
  }
  return json(200, { enabled, updatedAt: now })
}
