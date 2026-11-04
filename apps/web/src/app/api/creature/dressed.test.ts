/**
 * Dressed repositories on the public creature routes
 * (docs-plan/PLAN-dressed-repo-creature.md).
 *
 * `fetch` is mocked throughout, the stores are mocked, and every test imports
 * the routes fresh so the in-process caches never leak between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { opaqueReferenceId } from '@/lib/sync/product-snapshot'

const badgeGet = vi.fn()
const productGet = vi.fn()

vi.mock('@/lib/sync/repo-badge-store', () => ({
  getRepoBadgeStore: () => ({ get: badgeGet }),
}))
vi.mock('@/lib/sync/product-store', () => ({
  getProductStore: () => ({ get: productGet }),
}))

const NOW = '2026-11-04T00:00:00.000Z'
const REPO_ID = 555
const OWNER_ID = 42

const SNAPSHOT = {
  collection: [
    { referenceId: opaqueReferenceId('guest-1:starter'), companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
  ],
  companions: [{ companionId: 'pikachu-family', xp: 140 }],
  assignments: [
    { repositoryId: String(REPO_ID), referenceId: 'guest-1:starter', companionId: 'pikachu-family', assignedAt: NOW },
  ],
}

// A real PNG signature is not needed; the route only checks the content type and size.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function freshHandle(): string {
  return `testd${Math.random().toString(36).slice(2, 10)}`
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mockGithub({ isPrivate = false, ownerId = OWNER_ID } = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    if (/api\.github\.com\/users\/[^/]+$/.test(url)) return jsonRes(200, { login: 'x', id: ownerId })
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return jsonRes(200, { name: 'x', id: REPO_ID, private: isPrivate, owner: { id: ownerId }, language: 'TypeScript' })
    }
    if (/\/events\/public/.test(url)) return jsonRes(200, [])
    if (url.startsWith('https://raw.githubusercontent.com/PokeAPI/sprites/')) {
      return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } })
    }
    throw new Error(`unmocked fetch call in test: ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

async function importJsonRoute() {
  vi.resetModules()
  return import('./route')
}

async function importSvgRoute() {
  vi.resetModules()
  return import('../creature.svg/route')
}

function optIn() {
  badgeGet.mockResolvedValue({ handle: 'owner', updatedAt: NOW })
  productGet.mockResolvedValue(SNAPSHOT)
}

beforeEach(() => {
  process.env.GITHUB_LOGIN = 'definitely-not-a-test-handle-owner'
  delete process.env.GITHUB_TOKEN
  badgeGet.mockReset()
  productGet.mockReset()
  badgeGet.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/creature?repo= with a dressed repository', () => {
  it('adds `dressed` for an opted-in owner and shortens the CDN window', async () => {
    optIn()
    mockGithub()
    const { GET } = await importJsonRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${freshHandle()}&repo=site`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dressed).toMatchObject({ companionId: 'pikachu-family', step: { id: 'evolved', index: 2 } })
    // The automatic pick is still sent, so older extension builds keep working.
    expect(typeof body.speciesLineId).toBe('string')
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=300')
    expect(productGet).toHaveBeenCalledWith(OWNER_ID)
  })

  it('leaks no collection identity into the public body', async () => {
    optIn()
    mockGithub()
    const { GET } = await importJsonRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${freshHandle()}&repo=site`))
    const text = await res.text()
    expect(text).not.toContain('guest-1')
    expect(text).not.toContain(opaqueReferenceId('guest-1:starter'))
    expect(text).not.toContain('referenceId')
  })

  it('is unchanged when the owner has not opted in, and never reads the snapshot', async () => {
    mockGithub()
    const { GET } = await importJsonRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${freshHandle()}&repo=site`))
    const body = await res.json()
    expect('dressed' in body).toBe(false)
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600')
    expect(productGet).not.toHaveBeenCalled()
  })

  it('never shows a dressed companion on a private repository', async () => {
    optIn()
    mockGithub({ isPrivate: true })
    const { GET } = await importJsonRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${freshHandle()}&repo=site`))
    const body = await res.json()
    expect('dressed' in body).toBe(false)
    expect(badgeGet).not.toHaveBeenCalled()
  })

  it('keys the lookup on the repository owner id from GitHub, not the handle in the URL', async () => {
    optIn()
    mockGithub({ ownerId: 7 })
    const { GET } = await importJsonRoute()
    await GET(new NextRequest(`http://localhost/api/creature?user=${freshHandle()}&repo=site`))
    expect(badgeGet).toHaveBeenCalledWith(7)
  })

  it('keeps `dressed` on a cache hit without any new GitHub call', async () => {
    optIn()
    const fetchMock = mockGithub()
    const { GET } = await importJsonRoute()
    const url = `http://localhost/api/creature?user=${freshHandle()}&repo=site`
    await GET(new NextRequest(url))
    const callsAfterMiss = fetchMock.mock.calls.length
    const res = await GET(new NextRequest(url))
    expect(res.headers.get('X-Cache')).toBe('HIT')
    expect((await res.json()).dressed?.companionId).toBe('pikachu-family')
    expect(fetchMock.mock.calls.length).toBe(callsAfterMiss)
  })

  it('falls back to the automatic creature when the store fails', async () => {
    badgeGet.mockRejectedValue(new Error('db down'))
    mockGithub()
    const { GET } = await importJsonRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${freshHandle()}&repo=site`))
    expect(res.status).toBe(200)
    expect('dressed' in (await res.json())).toBe(false)
  })

  it('does not consult dressing for the handle-level creature', async () => {
    optIn()
    mockGithub()
    const { GET } = await importJsonRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${freshHandle()}`))
    expect('dressed' in (await res.json())).toBe(false)
    expect(badgeGet).not.toHaveBeenCalled()
  })
})

describe('GET /api/creature.svg?repo= with a dressed repository', () => {
  it('renders the dressed companion with its sprite embedded as a data URI', async () => {
    optIn()
    mockGithub()
    const { GET } = await importSvgRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${freshHandle()}&repo=site`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('image/svg+xml')
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=300')
    const svg = await res.text()
    expect(svg).toContain('data:image/png;base64,')
    expect(svg).not.toContain('raw.githubusercontent.com')
    expect(svg).toContain('Stage 2 of 2')
  })

  it('still renders the dressed badge, with an empty mount, when the sprite cannot be fetched', async () => {
    optIn()
    const fn = mockGithub()
    fn.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://raw.githubusercontent.com/')) return new Response('nope', { status: 500 })
      if (/\/users\/[^/]+$/.test(url)) return jsonRes(200, { login: 'x' })
      if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return jsonRes(200, { id: REPO_ID, private: false, owner: { id: OWNER_ID } })
      }
      return jsonRes(200, [])
    })
    const { GET } = await importSvgRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${freshHandle()}&repo=site`))
    const svg = await res.text()
    expect(res.status).toBe(200)
    expect(svg).toContain('Stage 2 of 2')
    expect(svg).not.toContain('<image')
  })

  it('is the automatic badge with the long window when the owner has not opted in', async () => {
    mockGithub()
    const { GET } = await importSvgRoute()
    const res = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${freshHandle()}&repo=site`))
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600')
    expect(await res.text()).not.toContain('<image')
    expect(productGet).not.toHaveBeenCalled()
  })
})
