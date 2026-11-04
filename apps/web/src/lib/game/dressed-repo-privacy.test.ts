/**
 * REGRESSIONS FOR THE DRESSED-REPO PRIVACY HOLES.
 *
 * Both of these were reproduced against the first implementation: the badge is
 * world-readable, so anything it decides from a remembered fact can publish a
 * companion the owner never agreed to publish on that repo.
 *
 * 1. `repometa` is keyed on `login/repo` — both mutable. Alice renames, someone
 *    else claims the login and creates a repo with the same name, and the
 *    remembered entry still says the repo belongs to Alice's numeric id. The
 *    overlay then reads Alice's opt-in and Alice's snapshot and publishes her
 *    companion on the new owner's repo.
 *
 * 2. `cachedRepoMeta` serves stale entries forever, and a repo that turns private
 *    answers 404 — which used to leave the old `isPrivate: false` in place. The
 *    badge kept rendering the companion and the repo's name for as long as the
 *    existence cache held.
 *
 * The fix has two halves, and there is a test for each: the overlay may only use
 * metadata from `freshRepoMeta` (five minutes, refetched otherwise), and that
 * metadata's owner must be the login in the URL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const badgeGet = vi.fn()
const productGet = vi.fn()

vi.mock('@/lib/sync/repo-badge-store', () => ({
  getRepoBadgeStore: () => ({ get: badgeGet }),
}))
vi.mock('@/lib/sync/product-store', () => ({
  getProductStore: () => ({ get: productGet }),
}))

const NOW = '2026-11-04T00:00:00.000Z'
const ALICE = 100
const MALLORY = 300
const REPO_ID = '555'

const SNAPSHOT = {
  collection: [
    { referenceId: 'ref-aaaaaaaa-bbbbbbbb', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
  ],
  companions: [{ companionId: 'pikachu-family', xp: 140 }],
  assignments: [
    { repositoryId: REPO_ID, referenceId: 'ref-aaaaaaaa-bbbbbbbb', companionId: 'pikachu-family', assignedAt: NOW },
  ],
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    language: 'TypeScript',
    createdAt: NOW,
    pushedAt: NOW,
    sizeKb: 1,
    id: REPO_ID,
    ownerId: ALICE,
    ownerLogin: 'alice',
    isPrivate: false,
    fetchedAt: Date.now(),
    ...overrides,
  }
}

beforeEach(async () => {
  const { cacheClearAll } = await import('@/lib/game/api-cache')
  cacheClearAll()
  badgeGet.mockReset()
  productGet.mockReset()
  badgeGet.mockResolvedValue({ handle: 'alice', updatedAt: NOW })
  productGet.mockResolvedValue(SNAPSHOT)
  vi.unstubAllGlobals()
})

describe('lookupDressedCompanion refuses metadata that names another owner', () => {
  it('does not dress when GitHub says the repo belongs to a different login', async () => {
    const { lookupDressedCompanion } = await import('@/lib/game/dressed-repo-lookup')
    // The cached entry was written while `alice` owned it; the login has since
    // been reclaimed and the new owner never opted in.
    const result = await lookupDressedCompanion(meta({ ownerLogin: 'mallory' }), 'alice')
    expect(result.dressed).toBeNull()
    // It must not even read Alice's opt-in, let alone her collection.
    expect(badgeGet).not.toHaveBeenCalled()
    expect(productGet).not.toHaveBeenCalled()
  })

  it('dresses when the logins match, ignoring case', async () => {
    const { lookupDressedCompanion } = await import('@/lib/game/dressed-repo-lookup')
    const result = await lookupDressedCompanion(meta({ ownerLogin: 'Alice' }), 'alice')
    expect(result.optedIn).toBe(true)
    expect(result.dressed?.companionId).toBe('pikachu-family')
  })

  it('still refuses a private repo before anything else', async () => {
    const { lookupDressedCompanion } = await import('@/lib/game/dressed-repo-lookup')
    const result = await lookupDressedCompanion(meta({ isPrivate: true }), 'alice')
    expect(result.dressed).toBeNull()
    expect(badgeGet).not.toHaveBeenCalled()
  })
})

describe('freshRepoMeta never decides privacy from an old fact', () => {
  it('refetches once the entry is older than the badge window', async () => {
    const { cacheGetStale, cacheSet } = await import('@/lib/game/api-cache')
    const { freshRepoMeta } = await import('@/lib/game/creature-route-shared')
    cacheSet('repometa:alice/site', meta({ fetchedAt: Date.now() - 6 * 60 * 1000 }), 24 * 60 * 60 * 1000)

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 555, private: false, owner: { id: MALLORY, login: 'mallory' }, language: 'Go' }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await freshRepoMeta('alice', 'site', undefined, 'test')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The answer comes from GitHub now, so the owner is the current one.
    expect(result?.ownerId).toBe(MALLORY)
    expect(result?.ownerLogin).toBe('mallory')
    expect(cacheGetStale<{ ownerId: number }>('repometa:alice/site')?.ownerId).toBe(MALLORY)
  })

  it('erases the entry when GitHub starts answering 404, so nothing stale survives', async () => {
    const { cacheGetStale, cacheSet } = await import('@/lib/game/api-cache')
    const { freshRepoMeta } = await import('@/lib/game/creature-route-shared')
    cacheSet('repometa:alice/private-app', meta({ fetchedAt: Date.now() - 60 * 60 * 1000 }), 24 * 60 * 60 * 1000)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })),
    )

    const result = await freshRepoMeta('alice', 'private-app', undefined, 'test')
    expect(result).toBeNull()
    // The old entry is gone, not merely expired: a stale read would still say
    // public, and `cachedRepoMeta` reads stale on purpose.
    expect(cacheGetStale('repometa:alice/private-app')).toBeUndefined()
  })

  it('makes no request while the entry is still inside the window', async () => {
    const { cacheSet } = await import('@/lib/game/api-cache')
    const { freshRepoMeta } = await import('@/lib/game/creature-route-shared')
    cacheSet('repometa:alice/site', meta(), 24 * 60 * 60 * 1000)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await freshRepoMeta('alice', 'site', undefined, 'test')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result?.ownerId).toBe(ALICE)
  })
})

describe('the badge itself', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

  function request(): unknown {
    return {
      headers: new Headers(),
      nextUrl: new URL('http://localhost/api/creature.svg?user=alice&repo=private-app'),
    }
  }

  it('stops showing a repo that has turned private', async () => {
    vi.resetModules()
    const cache = await import('@/lib/game/api-cache')
    const { GET } = await import('@/app/api/creature.svg/route')

    // State left from when it was public: existence cached, metadata known
    // public. GitHub now hides the repo from us.
    cache.cacheSet('exists:repo:alice/private-app', 'exists', 24 * 60 * 60 * 1000)
    cache.cacheSet(
      'repometa:alice/private-app',
      meta({ fetchedAt: Date.now() - 24 * 60 * 60 * 1000 }),
      24 * 60 * 60 * 1000,
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (/\/users\/[^/]+$/.test(url)) {
          return new Response(JSON.stringify({ login: 'alice', id: ALICE }), { status: 200 })
        }
        if (/\/repos\/[^/]+/.test(url)) return new Response('{"message":"Not Found"}', { status: 404 })
        if (url.startsWith('https://raw.githubusercontent.com/PokeAPI/sprites/')) {
          return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
        }
        return new Response('[]', { status: 200 })
      }),
    )

    const res = await GET(request() as never)
    const svg = await res.text()

    expect(svg).not.toContain('Pikachu')
    expect(svg).not.toContain('dressed on')
    expect(svg).not.toContain('data:image/png')
  })
})
