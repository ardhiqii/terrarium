/**
 * `core.js` holds the extension's pure logic (cache TTL, URL building,
 * batching, theme detection) and is loaded as a plain classic script that
 * attaches `window.GardenCreatures` (falling back to `globalThis` when
 * `window` is undefined, see its file header). That fallback is exactly
 * what makes it importable here: in Node, `typeof window === 'undefined'`,
 * so the IIFE binds to `globalThis` instead, and `import './core.js'`
 * (or plain `require`) executes it and leaves `globalThis.GardenCreatures`
 * populated. CONFIRMED IMPORTABLE IN NODE, no restructuring needed and none
 * attempted.
 *
 * Everything below is black-box against the exported `GardenCreatures`
 * surface: `chrome.*` and `document`/`matchMedia` are stubbed per test, but
 * no internal (non-exported) helper -- like the exact storage key format --
 * is depended on. "Cache hit" is proven by calling `getCreature` twice and
 * observing the second call makes no `chrome.runtime.sendMessage` call,
 * never by reaching into storage directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import './core.js'

const GC = globalThis.GardenCreatures

// ---------------------------------------------------------------------------
// chrome.* mock: minimal callback-based chrome.storage.local +
// chrome.runtime.sendMessage, matching the shapes core.js actually calls.
// ---------------------------------------------------------------------------

function installChromeMock({ sendMessage } = {}) {
  const store = {}
  const chromeMock = {
    runtime: {
      lastError: null,
      sendMessage:
        sendMessage ??
        vi.fn((_message, callback) => {
          callback({ ok: false, error: 'no handler configured for this test' })
        }),
    },
    storage: {
      local: {
        get(keys, callback) {
          if (typeof keys === 'string') {
            callback(keys in store ? { [keys]: store[keys] } : {})
            return
          }
          const result = {}
          for (const k of keys) if (k in store) result[k] = store[k]
          callback(result)
        },
        set(items, callback) {
          Object.assign(store, items)
          if (callback) callback()
        },
      },
    },
  }
  vi.stubGlobal('chrome', chromeMock)
  return { store, chromeMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Import surface
// ---------------------------------------------------------------------------

describe('core.js is importable in Node', () => {
  it('attaches GardenCreatures to globalThis with the expected surface', () => {
    expect(GC).toBeTypeOf('object')
    expect(GC.getCreature).toBeTypeOf('function')
    expect(GC.getCreaturesBatched).toBeTypeOf('function')
    expect(GC.getGithubTheme).toBeTypeOf('function')
    expect(GC.CACHE_TTL_MS).toBeTypeOf('number')
  })
})

// ---------------------------------------------------------------------------
// Cache TTL
// ---------------------------------------------------------------------------

describe('cache TTL', () => {
  it('a fresh cache entry means zero fetches on the second call', async () => {
    const sendMessage = vi.fn((message, callback) => {
      callback({ ok: true, data: { stage: { id: 'sporeling' } } })
    })
    installChromeMock({ sendMessage })

    const user = 'cache-fresh-user'
    const first = await GC.getCreature(user)
    expect(first.error).toBeNull()
    expect(first.fromCache).toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(1)

    const second = await GC.getCreature(user)
    expect(second.fromCache).toBe(true)
    expect(second.data).toEqual(first.data)
    expect(sendMessage).toHaveBeenCalledTimes(1) // no additional network call
  })

  it('an entry older than CACHE_TTL_MS is treated as a miss and refetches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    const sendMessage = vi.fn((message, callback) => {
      callback({ ok: true, data: { stage: { id: 'sporeling' } } })
    })
    installChromeMock({ sendMessage })

    const user = 'cache-stale-user'
    await GC.getCreature(user)
    expect(sendMessage).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(Date.now() + GC.CACHE_TTL_MS + 1))

    const second = await GC.getCreature(user)
    expect(second.fromCache).toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('an entry exactly at the TTL boundary is still fresh (uses > not >=)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    const sendMessage = vi.fn((message, callback) => {
      callback({ ok: true, data: {} })
    })
    installChromeMock({ sendMessage })

    const user = 'cache-boundary-user'
    await GC.getCreature(user)
    vi.setSystemTime(new Date(Date.now() + GC.CACHE_TTL_MS))

    const second = await GC.getCreature(user)
    expect(second.fromCache).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// API URL construction
// ---------------------------------------------------------------------------

describe('API URL construction', () => {
  it('builds the user-only URL shape against the default API base', async () => {
    let capturedUrl = null
    const sendMessage = vi.fn((message, callback) => {
      capturedUrl = message.url
      callback({ ok: true, data: {} })
    })
    installChromeMock({ sendMessage })

    await GC.getCreature('Octocat')
    expect(capturedUrl).toBe(`${GC.DEFAULT_API_BASE}/api/creature?user=Octocat`)
  })

  it('builds the user+repo URL shape', async () => {
    let capturedUrl = null
    const sendMessage = vi.fn((message, callback) => {
      capturedUrl = message.url
      callback({ ok: true, data: {} })
    })
    installChromeMock({ sendMessage })

    await GC.getCreature('Octocat', 'My-Repo')
    const url = new URL(capturedUrl)
    expect(url.pathname).toBe('/api/creature')
    expect(url.searchParams.get('user')).toBe('Octocat')
    expect(url.searchParams.get('repo')).toBe('My-Repo')
  })

  it('strips trailing slashes from a configured apiBase', async () => {
    let capturedUrl = null
    const sendMessage = vi.fn((message, callback) => {
      capturedUrl = message.url
      callback({ ok: true, data: {} })
    })
    installChromeMock({ sendMessage })

    await GC.setSettings({ apiBase: 'https://example.com///' })
    await GC.getCreature('someone')
    expect(capturedUrl).toBe('https://example.com/api/creature?user=someone')
  })
})

// ---------------------------------------------------------------------------
// Bounded concurrency + the 30-repo cap
// ---------------------------------------------------------------------------

describe('getCreaturesBatched: concurrency and the 30-repo cap', () => {
  it('never runs more than the concurrency cap at once, and caps at 30 requests', async () => {
    let active = 0
    let peakActive = 0
    let callCount = 0

    const sendMessage = vi.fn((message, callback) => {
      callCount++
      active++
      peakActive = Math.max(peakActive, active)
      setTimeout(() => {
        active--
        callback({ ok: true, data: { user: message.url } })
      }, 15)
    })
    installChromeMock({ sendMessage })

    const requests = Array.from({ length: 40 }, (_, i) => ({ user: `batch-user-${i}` }))
    const results = await GC.getCreaturesBatched(requests)

    // Bounded to MAX_REPOS_PER_PASS (30): only the first 30 requests are
    // even attempted, and the result array reflects exactly that many.
    expect(results.length).toBe(30)
    expect(callCount).toBe(30)

    // FETCH_CONCURRENCY (3): at no point were more than 3 network calls
    // in flight simultaneously.
    expect(peakActive).toBeLessThanOrEqual(3)
    expect(peakActive).toBeGreaterThan(1) // sanity: concurrency was actually exercised
  })

  it('a cache hit inside a batch resolves without consuming a network call', async () => {
    const sendMessage = vi.fn((message, callback) => {
      callback({ ok: true, data: { hit: false } })
    })
    installChromeMock({ sendMessage })

    // Prime the cache for one user via a normal call first.
    await GC.getCreature('already-cached-user')
    sendMessage.mockClear()

    const results = await GC.getCreaturesBatched([
      { user: 'already-cached-user' },
      { user: 'brand-new-user' },
    ])

    expect(results[0].fromCache).toBe(true)
    expect(results[1].fromCache).toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(1) // only the uncached one
  })
})

// ---------------------------------------------------------------------------
// Theme detection
// ---------------------------------------------------------------------------

describe('getGithubTheme', () => {
  function stubDocument({ colorMode, prefersDark } = {}) {
    vi.stubGlobal('document', {
      documentElement: {
        getAttribute: (name) => (name === 'data-color-mode' ? (colorMode ?? null) : null),
      },
    })
    vi.stubGlobal('matchMedia', (query) => ({
      matches: query.includes('dark') ? Boolean(prefersDark) : false,
    }))
  }

  it("reads data-color-mode='dark'", () => {
    stubDocument({ colorMode: 'dark' })
    expect(GC.getGithubTheme()).toBe('dark')
  })

  it("reads data-color-mode='light'", () => {
    stubDocument({ colorMode: 'light' })
    expect(GC.getGithubTheme()).toBe('light')
  })

  it("falls back to prefers-color-scheme when data-color-mode is 'auto'", () => {
    stubDocument({ colorMode: 'auto', prefersDark: true })
    expect(GC.getGithubTheme()).toBe('dark')
  })

  it('falls back to prefers-color-scheme when data-color-mode is absent', () => {
    stubDocument({ colorMode: undefined, prefersDark: false })
    expect(GC.getGithubTheme()).toBe('light')
  })

  it('defaults to light without throwing when document is unavailable', () => {
    vi.stubGlobal('document', undefined)
    expect(() => GC.getGithubTheme()).not.toThrow()
    expect(GC.getGithubTheme()).toBe('light')
  })
})

// ---------------------------------------------------------------------------
// Never throws into the caller
// ---------------------------------------------------------------------------

describe('a failed API call degrades quietly and never throws', () => {
  it('resolves { data: null, error } when chrome.runtime is entirely unavailable', async () => {
    vi.stubGlobal('chrome', undefined)
    const result = await GC.getCreature('no-extension-runtime')
    expect(result.data).toBeNull()
    expect(typeof result.error).toBe('string')
  })

  it('resolves { data: null, error } when chrome.runtime.lastError is set', async () => {
    const sendMessage = vi.fn((message, callback) => {
      // Simulate the extension messaging API surfacing an error via
      // chrome.runtime.lastError instead of the callback argument, exactly
      // as requestFetch checks for.
      chromeMockRef.chromeMock.runtime.lastError = { message: 'receiving end does not exist' }
      callback(undefined)
      chromeMockRef.chromeMock.runtime.lastError = null
    })
    const chromeMockRef = installChromeMock({ sendMessage })

    const result = await GC.getCreature('last-error-user')
    expect(result.data).toBeNull()
    expect(typeof result.error).toBe('string')
  })

  it('resolves { data: null, error } when sendMessage throws synchronously', async () => {
    const sendMessage = vi.fn(() => {
      throw new Error('extension context invalidated')
    })
    installChromeMock({ sendMessage })

    await expect(GC.getCreature('throwing-user')).resolves.toEqual(
      expect.objectContaining({ data: null, error: expect.any(String) })
    )
  })

  it('a batch with some failing requests still resolves every slot without throwing', async () => {
    const sendMessage = vi.fn((message, callback) => {
      if (message.url.includes('bad-user')) {
        callback({ ok: false, error: 'upstream 404' })
      } else {
        callback({ ok: true, data: { fine: true } })
      }
    })
    installChromeMock({ sendMessage })

    const results = await GC.getCreaturesBatched([
      { user: 'good-user-1' },
      { user: 'bad-user-1' },
      { user: 'good-user-2' },
    ])
    expect(results).toHaveLength(3)
    expect(results[1].data).toBeNull()
    expect(results[1].error).toBe('upstream 404')
    expect(results[0].data).toEqual({ fine: true })
  })
})

// ---------------------------------------------------------------------------
// Species assignment (T19): every repo gets its own line, deterministically.
// Mirrors src/lib/game/species-assign.test.ts, ported here because this is
// a second, independent implementation (core.js cannot import across the
// src/ boundary) that must not silently drift from the Next app's.
// ---------------------------------------------------------------------------

describe('SPECIES_LINES (extension copy)', () => {
  it('every id is within the animated generation-v range (1-649)', () => {
    for (const line of GC.SPECIES_LINES) {
      for (const id of Object.values(line.stages)) {
        expect(id).toBeGreaterThanOrEqual(1)
        expect(id).toBeLessThanOrEqual(649)
      }
    }
  })

  it('the grass line matches the Next app default exactly', () => {
    const grass = GC.getSpeciesLine('grass')
    expect(grass.stages).toEqual({ sporeling: 191, mossling: 43, bracken: 2, heartwood: 389 })
  })
})

describe('assignSpeciesLine (extension copy)', () => {
  it('is deterministic: the same repo always resolves to the same line', () => {
    const repo = { name: 'my-repo', language: 'Rust', createdAt: '2024-01-01T00:00:00Z', pushedAt: '2026-01-01T00:00:00Z', sizeKb: 400 }
    const first = GC.assignSpeciesLine('octocat', repo)
    for (let i = 0; i < 10; i++) {
      expect(GC.assignSpeciesLine('octocat', repo).id).toBe(first.id)
    }
  })

  it('maps a known language to its line', () => {
    expect(GC.assignSpeciesLine('octocat', { name: 'r', language: 'Rust' }).id).toBe('ember')
    expect(GC.assignSpeciesLine('octocat', { name: 'r', language: 'Python' }).id).toBe('bedrock')
  })

  it('TypeScript and Go resolve to different lines', () => {
    const ts = GC.assignSpeciesLine('octocat', { name: 'r', language: 'TypeScript' })
    const go = GC.assignSpeciesLine('octocat', { name: 'r', language: 'Go' })
    expect(ts.id).not.toBe(go.id)
  })

  it('falls back to a hash-selected line, not always grass, for an unmapped language', () => {
    const seen = new Set()
    for (let i = 0; i < 10; i++) {
      seen.add(GC.assignSpeciesLine('octocat', { name: `repo-${i}`, language: 'brainfuck' }).id)
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('resolveVariant (extension copy of src/lib/game/variants.ts)', () => {
  function stats(overrides = {}) {
    return {
      noteCount: 0,
      projectCount: 0,
      totalWords: 0,
      resolvedWikilinks: 0,
      tagCount: 0,
      maturityCounts: { seedling: 0, budding: 0, evergreen: 0 },
      ...overrides,
    }
  }

  function github(overrides = {}) {
    return { currentStreakDays: 0, ...overrides }
  }

  it('returns null for a zeroed companion (the common case for repo/cluster stats)', () => {
    expect(GC.resolveVariant(stats(), null)).toBeNull()
  })

  it('fires woven on a dense-but-small ratio, regardless of absolute size', () => {
    const small = stats({ noteCount: 6, resolvedWikilinks: 18 })
    const big = stats({ noteCount: 100, resolvedWikilinks: 300 })
    expect(GC.resolveVariant(small, null)).toBe('woven')
    expect(GC.resolveVariant(big, null)).toBe('woven')
  })

  it('fires steady from a companion\'s own GitHub streak alone', () => {
    expect(GC.resolveVariant(stats(), github({ currentStreakDays: 21 }))).toBe('steady')
    expect(GC.resolveVariant(stats(), github({ currentStreakDays: 20 }))).toBeNull()
  })

  it('fires deep on a small, wordy, mostly-evergreen garden', () => {
    const deepGarden = stats({
      noteCount: 3,
      totalWords: 1800,
      maturityCounts: { seedling: 1, budding: 0, evergreen: 2 },
    })
    expect(GC.resolveVariant(deepGarden, null)).toBe('deep')
  })

  it('fires broad on a wide tag vocabulary relative to entry count', () => {
    const broadGarden = stats({ noteCount: 8, tagCount: 20 })
    expect(GC.resolveVariant(broadGarden, null)).toBe('broad')
  })

  it('resolves deep over woven when both fire, matching variants.ts precedence', () => {
    const both = stats({
      noteCount: 6,
      totalWords: 3600,
      resolvedWikilinks: 18,
      maturityCounts: { seedling: 3, budding: 0, evergreen: 3 },
    })
    expect(GC.resolveVariant(both, null)).toBe('deep')
  })
})
