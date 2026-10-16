import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createEncounterState } from '@/lib/game/encounters'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createProductState } from '@/lib/game/product-state'
import { buildProductSnapshot } from '@/lib/sync/product-snapshot'

const now = '2026-08-28T10:00:00.000Z'

function fakeGithubId(handle: string): number {
  let hash = 0
  for (const character of handle) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return Math.abs(hash) || 1
}

function request(companionId: unknown, headers: HeadersInit = {}): NextRequest {
  return new NextRequest('http://localhost/api/sync/product/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ companionId }),
  })
}

function ownedSnapshot() {
  const profile = createGuestProfile({
    guestId: 'guest-activation',
    starterCompanionId: 'pikachu-family',
    catalog: PROTOTYPE_COMPANION_CATALOG,
    now,
  })
  const withGrass = {
    ...profile,
    collection: [
      ...profile.collection,
      {
        referenceId: 'history:grass-family',
        companionId: 'grass-family',
        acquiredAt: now,
        acquisition: 'starter' as const,
      },
    ],
  }
  return buildProductSnapshot(
    createProductState(withGrass, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
    now,
  )
}

describe('POST /api/sync/product/activate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SYNC_STORE', 'sqlite')
    vi.stubEnv('SYNC_DB_PATH', '')
    vi.stubEnv('STUB_SESSION_HANDLE', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('requires a signed-in session', async () => {
    const { POST } = await import('./route')
    const response = await POST(request('grass-family'))
    expect(response.status).toBe(401)
  })

  it('rejects an unowned companion without changing the snapshot', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'Octocat')
    const { getProductStore } = await import('@/lib/sync/product-store')
    const accountHeader = { 'x-terrarium-github-id': String(fakeGithubId('octocat')) }
    await getProductStore().put(fakeGithubId('octocat'), 'octocat', ownedSnapshot(), now, null)

    const { POST } = await import('./route')
    const response = await POST(request('ditto-like', accountHeader))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Companion is not owned by this account.' })
  })

  it('persists an owned activation with user provenance', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'Octocat')
    const { GET } = await import('../route')
    const { getProductStore } = await import('@/lib/sync/product-store')
    const accountHeader = { 'x-terrarium-github-id': String(fakeGithubId('octocat')) }
    await getProductStore().put(fakeGithubId('octocat'), 'octocat', ownedSnapshot(), now, null)

    const { POST } = await import('./route')
    const response = await POST(request('grass-family', accountHeader))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(await response.json()).toEqual({ ok: true, activeCompanionId: 'grass-family' })

    const restored = await GET(new NextRequest('http://localhost/api/sync/product', { headers: accountHeader }))
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({
      activeCompanionId: 'grass-family',
      activeSelection: { companionId: 'grass-family', provenance: 'user' },
    })
  })

  it('returns a storage error when activation persistence fails', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'Octocat')
    const { getProductStore } = await import('@/lib/sync/product-store')
    const store = getProductStore()
    const snapshot = ownedSnapshot()
    await store.put(fakeGithubId('octocat'), 'octocat', snapshot, now, null)
    vi.spyOn(store, 'put').mockRejectedValue(new Error('SQLITE_BUSY token=secret'))

    const { POST } = await import('./route')
    const response = await POST(request('grass-family', {
      'x-terrarium-github-id': String(fakeGithubId('octocat')),
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'storage_unavailable' })
  })
})
