import { describe, it, expect } from 'vitest'
import './walker.js'

const W = globalThis.TerrariumWalker

/** A deterministic random source cycling through the given values. */
function seq(...values) {
  let i = 0
  return () => values[i++ % values.length]
}

describe('TerrariumWalker.step', () => {
  it('walks in its direction at SPEED px/s', () => {
    const s = W.step({ x: 100, dir: 1, mode: 'walk', modeLeftMs: 5000 }, 100, 1000, 96, seq(0))
    expect(s.x).toBeCloseTo(100 + W.SPEED * 0.1)
    expect(s.dir).toBe(1)
  })

  it('turns around at the right edge and stays inside the strip', () => {
    const s = W.step({ x: 903, dir: 1, mode: 'walk', modeLeftMs: 5000 }, 200, 1000, 96, seq(0))
    expect(s.x).toBe(904)
    expect(s.dir).toBe(-1)
  })

  it('turns around at the left edge', () => {
    const s = W.step({ x: 1, dir: -1, mode: 'walk', modeLeftMs: 5000 }, 200, 1000, 96, seq(0))
    expect(s.x).toBe(0)
    expect(s.dir).toBe(1)
  })

  it('does not move while sitting or sleeping', () => {
    for (const mode of ['sit', 'sleep']) {
      const s = W.step({ x: 300, dir: 1, mode, modeLeftMs: 5000 }, 200, 1000, 96, seq(0))
      expect(s.x).toBe(300)
      expect(s.mode).toBe(mode)
    }
  })

  it('picks the next mode when the current one runs out', () => {
    // roll 0.95 -> sleep, then the duration roll
    const s = W.step({ x: 300, dir: 1, mode: 'sit', modeLeftMs: 50 }, 100, 1000, 96, seq(0.95, 0))
    expect(s.mode).toBe('sleep')
    expect(s.modeLeftMs).toBe(W.DURATIONS.sleep[0])
  })

  it('caps a long frame, so waking from sleep does not teleport it', () => {
    const s = W.step({ x: 100, dir: 1, mode: 'walk', modeLeftMs: 60000 }, 60000, 5000, 96, seq(0))
    expect(s.x).toBeCloseTo(100 + (W.SPEED * W.MAX_DT_MS) / 1000)
  })

  it('survives a strip narrower than the sprite, NaN and junk state', () => {
    const s = W.step({ x: NaN, dir: 7, mode: 'fly', modeLeftMs: NaN }, NaN, 50, 96, seq(0))
    expect(s.x).toBe(0)
    expect([1, -1]).toContain(s.dir)
    expect(['walk', 'sit', 'sleep']).toContain(s.mode)
    expect(Number.isFinite(s.modeLeftMs)).toBe(true)
  })

  it('stays seated in place when still (reduced motion)', () => {
    const s = W.step({ x: 300, dir: 1, mode: 'walk', modeLeftMs: 5000 }, 200, 1000, 96, seq(0), true)
    expect(s.x).toBe(300)
    expect(s.mode).toBe('sit')
  })
})

describe('TerrariumWalker.initial', () => {
  it('starts inside the strip, walking', () => {
    const s = W.initial(1000, 96, seq(0.999))
    expect(s.x).toBeGreaterThanOrEqual(0)
    expect(s.x).toBeLessThanOrEqual(904)
    expect(s.mode).toBe('walk')
  })
})

describe('TerrariumWalker.stillSpriteUrl', () => {
  const gif = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/25.gif'

  it('maps an automatic companion GIF to the still PNG', () => {
    const still = W.stillSpriteUrl({ dressed: false, spriteUrl: gif, stillUrl: gif })
    expect(still).toBe('https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png')
    expect(still).not.toContain('/animated/')
  })

  it("keeps a dressed companion's own still URL", () => {
    const png = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png'
    expect(W.stillSpriteUrl({ dressed: true, spriteUrl: gif, stillUrl: png })).toBe(png)
  })

  it('passes through anything it does not recognise, and null', () => {
    expect(W.stillSpriteUrl({ dressed: false, spriteUrl: 'x.png', stillUrl: 'x.png' })).toBe('x.png')
    expect(W.stillSpriteUrl(null)).toBe(null)
  })
})

describe('TerrariumWalker.contains', () => {
  const rect = { left: 10, right: 20, top: 5, bottom: 15 }
  it('hits inside and on the edge, misses outside and on null', () => {
    expect(W.contains(rect, 15, 10)).toBe(true)
    expect(W.contains(rect, 10, 5)).toBe(true)
    expect(W.contains(rect, 21, 10)).toBe(false)
    expect(W.contains(null, 15, 10)).toBe(false)
  })
})
