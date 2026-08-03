/**
 * Content script: finds repo rows in a GitHub repo list or pinned-repos
 * grid and injects a small creature badge next to each one.
 *
 * The one rule that matters more than any other here: NEVER throw into the
 * host page, and inject NOTHING if the page doesn't look like what we
 * expect. GitHub's DOM changes without notice; a selector miss must be
 * silent, not an error banner or a broken layout. Every entry point below
 * is wrapped so a failure anywhere just means "no creature," never a
 * console error visible to the page or a layout break.
 */
;(function () {
  'use strict'

  const GC = window.GardenCreatures
  if (!GC) return // core.js failed to load; do nothing.

  const CLASS_PREFIX = 'gcx-' // namespaced, kept out of GitHub's own classes
  const MARK_ATTR = 'data-gcx-injected'
  const NAV_DEBOUNCE_MS = 400
  const SCAN_DEBOUNCE_MS = 300

  let sharedSheet = null
  function getSheet() {
    if (sharedSheet) return sharedSheet
    try {
      sharedSheet = new CSSStyleSheet()
      sharedSheet.replaceSync(BADGE_CSS)
    } catch {
      sharedSheet = null // constructable stylesheets unsupported; fall back per-root
    }
    return sharedSheet
  }

  const BADGE_CSS = `
    :host { all: initial; }
    .${CLASS_PREFIX}badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 8px;
      padding: 1px 6px 1px 2px;
      border-radius: 999px;
      border: 1px solid rgba(140,140,150,0.35);
      background: rgba(140,140,150,0.08);
      font-family: ui-monospace, "Geist Mono", SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      line-height: 18px;
      vertical-align: middle;
      white-space: nowrap;
      color: var(--gcx-fg, #24292f);
    }
    .${CLASS_PREFIX}badge.gcx-dark { color: #c9d1d9; }
    .${CLASS_PREFIX}sprite {
      width: 18px;
      height: 18px;
      image-rendering: pixelated;
      display: block;
      flex: 0 0 auto;
    }
    .${CLASS_PREFIX}stage {
      opacity: 0.85;
    }
    .${CLASS_PREFIX}variant {
      /* Same accent lock as DESIGN.md 2.1 (--accent). No glow, no sprite
         change: this text colour is the entire treatment, mirroring
         SpecimenPlate.tsx on the site itself. */
      color: #2f4bd4;
    }
    .${CLASS_PREFIX}badge.gcx-dark .${CLASS_PREFIX}variant {
      color: #8298ff;
    }
  `

  // ---------------------------------------------------------------------
  // Page recognition
  // ---------------------------------------------------------------------

  /**
   * Returns the profile handle this page is about, or null when the current
   * page is not a repo list / profile page we handle. Deliberately narrow:
   * we only act on `/<user>` (profile, pinned repos) and
   * `/<user>?tab=repositories` (repo list).
   */
  function detectProfileUser() {
    try {
      const path = location.pathname.replace(/\/+$/, '')
      const segments = path.split('/').filter(Boolean)
      if (segments.length !== 1) return null
      const user = segments[0]
      const RESERVED = new Set([
        'orgs', 'settings', 'notifications', 'issues', 'pulls', 'marketplace',
        'explore', 'topics', 'sponsors', 'apps', 'about', 'pricing', 'features',
        'login', 'join', 'search', 'new', 'codespaces', 'dashboard',
      ])
      if (RESERVED.has(user.toLowerCase())) return null
      if (!/^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/.test(user)) return null
      return user
    } catch {
      return null
    }
  }

  /**
   * Finds repo-row anchors without depending on GitHub's current class
   * names. A repo row anchor is any link whose href is exactly
   * `/<user>/<repo>` (one path segment past the profile), which is stable
   * regardless of how GitHub wraps it in markup this month. This is
   * deliberately more resilient than hardcoded selectors: a full redesign
   * of the row markup does not break this, only a change to the URL shape
   * would, and that would break GitHub navigation generally.
   */
  function findRepoAnchors(user) {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    const seen = new Set()
    const found = []
    const prefix = `/${user}/`
    for (const a of anchors) {
      let href
      try {
        href = new URL(a.getAttribute('href'), location.origin)
      } catch {
        continue
      }
      if (href.origin !== location.origin) continue
      const path = href.pathname
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length).replace(/\/+$/, '')
      if (!rest || rest.includes('/')) continue
      const repo = rest
      if (seen.has(repo)) continue
      seen.add(repo)
      found.push({ repo, anchor: a })
    }
    return found
  }

  /** Picks a stable row/card element to attach the badge to. */
  function findRowFor(anchor) {
    return (
      anchor.closest('li') ||
      anchor.closest('[data-testid]') ||
      anchor.parentElement
    )
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function stageAbbrev(state) {
    if (!state || !state.stage) return '?'
    return `${state.stage.name} L${state.stage.index}`
  }

  /**
   * The variant suffix alone (e.g. "var. woven"), or '' when the creature
   * behind `state` doesn't qualify for one. Kept separate from
   * `stageAbbrev` so `buildBadge` can render it in its own accent-coloured
   * span, the same no-glow, no-sprite-change treatment `SpecimenPlate.tsx`
   * uses on the site itself. `state` is the raw `/api/creature` JSON body,
   * which carries `stats` and `github` verbatim from the `CreatureState` it
   * wraps, so this costs no extra fetch beyond what the badge already has.
   */
  function variantSuffix(state) {
    if (!state) return ''
    const variant = GC.resolveVariant(state.stats, state.github)
    return variant ? `var. ${variant}` : ''
  }

  /**
   * Draws the first frame of an animated GIF to a canvas and returns it,
   * so reduced-motion users still see the creature but it does not move.
   * Falls back to the original <img> if canvas drawing fails for any
   * reason (e.g. a CORS-tainted canvas), since a moving sprite is still
   * better than nothing when the freeze trick can't apply.
   */
  function freezeToCanvas(img) {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || 32
      canvas.height = img.naturalHeight || 32
      canvas.className = `${CLASS_PREFIX}sprite`
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(img, 0, 0)
      return canvas
    } catch {
      return null
    }
  }

  function buildBadge(state, reducedMotion, theme) {
    const host = document.createElement('span')
    host.className = `${CLASS_PREFIX}host`
    host.setAttribute(MARK_ATTR, '1')
    const root = host.attachShadow({ mode: 'open' })

    const sheet = getSheet()
    if (sheet) {
      root.adoptedStyleSheets = [sheet]
    } else {
      const style = document.createElement('style')
      style.textContent = BADGE_CSS
      root.appendChild(style)
    }

    const badge = document.createElement('span')
    badge.className = `${CLASS_PREFIX}badge${theme === 'dark' ? ' gcx-dark' : ''}`

    // `speciesLineId` rides along on the same `/api/creature` response this
    // badge's data already came from (see repo-creature route.ts, T19), so
    // reading it here costs zero extra network calls: no per-repo GitHub
    // lookup, no extra fetch, just a field on data GC.getCreature already
    // has. Falls back to the default line for older cached responses that
    // predate this field.
    const url = GC.spriteUrl(state.stage && state.stage.id, state.speciesLineId)
    if (url) {
      const img = new Image()
      img.className = `${CLASS_PREFIX}sprite`
      img.alt = ''
      img.decoding = 'async'
      img.loading = 'lazy'
      img.src = url
      if (reducedMotion) {
        img.addEventListener('load', () => {
          const frozen = freezeToCanvas(img)
          if (frozen) img.replaceWith(frozen)
        })
      }
      badge.appendChild(img)
    }

    const label = document.createElement('span')
    label.className = `${CLASS_PREFIX}stage`
    label.textContent = stageAbbrev(state)
    badge.appendChild(label)

    const suffix = variantSuffix(state)
    if (suffix) {
      const variantLabel = document.createElement('span')
      variantLabel.className = `${CLASS_PREFIX}variant`
      variantLabel.textContent = ` · ${suffix}`
      badge.appendChild(variantLabel)
    }

    root.appendChild(badge)
    return host
  }

  function injectBadge(row, state, reducedMotion, theme) {
    if (!row || row.hasAttribute(MARK_ATTR) || row.querySelector(`[${MARK_ATTR}]`)) return
    const badge = buildBadge(state, reducedMotion, theme)
    row.appendChild(badge)
    row.setAttribute(MARK_ATTR, '1')
  }

  // ---------------------------------------------------------------------
  // Main pass
  // ---------------------------------------------------------------------

  let passInFlight = false

  async function runPass() {
    if (passInFlight) return
    passInFlight = true
    try {
      await runPassInner()
    } catch (err) {
      GC.log('pass failed silently', err)
    } finally {
      passInFlight = false
    }
  }

  async function runPassInner() {
    const user = detectProfileUser()
    if (!user) return

    const matches = findRepoAnchors(user)
    if (matches.length === 0) return // selectors/shape didn't match: inject nothing

    const reducedMotion = GC.prefersReducedMotion()
    const theme = GC.getGithubTheme()

    const requests = matches.map((m) => ({ user, repo: m.repo }))
    const results = await GC.getCreaturesBatched(requests)

    for (let i = 0; i < matches.length; i++) {
      const result = results[i]
      if (!result || !result.data || result.error) continue
      const row = findRowFor(matches[i].anchor)
      try {
        injectBadge(row, result.data, reducedMotion, theme)
      } catch (err) {
        // A single row failing must never stop the rest or reach the page.
        GC.log('row injection failed', err)
      }
    }
  }

  // ---------------------------------------------------------------------
  // Debounced triggers: initial load, DOM mutation, and SPA-style
  // navigation (GitHub swaps content without full reloads).
  // ---------------------------------------------------------------------

  let scanTimer = null
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      scanTimer = null
      runPass()
    }, SCAN_DEBOUNCE_MS)
  }

  let lastUrl = location.href
  let navTimer = null
  function checkNavigation() {
    if (location.href === lastUrl) return
    lastUrl = location.href
    if (navTimer) clearTimeout(navTimer)
    navTimer = setTimeout(() => {
      navTimer = null
      scheduleScan()
    }, NAV_DEBOUNCE_MS)
  }

  function start() {
    scheduleScan()

    try {
      const observer = new MutationObserver(() => {
        checkNavigation()
        scheduleScan()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    } catch {
      // MutationObserver unavailable or body not ready; the initial scan
      // (and the poll below) still cover most navigation.
    }

    // Poll as a fallback for SPA navigation that doesn't trigger a
    // childList mutation we happen to observe (e.g. history.pushState with
    // no visible DOM change yet). Cheap: a string comparison every second.
    setInterval(checkNavigation, 1000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
