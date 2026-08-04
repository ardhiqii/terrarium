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

  /**
   * Styled to sit inside GitHub rather than on top of it.
   *
   * The colours come from GitHub's own Primer custom properties, with the
   * older Primer names and then a literal as fallbacks. This works despite
   * `all: initial` on the host because the `all` shorthand resets every
   * property EXCEPT direction, unicode-bidi, and custom properties, so the
   * page's variables still inherit into this shadow tree. The payoff is that
   * the badge tracks GitHub's light, dark, dimmed, and high-contrast themes
   * for free, instead of guessing with two hardcoded palettes.
   *
   * Sizing deliberately mirrors GitHub's own Label component (12px text,
   * 2em radius, ~20px box) so it reads as a sibling of the "Public" pill it
   * sits next to, not as a foreign object.
   */
  const BADGE_CSS = `
    :host {
      all: initial;
      /* The host must not be a block, or it would break the line box of the
         heading it is appended to and push the row taller. */
      display: inline-flex;
      vertical-align: middle;
    }
    .${CLASS_PREFIX}badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-left: 6px;
      padding: 0 7px 0 3px;
      height: 20px;
      box-sizing: border-box;
      border-radius: 2em;
      border: 1px solid var(--borderColor-default, var(--color-border-default, rgba(140,140,150,0.35)));
      background: var(--bgColor-muted, var(--color-canvas-subtle, rgba(140,140,150,0.08)));
      font-family: ui-monospace, "Geist Mono", SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      line-height: 18px;
      vertical-align: middle;
      white-space: nowrap;
      color: var(--fgColor-muted, var(--color-fg-muted, #656d76));
    }
    .${CLASS_PREFIX}sprite {
      /* Fixed box, always. The sprite loads asynchronously, so without
         reserved space every badge would resize when its GIF arrives and
         nudge the row. This is the layout-shift guard. */
      width: 16px;
      height: 16px;
      image-rendering: pixelated;
      display: block;
      flex: 0 0 auto;
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
   * The only regions we are willing to touch.
   *
   * Within a region, a repo row is still identified by URL shape rather than
   * class names: any link whose href is exactly `/<user>/<repo>`, one segment
   * past the profile. That part is unchanged and is deliberately resilient,
   * since a redesign of the row markup does not break it.
   *
   * The container list is the new part.
   *
   * This used to scan the whole document, which was the bug behind badges
   * appearing in the contribution activity feed: every `/<user>/<repo>` link
   * on the page qualified, including the ones inside "Created 7 commits in 3
   * repositories". Those live in a narrative list where a badge has no row to
   * belong to, so it floated in whitespace.
   *
   * Scoping to the two containers that actually hold repo rows fixes that by
   * construction rather than by blacklisting the feed, which would need
   * updating every time GitHub adds another place a repo link can appear.
   * If none of these exist, we inject nothing, per this file's standing rule.
   */
  const LIST_CONTAINER_SELECTORS = [
    '#user-repositories-list', // /<user>?tab=repositories
    '.js-pinned-items-reorder-list', // pinned grid on the profile overview
    '[data-testid="pinned-items"]', // newer pinned markup
  ]

  function findListContainers() {
    const containers = []
    for (const selector of LIST_CONTAINER_SELECTORS) {
      try {
        containers.push(...document.querySelectorAll(selector))
      } catch {
        // A selector this browser cannot parse must not kill the others.
      }
    }
    return containers
  }

  function findRepoAnchors(user) {
    const containers = findListContainers()
    if (containers.length === 0) return []
    // Each anchor is kept with the container it came from, because the
    // ancestor climb in findBadgeTarget needs a hard stop and the container
    // is the natural one.
    const anchors = []
    for (const container of containers) {
      for (const el of container.querySelectorAll('a[href]')) {
        anchors.push({ el, container })
      }
    }
    const seen = new Set()
    const found = []
    const prefix = `/${user}/`
    for (const { el: a, container } of anchors) {
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
      found.push({ repo, anchor: a, container })
    }
    return found
  }

  /**
   * Where the badge goes, and this is the fix for the layout shift.
   *
   * The previous version attached to `anchor.closest('li')` and appended.
   * On a repo row that `li` is the whole flex/grid container holding the
   * name, description, topic tags, language, star button and activity graph,
   * so appending added a NEW grid item at the end of the row: the badge
   * landed way out beside the Star button, and the row reflowed to make room
   * for it. On the pinned grid the same append put it outside the card.
   *
   * The badge belongs beside the repo NAME, in the same inline run as the
   * "Public" pill. So:
   *
   *   - If the name sits in a heading (the repo list uses one), append to the
   *     heading. That lands after the visibility pill, reading
   *     "notenext Public [Sporeling L1]", and cannot introduce a new grid or
   *     flex item into the row, because the heading is a single item already.
   *   - Otherwise (pinned cards, which have no heading) insert directly after
   *     the anchor, so it joins the same inline flow as the name.
   *
   * Either way the badge is inline content inside an existing box, which is
   * why it no longer moves anything around it.
   */
  /**
   * Climbs to the widest ancestor that is still a single line of text.
   *
   * This is what makes pinned cards work. There the repo name link lives in a
   * span shrink-wrapped to the name itself (measured: 64px), so inserting a
   * ~90px badge beside it immediately wraps and grows the card. Its parent
   * name row is the full card width (measured: 399px) holding only an icon,
   * the name, and the "Public" pill, so there is ample room there.
   *
   * Height is the test rather than a class name: an ancestor that is still
   * roughly one line tall is still an inline row, and the first ancestor that
   * is meaningfully taller is the block that stacks the name over the
   * description. Stopping just before that is exactly the boundary we want,
   * and it does not depend on GitHub's utility classes surviving a redesign.
   */
  function widestSingleLineAncestor(anchor, container) {
    let best = null
    let node = anchor
    const lineHeight = anchor.getBoundingClientRect().height
    if (!lineHeight) return null

    while (node && node.parentElement && node.parentElement !== container) {
      const parent = node.parentElement
      const rect = parent.getBoundingClientRect()
      // A few px of slack: padding and the pill's own border make the row
      // marginally taller than the text it contains.
      if (rect.height > lineHeight + 6) break
      best = parent
      node = parent
    }
    return best
  }

  function findBadgeTarget(anchor, container) {
    // Repo list rows put the name in a heading. Appending there lands the
    // badge after the visibility pill and cannot add a new flex or grid item
    // to the row, because the heading is already one item.
    const heading = anchor.closest('h1, h2, h3, h4')
    if (heading) return { element: heading, position: 'append' }

    try {
      const line = widestSingleLineAncestor(anchor, container)
      if (line) return { element: line, position: 'append' }
    } catch {
      // Measurement can fail on a detached or display:none node. Fall through.
    }

    return { element: anchor, position: 'after' }
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

  function injectBadge(anchor, container, state, reducedMotion, theme) {
    if (!anchor) return
    // Dedup on the anchor rather than the row. The scan re-runs on every DOM
    // mutation and GitHub mutates constantly, so without this a row would
    // collect a fresh badge every few hundred milliseconds.
    if (anchor.hasAttribute(MARK_ATTR)) return

    const target = findBadgeTarget(anchor, container)
    if (!target.element) return

    const badge = buildBadge(state, reducedMotion, theme)
    if (target.position === 'append') {
      target.element.appendChild(badge)
    } else {
      target.element.insertAdjacentElement('afterend', badge)
    }
    anchor.setAttribute(MARK_ATTR, '1')
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
      try {
        injectBadge(matches[i].anchor, matches[i].container, result.data, reducedMotion, theme)
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
