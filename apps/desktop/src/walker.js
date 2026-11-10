/**
 * The taskbar companion's movement: walk, sit, sleep. Pure, no DOM, no Tauri.
 *
 * Loaded as a classic script in the desktop webview (attaches
 * `window.TerrariumWalker`) and imported by Vitest in Node (attaches to
 * `globalThis`), the same pattern as `apps/extension/common/core.js`.
 *
 * `step` is a pure function of the previous state, the elapsed time and a
 * random source, so tests drive it with a fixed `rand` instead of timers.
 */
;(function (global) {
  'use strict'

  /** Walking speed, CSS pixels per second. */
  const SPEED = 40
  /** Longest frame the walker will integrate; a sleeping laptop resumes calmly. */
  const MAX_DT_MS = 250

  const MODES = /** @type {const} */ (['walk', 'sit', 'sleep'])

  /** [min, max] duration in ms for each mode. */
  const DURATIONS = {
    walk: [4000, 10000],
    sit: [3000, 8000],
    sleep: [10000, 25000],
  }

  function between(rand, [min, max]) {
    return min + Math.floor(rand() * (max - min))
  }

  function maxX(stripWidth, spriteWidth) {
    const room = Number(stripWidth) - Number(spriteWidth)
    return Number.isFinite(room) && room > 0 ? room : 0
  }

  function clamp(x, lo, hi) {
    if (!Number.isFinite(x)) return lo
    return Math.min(hi, Math.max(lo, x))
  }

  /** A fresh walker somewhere along the strip, walking. */
  function initial(stripWidth, spriteWidth, rand = Math.random) {
    const hi = maxX(stripWidth, spriteWidth)
    return {
      x: Math.floor(rand() * hi),
      dir: rand() < 0.5 ? -1 : 1,
      mode: 'walk',
      modeLeftMs: between(rand, DURATIONS.walk),
    }
  }

  /** Pick what comes after the current mode ends. Mostly walking, sometimes a rest. */
  function nextMode(rand) {
    const roll = rand()
    if (roll < 0.6) return 'walk'
    if (roll < 0.9) return 'sit'
    return 'sleep'
  }

  /**
   * Advance the walker by `dtMs`.
   * `still` (reduced motion, or no sprite yet) keeps it seated in place.
   */
  function step(state, dtMs, stripWidth, spriteWidth, rand = Math.random, still = false) {
    const hi = maxX(stripWidth, spriteWidth)
    const dt = clamp(Number(dtMs), 0, MAX_DT_MS)
    let { x, dir, mode, modeLeftMs } = state
    x = clamp(x, 0, hi)
    dir = dir === -1 ? -1 : 1
    if (!MODES.includes(mode)) mode = 'walk'

    if (still) return { x, dir, mode: 'sit', modeLeftMs: DURATIONS.sit[0] }

    if (mode === 'walk') {
      x += (dir * SPEED * dt) / 1000
      if (x <= 0) {
        x = 0
        dir = 1
      } else if (x >= hi) {
        x = hi
        dir = -1
      }
    }

    modeLeftMs = (Number.isFinite(modeLeftMs) ? modeLeftMs : 0) - dt
    if (modeLeftMs <= 0) {
      mode = nextMode(rand)
      modeLeftMs = between(rand, DURATIONS[mode])
      if (mode === 'walk' && rand() < 0.5) dir = -dir
    }

    return { x, dir, mode, modeLeftMs }
  }

  /** Is the point (CSS px, window-relative) inside the rect? Used for click-through. */
  function contains(rect, px, py) {
    if (!rect) return false
    return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom
  }

  const ANIMATED_SEGMENT = '/versions/generation-v/black-white/animated/'

  /**
   * A still image for reduced motion and sleep. A dressed companion carries its
   * own still PNG; the automatic one's `stillUrl` is the animated GIF, so map it
   * to PokeAPI's still sprite (`.../sprites/pokemon/<id>.png`).
   */
  function stillSpriteUrl(display) {
    if (!display) return null
    const url = display.stillUrl || display.spriteUrl || null
    if (!url || display.dressed) return url
    if (!url.includes(ANIMATED_SEGMENT) || !/\.gif$/.test(url)) return url
    return url.replace(ANIMATED_SEGMENT, '/').replace(/\.gif$/, '.png')
  }

  global.TerrariumWalker = { SPEED, MAX_DT_MS, DURATIONS, initial, step, contains, maxX, stillSpriteUrl }
})(typeof window !== 'undefined' ? window : globalThis)
