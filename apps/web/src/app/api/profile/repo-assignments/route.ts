/**
 * `GET /api/profile/repo-assignments` — the caller's stored (repository, companion) pairs.
 * `PUT /api/profile/repo-assignments` — push which companion dresses which
 * repository, without a full sync.
 *
 * Body: `{ "guestId": string, "assignments": [{ repositoryId, referenceId, companionId, assignedAt }] }`.
 *
 * WHY THIS EXISTS (docs-plan/PLAN-dressed-repo-qa-fixes.md, fix 1): dressing is
 * written to the browser, and the public badge reads the stored product
 * snapshot. Before this route the only writer was the full GitHub sync on
 * `/github`. So a user who dressed a repo on `/repos` and copied the badge saw the
 * automatic creature, with no hint why.
 *
 * WHY NOT THE FULL SYNC: that path carries checkpoints, receipt repair and
 * blocked-event handling. Replaying it from a second page could race a running
 * sync. This route touches ONE field of the stored snapshot, `assignments`, and
 * leaves the collection, XP, events and everything else byte-equal.
 *
 * Rules:
 *   - Session-only. The row written is always the caller's own (`session.githubId`).
 *     Nothing in the body can name another account.
 *   - The first full sync still creates the snapshot. With none stored this
 *     answers 409 `never-synced`, and the page points at `/github`.
 *   - `guestId` must match the stored snapshot, the same guard as the full sync:
 *     a different local profile must not overwrite this account's dressing.
 *   - Ownership is NOT trusted from the body. `resolveDressedCompanion`
 *     re-checks every assignment against the stored collection on read.
 *   - It REPLACES the list. Last write wins; the client always sends the full
 *     current list, so a take-back is a removal here too.
 */

import { NextRequest } from 'next/server'
import { getSessionProvider } from '@/lib/sync/session'
import { getProductStore } from '@/lib/sync/product-store'
import { MAX_ASSIGNMENTS_BODY_BYTES, parseAssignmentsBody } from '@/lib/sync/repo-assignments-payload'
import { cacheDelete, checkRateLimit } from '@/lib/game/api-cache'

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

/**
 * `GET` — the caller's own stored dressing, so `/repos` can say per row whether
 * it is on GitHub yet. Only the (repository, companion) pairs; nothing else.
 */
export async function GET(): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  try {
    const record = await getProductStore().getRecord(session.githubId, session.handle)
    if (!record) return json(200, { synced: false, guestId: null, assignments: [] })
    return json(200, {
      synced: true,
      guestId: record.snapshot.guestId,
      assignments: (record.snapshot.assignments ?? []).map(({ repositoryId, referenceId }) => ({
        repositoryId,
        referenceId,
      })),
    })
  } catch {
    return json(503, { error: 'Could not read your dressing. Try again shortly.' })
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })

  const rl = checkRateLimit(`repo-assignments:${session.githubId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (!rl.allowed) return json(429, { error: 'Rate limit exceeded. Try again shortly.' })

  // Refuse before buffering. `request.text()` reads the whole body, so a cap
  // applied afterwards still lets a caller make this process hold it; the header
  // is a hint, and the byte count after the read is the real check (a body in
  // UTF-16 units can be shorter than its UTF-8 byte length).
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_ASSIGNMENTS_BODY_BYTES) {
    return json(413, { error: 'Request body is too large.' })
  }

  let text: string
  try {
    text = await request.text()
  } catch {
    return json(400, { error: 'Request body could not be read.' })
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_ASSIGNMENTS_BODY_BYTES) {
    return json(413, { error: 'Request body is too large.' })
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' })
  }
  const parsed = parseAssignmentsBody(body)
  if (!parsed.ok) return json(400, { error: parsed.error })

  const store = getProductStore()
  try {
    // The same short optimistic window as the full sync, so a sync landing in
    // between is never silently overwritten.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await store.getRecord(session.githubId, session.handle)
      if (!record) {
        return json(409, { reason: 'never-synced', error: 'Sync once from GitHub first.' })
      }
      if (record.snapshot.guestId !== parsed.guestId) {
        return json(409, { reason: 'other-profile', error: 'This account is synced from a different profile.' })
      }
      const previous = record.snapshot.assignments ?? []
      const now = new Date().toISOString()
      const next = { ...record.snapshot, assignments: parsed.assignments, assignmentsUpdatedAt: now }
      const saved = await store.put(
        session.githubId,
        session.handle,
        next,
        now,
        record.updatedAt,
      )
      if (saved) {
        // Drop this process's 60s lookup entries so the next badge view reads the
        // new dressing. The CDN window (five minutes) still applies.
        for (const { repositoryId } of [...previous, ...parsed.assignments]) {
          cacheDelete(`dressed:${session.githubId}:${repositoryId}`)
        }
        return json(200, { assignments: parsed.assignments.length })
      }
    }
  } catch {
    return json(503, { error: 'Could not save. Try again shortly.' })
  }
  return json(409, { reason: 'conflict', error: 'Your profile changed meanwhile. Try again.' })
}
