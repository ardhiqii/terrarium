import { describe, it, expect } from 'vitest'
import { resolveStage } from './stages'
import { STAGES } from './types'

const [SPORELING, MOSSLING, BRACKEN, HEARTWOOD] = STAGES

describe('resolveStage', () => {
  it('resolves 0 XP to Sporeling', () => {
    const result = resolveStage(0)
    expect(result.stage.id).toBe('sporeling')
    expect(result.stage).toBe(SPORELING)
  })

  it('resolves each exact threshold to the stage that begins there', () => {
    expect(resolveStage(MOSSLING.threshold).stage.id).toBe('mossling')
    expect(resolveStage(BRACKEN.threshold).stage.id).toBe('bracken')
    expect(resolveStage(HEARTWOOD.threshold).stage.id).toBe('heartwood')
  })

  it('stays in the lower stage one XP below each threshold', () => {
    expect(resolveStage(MOSSLING.threshold - 1).stage.id).toBe('sporeling')
    expect(resolveStage(BRACKEN.threshold - 1).stage.id).toBe('mossling')
    expect(resolveStage(HEARTWOOD.threshold - 1).stage.id).toBe('bracken')
  })

  it('has nextStage null, xpForNextStage null, and progress exactly 1 at max stage', () => {
    const atThreshold = resolveStage(HEARTWOOD.threshold)
    expect(atThreshold.stage.id).toBe('heartwood')
    expect(atThreshold.nextStage).toBeNull()
    expect(atThreshold.xpForNextStage).toBeNull()
    expect(atThreshold.progress).toBe(1)

    const wellBeyond = resolveStage(HEARTWOOD.threshold + 1_000_000)
    expect(wellBeyond.nextStage).toBeNull()
    expect(wellBeyond.xpForNextStage).toBeNull()
    expect(wellBeyond.progress).toBe(1)
  })

  it('keeps progress between 0 and 1 inclusive across a range of inputs', () => {
    const samples = [
      0,
      1,
      MOSSLING.threshold - 1,
      MOSSLING.threshold,
      MOSSLING.threshold + 1,
      (MOSSLING.threshold + BRACKEN.threshold) / 2,
      BRACKEN.threshold - 1,
      BRACKEN.threshold,
      HEARTWOOD.threshold - 1,
      HEARTWOOD.threshold,
      HEARTWOOD.threshold + 1,
      HEARTWOOD.threshold * 10,
      -500,
    ]
    for (const xp of samples) {
      const { progress } = resolveStage(xp)
      expect(progress).toBeGreaterThanOrEqual(0)
      expect(progress).toBeLessThanOrEqual(1)
    }
  })

  it('does not crash on negative XP and clamps it to the base stage', () => {
    const result = resolveStage(-100)
    expect(result.stage.id).toBe('sporeling')
    expect(result.xpIntoStage).toBe(0)
    expect(result.progress).toBe(0)
  })

  it('does not crash on non-finite XP', () => {
    expect(() => resolveStage(NaN)).not.toThrow()
    expect(() => resolveStage(Infinity)).not.toThrow()
    expect(resolveStage(NaN).stage.id).toBe('sporeling')
  })

  it('reports mid-stage progress proportionally', () => {
    const halfway = MOSSLING.threshold + (BRACKEN.threshold - MOSSLING.threshold) / 2
    const result = resolveStage(halfway)
    expect(result.stage.id).toBe('mossling')
    expect(result.nextStage?.id).toBe('bracken')
    expect(result.progress).toBeCloseTo(0.5)
  })
})
