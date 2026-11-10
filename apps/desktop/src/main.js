/**
 * The taskbar companion's webview: fetch the companion, walk it along the
 * strip, keep the window click-through except over the companion itself.
 *
 * Data: `/api/creature?user=&repo=`, the same public payload the README badge
 * and the extension read. `GardenCreatures.creatureDisplay` (shared with the
 * extension) decides between the dressed companion and the automatic one and
 * validates the sprite URL, so the desktop cannot disagree with the badge.
 * The fetch itself runs in Rust (`fetch_creature`) because the webview's origin
 * is not one the API sends CORS headers for.
 */
;(function () {
  'use strict'

  const { invoke } = window.__TAURI__.core
  const { listen } = window.__TAURI__.event
  const { getCurrentWindow, cursorPosition } = window.__TAURI__.window

  const GC = window.GardenCreatures
  const Walker = window.TerrariumWalker
  const appWindow = getCurrentWindow()

  const DEFAULT_API_BASE = 'https://terrarium.rakhawiratama.com'
  const SETTINGS_KEY = 'terrarium.desktop.settings'
  const REFRESH_MS = 10 * 60 * 1000
  const HOVER_POLL_MS = 60
  const BUBBLE_MS = 6000
  const SPRITE_WIDTH = 96

  const els = {
    pet: document.getElementById('pet'),
    sprite: document.getElementById('sprite'),
    bubble: document.getElementById('bubble'),
    zzz: document.getElementById('zzz'),
    form: document.getElementById('settings'),
    user: document.getElementById('user'),
    repo: document.getElementById('repo'),
    apiBase: document.getElementById('apiBase'),
    error: document.getElementById('settings-error'),
    cancel: document.getElementById('cancel'),
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let display = null // result of creatureDisplay
  let creature = null // raw payload, for the bubble
  let walker = Walker.initial(window.innerWidth, SPRITE_WIDTH)
  let lastFrame = performance.now()
  let bubbleTimer = 0
  let refreshTimer = 0

  // ---------------------------------------------------------------------------
  // Settings (per machine, in the webview's own storage)
  // ---------------------------------------------------------------------------

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')
      if (raw && typeof raw.user === 'string' && typeof raw.repo === 'string') {
        return { user: raw.user, repo: raw.repo, apiBase: typeof raw.apiBase === 'string' ? raw.apiBase : DEFAULT_API_BASE }
      }
    } catch {
      // fall through to "not set up"
    }
    return null
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // A failed save only means the form shows again next launch.
    }
  }

  let settings = loadSettings()

  function showSettings() {
    const current = settings || { user: '', repo: '', apiBase: DEFAULT_API_BASE }
    els.user.value = current.user
    els.repo.value = current.repo
    els.apiBase.value = current.apiBase
    els.error.hidden = true
    els.cancel.hidden = settings === null
    els.form.hidden = false
    // The strip is too short for the form; Rust grows it while the form is open.
    invoke('set_form_open', { open: true }).catch(() => {})
    appWindow.setIgnoreCursorEvents(false).catch(() => {})
    appWindow.setFocus().catch(() => {})
    els.user.focus()
  }

  function hideSettings() {
    els.form.hidden = true
    invoke('set_form_open', { open: false }).catch(() => {})
  }

  els.cancel.addEventListener('click', hideSettings)

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const next = {
      user: els.user.value.trim().replace(/^@/, ''),
      repo: els.repo.value.trim(),
      apiBase: els.apiBase.value.trim().replace(/\/+$/, '') || DEFAULT_API_BASE,
    }
    els.error.hidden = true
    let result
    try {
      result = await fetchDisplay(next)
    } catch (error) {
      els.error.textContent = String(error && error.message ? error.message : error)
      els.error.hidden = false
      return
    }
    settings = next
    saveSettings(next)
    apply(result)
    hideSettings()
    // First run never had a refresh loop; a change restarts it from now.
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, REFRESH_MS)
  })

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  /** Fetch the companion for `s` without drawing it. Throws a readable message on failure. */
  async function fetchDisplay(s) {
    const payload = await invoke('fetch_creature', { apiBase: s.apiBase, user: s.user, repo: s.repo })
    if (payload && typeof payload.error === 'string') throw new Error(payload.error)
    const next = GC.creatureDisplay(payload)
    if (!next.spriteUrl) throw new Error('Terrarium answered, but without a companion to show.')
    return { payload, display: next }
  }

  function apply(result) {
    creature = result.payload
    display = result.display
    render()
  }

  async function refresh() {
    clearTimeout(refreshTimer)
    const s = settings
    if (s && els.form.hidden) {
      try {
        const result = await fetchDisplay(s)
        // Settings changed while this was in flight: its answer is for the old
        // companion, so drop it rather than draw it under the new name.
        if (s === settings && els.form.hidden) apply(result)
      } catch {
        // Keep the companion already on screen; try again on the next tick.
      }
    }
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, REFRESH_MS)
  }

  function render() {
    if (!display) {
      els.pet.hidden = true
      return
    }
    const sleeping = walker.mode === 'sleep'
    const src = sleeping || reducedMotion ? Walker.stillSpriteUrl(display) : display.spriteUrl
    if (els.sprite.getAttribute('src') !== src) els.sprite.src = src
    els.sprite.alt = display.title || display.label
    els.pet.hidden = false
  }

  function bubbleText() {
    if (!display) return ''
    const dressed = creature && creature.dressed
    if (display.dressed && dressed) {
      const step = dressed.step || {}
      const xp =
        typeof dressed.xpForNextStep === 'number'
          ? `${dressed.xpIntoStep} / ${dressed.xpForNextStep} XP`
          : 'final stage'
      return (
        `<strong>${escapeHtml(dressed.name)}</strong> · ${escapeHtml(step.name || '')}<br>` +
        `<span class="muted">${escapeHtml(xp)} · ${escapeHtml(settings ? settings.repo : '')}</span>`
      )
    }
    const stage = (creature && creature.stage) || {}
    return `<strong>${escapeHtml(stage.name || display.label)}</strong><br><span class="muted">${escapeHtml(
      settings ? `${settings.repo} · not dressed` : '',
    )}</span>`
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  }

  function showBubble() {
    els.bubble.innerHTML = bubbleText()
    els.bubble.hidden = false
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      els.bubble.hidden = true
    }, BUBBLE_MS)
  }

  els.sprite.addEventListener('click', () => {
    if (els.bubble.hidden) showBubble()
    else els.bubble.hidden = true
  })

  // ---------------------------------------------------------------------------
  // Movement
  // ---------------------------------------------------------------------------

  function frame(now) {
    const dt = now - lastFrame
    lastFrame = now
    const prevMode = walker.mode
    walker = Walker.step(walker, dt, window.innerWidth, SPRITE_WIDTH, Math.random, reducedMotion || !display)
    els.pet.style.transform = `translateX(${Math.round(walker.x)}px)`
    // Gen V sprites face left; mirror them when walking right.
    els.sprite.style.setProperty('--face', walker.dir === 1 ? '-1' : '1')
    els.pet.className = walker.mode
    els.zzz.hidden = walker.mode !== 'sleep'
    if (walker.mode !== prevMode) render()
    requestAnimationFrame(frame)
  }

  // ---------------------------------------------------------------------------
  // Click-through: the window ignores the mouse except over the companion,
  // its bubble, or the settings form.
  // ---------------------------------------------------------------------------

  /** Whether the window currently accepts the mouse; null until the first tick. */
  let interactive = null

  async function hoverTick() {
    try {
      let over = !els.form.hidden
      if (!over) {
        const [cursor, origin, scale] = await Promise.all([
          cursorPosition(),
          appWindow.outerPosition(),
          appWindow.scaleFactor(),
        ])
        const x = (cursor.x - origin.x) / scale
        const y = (cursor.y - origin.y) / scale
        over =
          (!els.pet.hidden && Walker.contains(els.sprite.getBoundingClientRect(), x, y)) ||
          (!els.bubble.hidden && Walker.contains(els.bubble.getBoundingClientRect(), x, y))
      }
      if (over !== interactive) {
        // Record the state only once the call succeeded, so a failed switch
        // back to click-through is retried instead of leaving the strip
        // swallowing clicks on the desktop.
        await appWindow.setIgnoreCursorEvents(!over)
        interactive = over
      }
    } catch {
      // A failed poll leaves the last state; the next tick retries.
    }
    setTimeout(hoverTick, HOVER_POLL_MS)
  }

  // ---------------------------------------------------------------------------
  // Tray events (from Rust)
  // ---------------------------------------------------------------------------

  listen('terrarium://settings', () => showSettings())
  listen('terrarium://open', () => {
    const base = (settings && settings.apiBase) || DEFAULT_API_BASE
    invoke('open_external', { apiBase: base }).catch(() => {})
  })
  listen('terrarium://refresh', () => refresh())

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  requestAnimationFrame(frame)
  hoverTick()
  if (settings) refresh()
  else showSettings()
})()
