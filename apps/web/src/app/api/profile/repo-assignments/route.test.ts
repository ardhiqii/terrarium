import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createEncounterState } from '@/lib/game/encounters'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { cacheClearAll, cacheGetFresh, cacheSet } from '@/lib/game/api-cache'
import { buildProductSnapshot, type ProductSnapshot } from '@/lib/sync/product-snapshot'
import { resetProductStoreForTests, type ProductSqliteStore } from '@/lib/sync/product-store'
import { MAX_ASSIGNMENTS, parseAssignmentsBody } from '@/lib/sync/repo-assignments-payload'

/**
 * Pushing the dressing without a full sync (docs-plan/PLAN-dressed-repo-qa-fixes.md, fix 1).
 * Real in-memory SQLite product store; the session is mocked; no network.
 */

const GITHUB_ID = 9001
let session: { handle: string; githubId: number; avatarUrl: null } | null = null

vi.mock('@/lib/sync/session', () => ({
  getSessionProvider: () => ({ current: async () => session }),
}))

const NOW = '2026-11-04T00:00:00.000Z'

function snapshot(guestId = 'guest-1'): ProductSnapshot {
  const profile = createGuestProfile({ guestId, starterCompanionId: 'pikachu-family', now: NOW })
  return buildProductSnapshot(
    createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
    NOW,
  )
}

function assignment(repositoryId = '555', referenceId = 'guest-1:starter') {
  return { repositoryId, referenceId, companionId: 'pikachu-family', assignedAt: NOW }
}

function put(body: unknown) {
  return new NextRequest('http://localhost/api/profile/repo-assignments', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let store: ProductSqliteStore

beforeEach(() => {
  cacheClearAll()
  store = resetProductStoreForTests(':memory:')
  session = { handle: 'Octo', githubId: GITHUB_ID, avatarUrl: null }
})

async function seed(value: ProductSnapshot = snapshot()) {
  expect(await store.put(GITHUB_ID, 'octo', value, '2026-11-04T00:00:01.000Z', null)).toBe(true)
}

describe('PUT /api/profile/repo-assignments', () => {
  it('requires a session', async () => {
    session = null
    const { GET, PUT } = await import('./route')
    expect((await PUT(put({ guestId: 'guest-1', assignments: [] }))).status).toBe(401)
    expect((await GET()).status).toBe(401)
  })

  it('answers never-synced when the account has no stored snapshot', async () => {
    const { PUT } = await import('./route')
    const res = await PUT(put({ guestId: 'guest-1', assignments: [assignment()] }))
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('never-synced')
  })

  it('refuses a different local profile', async () => {
    await seed()
    const { PUT } = await import('./route')
    const res = await PUT(put({ guestId: 'guest-2', assignments: [assignment()] }))
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('other-profile')
    expect((await store.get(GITHUB_ID))?.assignments ?? []).toEqual([])
  })

  it('replaces assignments only, leaving everything else byte-equal', async () => {
    const before = snapshot()
    await seed(before)
    const { PUT } = await import('./route')
    const res = await PUT(put({ guestId: 'guest-1', assignments: [assignment()] }))
    expect(res.status).toBe(200)

    const after = await store.get(GITHUB_ID)
    expect(after?.assignments).toEqual([assignment()])
    const { assignments: _a, ...restAfter } = after!
    const { assignments: _b, ...restBefore } = before
    expect(JSON.stringify(restAfter)).toBe(JSON.stringify(restBefore))
  })

  it('treats the list as the whole truth: an empty list takes everything back', async () => {
    await seed({ ...snapshot(), assignments: [assignment()] })
    const { PUT } = await import('./route')
    expect((await PUT(put({ guestId: 'guest-1', assignments: [] }))).status).toBe(200)
    expect((await store.get(GITHUB_ID))?.assignments).toEqual([])
  })

  it('writes the session account only, whatever the body says', async () => {
    await seed()
    const { PUT } = await import('./route')
    const res = await PUT(put({ guestId: 'guest-1', assignments: [assignment()], githubId: 1 }))
    expect(res.status).toBe(400)
    expect(await store.get(1)).toBeNull()
  })

  it('drops the lookup cache for the repositories it touched', async () => {
    await seed({ ...snapshot(), assignments: [assignment('777')] })
    cacheSet(`dressed:${GITHUB_ID}:777`, { optedIn: true, dressed: null }, 60_000)
    cacheSet(`dressed:${GITHUB_ID}:555`, { optedIn: true, dressed: null }, 60_000)
    const { PUT } = await import('./route')
    await PUT(put({ guestId: 'guest-1', assignments: [assignment('555')] }))
    expect(cacheGetFresh(`dressed:${GITHUB_ID}:777`)).toBeUndefined()
    expect(cacheGetFresh(`dressed:${GITHUB_ID}:555`)).toBeUndefined()
  })

  it('rejects malformed bodies without writing', async () => {
    await seed()
    const { PUT } = await import('./route')
    for (const body of ['not json', [], null, { assignments: [] }, { guestId: 'guest-1' }]) {
      expect((await PUT(put(body))).status).toBe(400)
    }
    expect((await store.get(GITHUB_ID))?.assignments ?? []).toEqual([])
  })

  it('rejects an oversized body with 413', async () => {
    const { PUT } = await import('./route')
    const res = await PUT(put({ guestId: 'guest-1', assignments: [], pad: 'x'.repeat(200 * 1024) }))
    expect(res.status).toBe(413)
  })
})

describe('GET /api/profile/repo-assignments', () => {
  it('says not synced without a snapshot', async () => {
    const { GET } = await import('./route')
    expect(await (await GET()).json()).toEqual({ synced: false, guestId: null, assignments: [] })
  })

  it('returns only the repository and reference of each assignment', async () => {
    await seed({ ...snapshot(), assignments: [assignment()] })
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      synced: true,
      guestId: 'guest-1',
      assignments: [{ repositoryId: '555', referenceId: 'guest-1:starter' }],
    })
  })
})

describe('parseAssignmentsBody', () => {
  const ok = { guestId: 'guest-1', assignments: [assignment()] }

  it('accepts a well-formed body', () => {
    expect(parseAssignmentsBody(ok)).toEqual({ ok: true, guestId: 'guest-1', assignments: [assignment()] })
  })

  it.each([
    ['an unknown top-level field', { ...ok, extra: 1 }],
    ['a missing guestId', { assignments: [] }],
    ['assignments not an array', { guestId: 'g', assignments: {} }],
    ['an extra assignment field', { guestId: 'g', assignments: [{ ...assignment(), xp: 9 }] }],
    ['a missing assignment field', { guestId: 'g', assignments: [{ repositoryId: '1', referenceId: 'r', companionId: 'c' }] }],
    ['a non-numeric repositoryId', { guestId: 'g', assignments: [assignment('../555')] }],
    ['a zero-led repositoryId', { guestId: 'g', assignments: [assignment('0555')] }],
    ['a bad timestamp', { guestId: 'g', assignments: [{ ...assignment(), assignedAt: 'yesterday' }] }],
    ['an overlong referenceId', { guestId: 'g', assignments: [assignment('1', 'r'.repeat(201))] }],
    ['the same repository twice', { guestId: 'g', assignments: [assignment('1', 'a'), assignment('1', 'b')] }],
    ['the same companion twice', { guestId: 'g', assignments: [assignment('1', 'a'), assignment('2', 'a')] }],
    [
      'too many assignments',
      { guestId: 'g', assignments: Array.from({ length: MAX_ASSIGNMENTS + 1 }, (_, i) => assignment(String(i + 1), `r${i}`)) },
    ],
  ])('rejects %s', (_label, body) => {
    expect(parseAssignmentsBody(body).ok).toBe(false)
  })
})
