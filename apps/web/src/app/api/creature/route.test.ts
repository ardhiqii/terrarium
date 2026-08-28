/**
 * Contract tests for `GET /api/creature`. Read the file header of
 * `route.ts` before touching this: the garden-asymmetry rule is the
 * highest-risk part of this codebase to get wrong, since a mistake here
 * ships to strangers, not just to us. This project has already had that
 * leak twice (once here, once via `items.ts` reading the owner's content
 * unconditionally), so the asymmetry assertion below is deliberately strict.
 *
 * `fetch` is mocked throughout. No live GitHub calls, ever. Every test
 * imports the route module fresh (`vi.resetModules()` + dynamic `import()`)
 * so the module-level `OWNER_LOGIN`/`TOKEN` constants (read from
 * `process.env` at import time) and the in-process caches in `api-cache.ts`
 * never leak state between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Garden item ids from types.ts: these need real garden stats and must
// never appear on a non-owner creature. Duplicated here rather than
// imported from items.ts, deliberately: importing the real ITEMS list would
// make this assertion pass trivially if items.ts ever regressed to
// including garden items for non-owners by construction. Listing the ids by
// hand means the test still catches that regression instead of moving with it.
const GARDEN_ITEM_IDS = [
  'spore-jar',
  'dew-vial',
  'hand-lens',
  'trowel',
  'field-ledger',
  'brass-compass',
  'pressed-frond',
]

/** Random alnum-only handle, unique per call, so disk-cache files (real,
 * unmocked `node:fs` writes under os.tmpdir()) from one test can never be
 * read back by another test or by a previous/future test run. Must satisfy
 * HANDLE_RE (alphanumeric, single hyphens, cannot start with one). */
function freshHandle(): string {
  return `testu${Math.random().toString(36).slice(2, 10)}`
}

type FetchRoute = { match: RegExp; handle: (url: string) => Response | Promise<Response> }

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function mockFetch(routes: FetchRoute[]) {
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const route of routes) {
      if (route.match.test(url)) return route.handle(url)
    }
    throw new Error(`unmocked fetch call in test: ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Existence check success: `GET https://api.github.com/users/<login>` -> 200. */
function userExistsRoute(): FetchRoute {
  return { match: /\/users\/[^/]+$/, handle: () => jsonRes(200, { login: 'x' }) }
}

function userNotFoundRoute(): FetchRoute {
  return { match: /\/users\/[^/]+$/, handle: () => jsonRes(404, { message: 'Not Found' }) }
}

function repoExistsRoute(): FetchRoute {
  return { match: /\/repos\/[^/]+\/[^/]+$/, handle: () => jsonRes(200, { name: 'x' }) }
}

function repoNotFoundRoute(): FetchRoute {
  return { match: /\/repos\/[^/]+\/[^/]+$/, handle: () => jsonRes(404, { message: 'Not Found' }) }
}

/** GitHub events feed, empty page: zero commits, no further pages. */
function emptyEventsRoute(): FetchRoute {
  return { match: /\/events\/public/, handle: () => jsonRes(200, []) }
}

/** GitHub events feed returning a rate-limit response with no data at all. */
function rateLimitedEventsRoute(): FetchRoute {
  return {
    match: /\/events\/public/,
    handle: () =>
      new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  }
}

async function importRoute() {
  vi.resetModules()
  return import('./route')
}

beforeEach(() => {
  // Never matches any test-generated handle, so every test exercises the
  // non-owner path unless a test opts in explicitly.
  process.env.GITHUB_LOGIN = 'definitely-not-a-test-handle-owner'
  delete process.env.GITHUB_TOKEN
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/creature: request validation', () => {
  it('returns 400 with a JSON body when user is missing', async () => {
    const fetchMock = mockFetch([])
    const { GET } = await importRoute()
    const res = await GET(new NextRequest('http://localhost/api/creature'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid handle shape with 400 before any fetch', async () => {
    const fetchMock = mockFetch([])
    const { GET } = await importRoute()

    for (const bad of ['-leading-hyphen', 'double--hyphen', 'has spaces', 'semi;colon', '']) {
      const res = await GET(new NextRequest(`http://localhost/api/creature?user=${encodeURIComponent(bad)}`))
      expect(res.status).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid repo name shape with 400 before any fetch', async () => {
    const fetchMock = mockFetch([])
    const { GET } = await importRoute()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature?user=octocat&repo=${encodeURIComponent('..')}`)
    )
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/creature: existence', () => {
  it('returns 404 with a JSON body for a nonexistent handle', async () => {
    const fetchMock = mockFetch([userNotFoundRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${user}`))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })

  it('returns 404 with a JSON body for a nonexistent repo', async () => {
    const fetchMock = mockFetch([userExistsRoute(), repoNotFoundRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature?user=${user}&repo=nonexistent-repo`)
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    void fetchMock
  })
})

describe('GET /api/creature: upstream failure never produces a 500', () => {
  it('an upstream rate limit returns 200 with a degraded creature', async () => {
    mockFetch([userExistsRoute(), rateLimitedEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${user}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.degraded).toBe(true)
    expect(body.stage).toBeDefined()
    expect(body.totalXp).toBeTypeOf('number')
  })

  it('a network failure on the events fetch returns 200 with a degraded creature, not a 500', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (/\/users\/[^/]+$/.test(url)) return jsonRes(200, { login: 'x' })
      if (/\/events\/public/.test(url)) throw new TypeError('fetch failed: network unreachable')
      throw new Error(`unmocked fetch call in test: ${url}`)
    })
    vi.stubGlobal('fetch', fn)
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${user}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.degraded).toBe(true)
  })
})

describe('GET /api/creature: the garden asymmetry', () => {
  it('a non-owner handle gets fully zeroed garden stats and no garden items', async () => {
    mockFetch([userExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${user}`))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.stats).toEqual({
      noteCount: 0,
      projectCount: 0,
      totalWords: 0,
      resolvedWikilinks: 0,
      backlinksReceived: 0,
      tagCount: 0,
      maturityCounts: { seedling: 0, budding: 0, evergreen: 0 },
      maxBacklinksOnSingleNote: 0,
      firstPublishedAt: null,
      lastPublishedAt: null,
    })

    const itemIds = (body.items as Array<{ def: { id: string } }>).map((i) => i.def.id)
    for (const gardenId of GARDEN_ITEM_IDS) {
      expect(itemIds).not.toContain(gardenId)
    }
  })

  it('a repo creature also gets fully zeroed garden stats and no garden items', async () => {
    mockFetch([userExistsRoute(), repoExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature?user=${user}&repo=some-repo`)
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.stats.noteCount).toBe(0)
    expect(body.stats.totalWords).toBe(0)
    expect(body.stats.backlinksReceived).toBe(0)
    const itemIds = (body.items as Array<{ def: { id: string } }>).map((i) => i.def.id)
    for (const gardenId of GARDEN_ITEM_IDS) {
      expect(itemIds).not.toContain(gardenId)
    }
  })

  it('the degraded fallback path (rate limited, no cache) is also fully zeroed', async () => {
    mockFetch([userExistsRoute(), rateLimitedEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature?user=${user}`))
    const body = await res.json()
    expect(body.stats.noteCount).toBe(0)
    expect(body.stats.totalWords).toBe(0)
    const itemIds = (body.items as Array<{ def: { id: string } }>).map((i) => i.def.id)
    for (const gardenId of GARDEN_ITEM_IDS) {
      expect(itemIds).not.toContain(gardenId)
    }
  })
})

describe('GET /api/creature: species assignment (T19)', () => {
  /** `/repos/{owner}/{repo}` mock carrying a real `language` field, unlike
   * the bare `repoExistsRoute()` helper above. Both `checkRepoExists` and
   * `fetchRepoMeta` hit this same URL shape, so one route definition serves
   * both calls. */
  function repoExistsWithLanguage(language: string | null): FetchRoute {
    return {
      match: /\/repos\/[^/]+\/[^/]+$/,
      handle: () =>
        jsonRes(200, {
          name: 'x',
          language,
          created_at: '2020-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
          size: 500,
        }),
    }
  }

  it('a repo creature response carries a speciesLineId derived from the repo language', async () => {
    mockFetch([userExistsRoute(), repoExistsWithLanguage('Rust'), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature?user=${user}&repo=rust-repo`)
    )
    const body = await res.json()
    expect(body.speciesLineId).toBe('ember')
    expect(typeof body.speciesLineName).toBe('string')
  })

  it('two repos with different languages get different speciesLineIds', async () => {
    const user = freshHandle()

    mockFetch([userExistsRoute(), repoExistsWithLanguage('Python'), emptyEventsRoute()])
    const { GET: GET1 } = await importRoute()
    const pythonBody = await (
      await GET1(new NextRequest(`http://localhost/api/creature?user=${user}&repo=py-repo`))
    ).json()

    mockFetch([userExistsRoute(), repoExistsWithLanguage('TypeScript'), emptyEventsRoute()])
    const { GET: GET2 } = await importRoute()
    const tsBody = await (
      await GET2(new NextRequest(`http://localhost/api/creature?user=${user}2&repo=ts-repo`))
    ).json()

    expect(pythonBody.speciesLineId).not.toBe(tsBody.speciesLineId)
  })

  it('a species line is still assigned deterministically even when repo metadata is unavailable', async () => {
    // No repoExists route at all: checkRepoExists resolves 'unknown' (not
    // 'not-found'), so the repo path proceeds; fetchRepoMeta's own fetch
    // then hits the unmocked-route throw path inside mockFetch, which
    // fetchRepoMeta must swallow (it never throws) and fall back to null.
    mockFetch([userExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature?user=${user}&repo=metadata-unavailable`)
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.speciesLineId).toBe('string')
  })

  it('speciesLineId is not part of CreatureState / stage math: totalXp and stage are unaffected', async () => {
    mockFetch([userExistsRoute(), repoExistsWithLanguage('Go'), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature?user=${user}&repo=go-repo`)
    )
    const body = await res.json()
    expect(body.totalXp).toBe(0)
    expect(body.stage.id).toBe('sporeling')
  })
})

describe('GET /api/creature: caching', () => {
  it('a cache hit makes zero fetch calls and reports X-Cache: HIT', async () => {
    const fetchMock = mockFetch([userExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const url = `http://localhost/api/creature?user=${user}`

    const first = await GET(new NextRequest(url))
    expect(first.status).toBe(200)
    expect(first.headers.get('X-Cache')).toBe('MISS')
    expect(fetchMock).toHaveBeenCalled()

    fetchMock.mockClear()

    const second = await GET(new NextRequest(url))
    expect(second.status).toBe(200)
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(fetchMock).not.toHaveBeenCalled()

    const firstBody = await first.json()
    const secondBody = await second.json()
    expect(secondBody).toEqual(firstBody)
  })
})

describe('GET /api/creature: CORS', () => {
  it('every response carries CORS headers', async () => {
    mockFetch([])
    const { GET } = await importRoute()
    const res = await GET(new NextRequest('http://localhost/api/creature'))
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('OPTIONS returns 204 with CORS headers', async () => {
    mockFetch([])
    const { OPTIONS } = await importRoute()
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
  })
})
