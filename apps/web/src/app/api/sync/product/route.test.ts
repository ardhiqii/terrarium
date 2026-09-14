import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { asCompanionId, asEventId, type NormalizedEvent } from '@/lib/game/events'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createEncounterState } from '@/lib/game/encounters'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import {
  buildProductSnapshot,
  type ProductSnapshot,
} from '@/lib/sync/product-snapshot'

function request(method: string, body?: string, headers?: HeadersInit): NextRequest {
  return new NextRequest('http://localhost/api/sync/product', {
    method,
    ...(body !== undefined ? { body, headers } : {}),
  })
}

function fakeGithubId(handle: string): number {
  let hash = 0
  for (const character of handle) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return Math.abs(hash) || 1
}

function snapshot(eventIds: readonly string[] = [], guestId = 'guest-1'): ProductSnapshot {
  const now = '2026-08-28T10:00:00.000Z'
  const profile = createGuestProfile({ guestId, starterCompanionId: 'pikachu-family', now })
  const events: NormalizedEvent[] = eventIds.map((eventId) => ({
    eventId: asEventId(eventId),
    companionId: asCompanionId('pikachu-family'),
    source: 'mounted-markdown',
    sourceId: 'vault:42',
    provenance: 'local',
    category: 'work-session',
    occurredAt: now,
  }))
  return buildProductSnapshot(
    createProductState(
      profile,
      { events },
      createEncounterState(),
      PROTOTYPE_COMPANION_CATALOG,
    ),
    now,
  )
}

describe('POST/GET/DELETE /api/sync/product', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SYNC_STORE', 'sqlite')
    vi.stubEnv('SYNC_DB_PATH', '')
    vi.stubEnv('STUB_SESSION_HANDLE', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('requires a signed-in session for every method', async () => {
    const { POST, GET, DELETE } = await import('./route')
    const serialized = JSON.stringify(snapshot())

    await expect(POST(request('POST', serialized))).resolves.toHaveProperty('status', 401)
    await expect(GET()).resolves.toHaveProperty('status', 401)
    await expect(DELETE()).resolves.toHaveProperty('status', 401)
  })

  it('persists a valid snapshot, restores it with GET, and deletes it', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'Octocat')
    const { POST, GET, DELETE } = await import('./route')
    const serialized = JSON.stringify(snapshot())

    const post = await POST(request('POST', serialized, { 'content-type': 'application/json' }))
    expect(post.status).toBe(200)
    expect((await post.json()).guestId).toBe('guest-1')

    const get = await GET()
    expect(get.status).toBe(200)
    expect((await get.json()).guestId).toBe('guest-1')

    expect((await DELETE()).status).toBe(204)
    expect((await GET()).status).toBe(404)
  })

  it('merges new events without double-counting replayed events', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, GET } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1']))))
    const merged = await POST(request('POST', JSON.stringify(snapshot(['event-1', 'event-2']))))
    expect(merged.status).toBe(200)
    expect((await merged.json()).events).toHaveLength(2)

    const restored = await GET()
    expect((await restored.json()).events).toHaveLength(2)
  })

  it('rejects a different guest profile instead of dropping server history', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1'], 'guest-1'))))
    const conflict = await POST(request('POST', JSON.stringify(snapshot(['event-2'], 'guest-2'))))
    expect(conflict.status).toBe(409)
  })

  it('rejects malformed, widened, newer, and oversized payloads before storage', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, GET } = await import('./route')
    const valid = snapshot()

    expect((await POST(request('POST', '{bad json'))).status).toBe(400)
    expect((await POST(request('POST', JSON.stringify({ ...valid, privateNote: 'secret' })))).status).toBe(400)
    expect((await POST(request('POST', JSON.stringify({ ...valid, schemaVersion: 99 })))).status).toBe(400)
    expect((await POST(request('POST', 'x'.repeat(512 * 1024 + 1), {
      'content-length': String(512 * 1024 + 1),
    }))).status).toBe(413)
    expect((await GET()).status).toBe(404)
  })

  it('rejects a client-forged verified GitHub event without a server receipt', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      events: [{ ...value.events[0], provenance: 'verified' }],
    }

    const response = await POST(request('POST', JSON.stringify(forged)))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/server-issued receipt/i) })
  })

  it('rejects a forged GitHub event downgraded to local provenance', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      events: [{ ...value.events[0], source: 'github', provenance: 'local' }],
    }

    const response = await POST(request('POST', JSON.stringify(forged)))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/server-issued receipt/i) })
  })

  it('downgrades legacy stored verified events without a valid receipt before returning them', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const dbPath = path.join(tmpdir(), `terrarium-product-route-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    vi.stubEnv('SYNC_DB_PATH', dbPath)
    const { POST, GET } = await import('./route')
    const { getProductStore } = await import('@/lib/sync/product-store')

    await POST(request('POST', JSON.stringify(snapshot(['legacy-event']))))
    const store = getProductStore()
    const record = await store.getRecord(fakeGithubId('octocat'), 'octocat')
    expect(record).not.toBeNull()
    if (!record) return

    const legacyVerified: ProductSnapshot = {
      ...record.snapshot,
      events: [{ ...record.snapshot.events[0], provenance: 'verified' }],
    }
    expect(await store.put(record.githubId, record.handle, legacyVerified, '2026-08-28T10:01:00.000Z', record.updatedAt)).toBe(true)

    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.events[0]).toMatchObject({ provenance: 'local' })
    expect((await store.getRecord(record.githubId, record.handle))?.snapshot.events[0].provenance).toBe('verified')
  })

  it('drops legacy local GitHub events instead of preserving unverified XP', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const dbPath = path.join(tmpdir(), `terrarium-product-route-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    vi.stubEnv('SYNC_DB_PATH', dbPath)
    const { POST, GET } = await import('./route')
    const { getProductStore } = await import('@/lib/sync/product-store')

    await POST(request('POST', JSON.stringify(snapshot(['legacy-event']))))
    const store = getProductStore()
    const record = await store.getRecord(fakeGithubId('octocat'), 'octocat')
    expect(record).not.toBeNull()
    if (!record) return

    const legacyForged: ProductSnapshot = {
      ...record.snapshot,
      events: [{ ...record.snapshot.events[0], source: 'github', provenance: 'local' }],
    }
    expect(await store.put(record.githubId, record.handle, legacyForged, '2026-08-28T10:02:00.000Z', record.updatedAt)).toBe(true)

    const response = await GET()
    expect(response.status).toBe(200)
    expect((await response.json()).events).toEqual([])
  })
})
