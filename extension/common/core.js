/**
 * Shared namespace for the Garden Creatures extension.
 *
 * No bundler, no npm dependencies. This file and its consumers
 * (content/content.js, popup/popup.js) are loaded as plain classic scripts
 * that share one global object, `window.GardenCreatures`. That works because
 * MV3 content scripts declared with multiple `js` entries execute in order
 * in the same isolated-world global scope, and popup.html can load the same
 * file with a normal <script> tag. ES modules would need either a bundler
 * (rejected, see report) or `web_accessible_resources` plumbing for content
 * scripts, which is extra surface for no real benefit at this size (a few
 * hundred lines total). A shared global namespace is the plain-JS
 * equivalent of a shared module and keeps every file inspectable as-is.
 *
 * Everything in here is defensive: a broken fetch, a missing storage API, or
 * a malformed cache entry must never throw into the caller. Content scripts
 * in particular must never throw into the host page (see AGENTS.md / T8).
 */
;(function (global) {
  'use strict'

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  /** Sensible default for local development against `npm run dev`. */
  const DEFAULT_API_BASE = 'http://localhost:3000'

  /** Cache TTL for creature responses. At least an hour per the spec. */
  const CACHE_TTL_MS = 60 * 60 * 1000

  /** Never fetch more repos than a single GitHub list/grid page can show. */
  const MAX_REPOS_PER_PASS = 30

  /** Concurrency cap so a cold cache still doesn't fire a burst of requests. */
  const FETCH_CONCURRENCY = 3

  const STORAGE_KEYS = {
    settings: 'gc:settings',
    cachePrefix: 'gc:cache:',
    networkCallCount: 'gc:debug:networkCallCount',
  }

  const DEFAULT_SETTINGS = {
    apiBase: DEFAULT_API_BASE,
    handle: '',
    debug: false,
  }

  /**
   * Mirrors `src/lib/game/sprites/species.ts` (`SPECIES_LINES`), the Next
   * app's source of truth for the species pool. Duplicated here
   * deliberately: the extension is a separate, dependency-free build that
   * cannot import across the `src/` boundary (and must not touch it, see
   * tasks/T8.md). Keep in sync by hand if the Next app's line data changes.
   * Ids stay inside the animated generation-v range (1-649); every id here
   * was verified live against the documented sprite URL before shipping
   * (see the T19 report).
   */
  const SPECIES_LINES = [
    {
      id: 'grass',
      languages: [],
      stages: { sporeling: 191, mossling: 43, bracken: 2, heartwood: 389 },
    },
    {
      id: 'ember',
      languages: ['c', 'c++', 'cpp', 'rust', 'zig', 'assembly', 'objective-c'],
      stages: { sporeling: 255, mossling: 4, bracken: 5, heartwood: 6 },
    },
    {
      id: 'current',
      languages: ['javascript', 'typescript'],
      stages: { sporeling: 172, mossling: 25, bracken: 125, heartwood: 466 },
    },
    {
      id: 'tide',
      languages: ['java', 'kotlin', 'scala', 'c#', 'csharp', 'groovy', 'clojure'],
      stages: { sporeling: 258, mossling: 7, bracken: 8, heartwood: 9 },
    },
    {
      id: 'bedrock',
      languages: ['python', 'r', 'matlab', 'julia'],
      stages: { sporeling: 74, mossling: 75, bracken: 76, heartwood: 208 },
    },
    {
      id: 'venom',
      languages: ['ruby', 'php', 'perl', 'lua'],
      stages: { sporeling: 23, mossling: 24, bracken: 336, heartwood: 130 },
    },
    {
      id: 'psychic',
      languages: ['haskell', 'ocaml', 'elixir', 'erlang', 'f#', 'fsharp', 'elm', 'lisp', 'scheme'],
      stages: { sporeling: 63, mossling: 64, bracken: 65, heartwood: 150 },
    },
    {
      id: 'steel',
      languages: ['shell', 'dockerfile', 'yaml', 'hcl', 'makefile', 'powershell', 'nix'],
      stages: { sporeling: 81, mossling: 82, bracken: 375, heartwood: 376 },
    },
    {
      id: 'bloom',
      languages: ['css', 'html', 'dart', 'vue', 'svelte', 'scss', 'less'],
      stages: { sporeling: 187, mossling: 188, bracken: 189, heartwood: 407 },
    },
  ]

  const DEFAULT_SPECIES_LINE_ID = 'grass'

  // ---------------------------------------------------------------------
  // Variants (T30)
  //
  // Mirrors `src/lib/game/variants.ts` by hand, same reason SPECIES_LINES
  // above is duplicated rather than imported: the extension cannot cross
  // the `src/` boundary. `/api/creature`'s response body is `{ ...state,
  // ... }` (see route.ts), and `state` (a `CreatureState`) already carries
  // `stats` and `github` verbatim, so every badge here computes the exact
  // same variant the site itself would show for that creature -- no extra
  // fetch, just fields already on the response `getCreature()` returns.
  //
  // Keep every constant numerically identical to variants.ts if that file
  // ever changes; a mismatch here means the extension badge and the site
  // disagree about the same creature.
  // ---------------------------------------------------------------------

  const WOVEN_MIN_ENTRIES = 6
  const WOVEN_LINKS_PER_ENTRY = 3
  const STEADY_STREAK_DAYS = 21
  const DEEP_MIN_ENTRIES = 3
  // There is deliberately NO upper bound on entries, matching
  // src/lib/game/variants.ts. A ceiling made `deep` the only variant you
  // could LOSE by writing more, which is the wrong incentive for a garden.
  // This copy kept the old ceiling of 15 after the site dropped it, so a
  // garden with 16+ entries read as `deep` on the site and not on its badge.
  const DEEP_WORDS_PER_ENTRY = 600
  const DEEP_EVERGREEN_RATIO = 0.5
  const BROAD_MIN_TAGS = 8
  const BROAD_TAGS_PER_ENTRY = 2.5

  function entryCount(stats) {
    return (stats && stats.noteCount ? stats.noteCount : 0) +
      (stats && stats.projectCount ? stats.projectCount : 0)
  }

  function isWoven(stats) {
    if (!stats) return false
    const entries = entryCount(stats)
    if (entries < WOVEN_MIN_ENTRIES) return false
    return (stats.resolvedWikilinks || 0) / entries >= WOVEN_LINKS_PER_ENTRY
  }

  function isSteady(github) {
    if (!github) return false
    return (github.currentStreakDays || 0) >= STEADY_STREAK_DAYS
  }

  function isDeep(stats) {
    if (!stats) return false
    const entries = entryCount(stats)
    if (entries < DEEP_MIN_ENTRIES) return false
    if ((stats.totalWords || 0) / entries < DEEP_WORDS_PER_ENTRY) return false
    const evergreen = (stats.maturityCounts && stats.maturityCounts.evergreen) || 0
    return evergreen / entries >= DEEP_EVERGREEN_RATIO
  }

  function isBroad(stats) {
    if (!stats) return false
    const entries = entryCount(stats)
    const tagCount = stats.tagCount || 0
    if (entries <= 0) return false
    if (tagCount < BROAD_MIN_TAGS) return false
    return tagCount / entries >= BROAD_TAGS_PER_ENTRY
  }

  /**
   * Precedence, identical to `resolveVariant` in variants.ts:
   * deep > woven > broad > steady. See that file for the full reasoning
   * (more simultaneous conditions = a more specific, harder-to-fake signal,
   * so it wins over a looser one that also happens to be true).
   */
  function resolveVariant(stats, github) {
    if (isDeep(stats)) return 'deep'
    if (isWoven(stats)) return 'woven'
    if (isBroad(stats)) return 'broad'
    if (isSteady(github)) return 'steady'
    return null
  }

  const LANGUAGE_TO_LINE = {}
  for (const line of SPECIES_LINES) {
    for (const lang of line.languages) LANGUAGE_TO_LINE[lang.toLowerCase()] = line
  }

  function getSpeciesLine(id) {
    return SPECIES_LINES.find((l) => l.id === id) || SPECIES_LINES[0]
  }

  /**
   * Mirrors `src/lib/game/species-assign.ts`'s FNV-1a hash exactly, so a
   * repo with an unmapped language resolves to the same fallback line here
   * as it would server-side, if this ever needs to agree with the API's own
   * assignment. The popup does not currently call the API for this (it
   * assigns locally from the repo list it already fetched), but keeping the
   * algorithm identical avoids two subtly different "random-looking"
   * assignments for the same repo depending on which surface you're on.
   */
  function fnv1a(str) {
    let hash = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
  }

  /**
   * Deterministic species assignment, mirroring `species-assign.ts`.
   * `repo` is `{ name, language, createdAt, pushedAt, sizeKb }`.
   */
  function assignSpeciesLine(owner, repo) {
    const lang = repo.language ? String(repo.language).toLowerCase().trim() : ''
    if (lang && LANGUAGE_TO_LINE[lang]) return LANGUAGE_TO_LINE[lang]

    const key = [
      `${String(owner).toLowerCase()}/${String(repo.name).toLowerCase()}`,
      lang || 'no-language',
      repo.createdAt || 'age-unknown',
      String(repo.sizeKb == null ? 'size-unknown' : repo.sizeKb),
      repo.pushedAt || 'cadence-unknown',
    ].join('|')
    const index = fnv1a(key) % SPECIES_LINES.length
    return SPECIES_LINES[index]
  }

  function spriteUrl(stageId, lineId) {
    const line = getSpeciesLine(lineId || DEFAULT_SPECIES_LINE_ID)
    const id = line.stages[stageId]
    if (!id) return null
    return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${id}.gif`
  }

  // -------------------------------------------------------------------------
  // Debug logging, gated behind a single flag, off by default
  // -------------------------------------------------------------------------

  function log(...args) {
    getSettings()
      .then((settings) => {
        if (settings.debug) console.log('[garden-creatures]', ...args)
      })
      .catch(() => {})
  }

  // -------------------------------------------------------------------------
  // chrome.storage.local wrappers, promise-based, never throw
  // -------------------------------------------------------------------------

  function hasChromeStorage() {
    return (
      typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
    )
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!hasChromeStorage()) return resolve({})
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve({})
          resolve(result || {})
        })
      } catch {
        resolve({})
      }
    })
  }

  function storageSet(items) {
    return new Promise((resolve) => {
      if (!hasChromeStorage()) return resolve(false)
      try {
        chrome.storage.local.set(items, () => resolve(true))
      } catch {
        resolve(false)
      }
    })
  }

  async function getSettings() {
    try {
      const result = await storageGet(STORAGE_KEYS.settings)
      const stored = result[STORAGE_KEYS.settings]
      return { ...DEFAULT_SETTINGS, ...(stored || {}) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  async function setSettings(partial) {
    const current = await getSettings()
    const next = { ...current, ...partial }
    await storageSet({ [STORAGE_KEYS.settings]: next })
    return next
  }

  function cacheKeyFor(user, repo) {
    const u = String(user || '').toLowerCase()
    const r = repo ? String(repo).toLowerCase() : null
    return STORAGE_KEYS.cachePrefix + (r ? `${u}/${r}` : u)
  }

  async function cacheGet(key) {
    try {
      const result = await storageGet(key)
      const entry = result[key]
      if (!entry || typeof entry.fetchedAt !== 'number') return null
      if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
      return entry
    } catch {
      return null
    }
  }

  async function cacheSet(key, data) {
    try {
      await storageSet({ [key]: { data, fetchedAt: Date.now() } })
    } catch {
      // Best-effort. A failed cache write just means the next load refetches.
    }
  }

  async function incrementNetworkCallCount() {
    try {
      const result = await storageGet(STORAGE_KEYS.networkCallCount)
      const count = (result[STORAGE_KEYS.networkCallCount] || 0) + 1
      await storageSet({ [STORAGE_KEYS.networkCallCount]: count })
      return count
    } catch {
      return -1
    }
  }

  async function getNetworkCallCount() {
    const result = await storageGet(STORAGE_KEYS.networkCallCount)
    return result[STORAGE_KEYS.networkCallCount] || 0
  }

  // -------------------------------------------------------------------------
  // Fetching, cache-first. A fresh cache hit makes ZERO network calls.
  //
  // The actual fetch() runs in background/background.js, not here. A
  // content script's own fetch is still bound by the host page's CSP
  // connect-src even inside the isolated world (verified against a real
  // github.com page while building this), so the network call is delegated
  // to the service worker via chrome.runtime.sendMessage, which runs in the
  // extension's own context and is governed by host_permissions instead.
  // The popup goes through the same path for one code path instead of two.
  // -------------------------------------------------------------------------

  function requestFetch(url) {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ ok: false, error: 'extension runtime unavailable' })
        return
      }
      try {
        chrome.runtime.sendMessage({ type: 'GC_FETCH', url }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message })
            return
          }
          resolve(response || { ok: false, error: 'no response from background' })
        })
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message ? err.message : err) })
      }
    })
  }

  /**
   * Resolves a creature for `user` (and optionally `repo`). Cache-first:
   * a fresh hit resolves without touching `fetch` at all. On a miss, calls
   * `GET {apiBase}/api/creature?user=...[&repo=...]` (the only shape T6's
   * route exposes; see the extension report for the batch shape this task
   * wishes existed) and writes the result back to the cache.
   *
   * Never throws. Returns `{ data: null, error }` on failure so callers can
   * decide whether to skip rendering.
   */
  async function getCreature(user, repo) {
    const key = cacheKeyFor(user, repo)
    const cached = await cacheGet(key)
    if (cached) {
      log('cache hit', key)
      return { data: cached.data, fromCache: true, error: null }
    }

    const settings = await getSettings()
    const apiBase = (settings.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
    const params = new URLSearchParams({ user })
    if (repo) params.set('repo', repo)
    const url = `${apiBase}/api/creature?${params.toString()}`

    await incrementNetworkCallCount()
    log('fetch', url)
    const result = await requestFetch(url)
    if (!result.ok) {
      return { data: null, fromCache: false, error: result.error || 'unknown error' }
    }
    await cacheSet(key, result.data)
    return { data: result.data, fromCache: false, error: null }
  }

  /**
   * Runs `getCreature` for a list of `{ user, repo }` requests with bounded
   * concurrency, so a cold cache on a 30-repo page still fires a handful of
   * requests at a time rather than 30 at once. Cache hits resolve
   * immediately and do not consume a concurrency slot's network call.
   */
  async function getCreaturesBatched(requests) {
    const bounded = requests.slice(0, MAX_REPOS_PER_PASS)
    const results = new Array(bounded.length)
    let cursor = 0

    async function worker() {
      while (cursor < bounded.length) {
        const i = cursor++
        const { user, repo } = bounded[i]
        results[i] = await getCreature(user, repo)
      }
    }

    const workers = []
    for (let i = 0; i < FETCH_CONCURRENCY; i++) workers.push(worker())
    await Promise.all(workers)
    return results
  }

  // -------------------------------------------------------------------------
  // Theme + motion
  // -------------------------------------------------------------------------

  /**
   * GitHub sets `data-color-mode` on <html> to 'light' | 'dark' | 'auto'.
   * When 'auto' (or absent), fall back to prefers-color-scheme rather than
   * guessing a fixed default.
   */
  function getGithubTheme() {
    try {
      const mode = document.documentElement.getAttribute('data-color-mode')
      if (mode === 'light' || mode === 'dark') return mode
      const prefersDark =
        global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches
      return prefersDark ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  }

  function prefersReducedMotion() {
    try {
      return Boolean(
        global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
    } catch {
      return false
    }
  }

  global.GardenCreatures = {
    DEFAULT_API_BASE,
    CACHE_TTL_MS,
    SPECIES_LINES,
    DEFAULT_SPECIES_LINE_ID,
    getSpeciesLine,
    assignSpeciesLine,
    spriteUrl,
    resolveVariant,
    getSettings,
    setSettings,
    getCreature,
    getCreaturesBatched,
    getNetworkCallCount,
    getGithubTheme,
    prefersReducedMotion,
    log,
  }
})(typeof window !== 'undefined' ? window : globalThis)
