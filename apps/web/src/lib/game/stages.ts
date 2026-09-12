/**
 * Resolves a total XP number to a position on the evolution line.
 */

import { STAGES, Stage } from './types'

/**
 * The label for a stage's progression slot. Stages 1-3 are real evolutions;
 * the heartwood stage is a mastery/form slot (Mega), per PRODUCT.md §7 — a
 * final mastery milestone must be labelled as mastery/form, not an evolution.
 */
export function slotLabel(stage: { slot: Stage['slot'] }): string {
  return stage.slot === 'mastery' ? 'Mastery' : 'Evolution'
}

export interface ResolvedStage {
  stage: Stage
  nextStage: Stage | null
  xpIntoStage: number
  xpForNextStage: number | null
  progress: number
}

export function resolveStage(totalXp: number): ResolvedStage {
  const xp = Number.isFinite(totalXp) ? Math.max(0, totalXp) : 0

  // STAGES is ordered by threshold ascending; walk forward and keep the
  // last stage whose threshold has been reached.
  let current = STAGES[0]
  let currentIndex = 0
  for (let i = 0; i < STAGES.length; i++) {
    if (xp >= STAGES[i].threshold) {
      current = STAGES[i]
      currentIndex = i
    } else {
      break
    }
  }

  const next = STAGES[currentIndex + 1] ?? null
  const xpIntoStage = xp - current.threshold

  if (!next) {
    return {
      stage: current,
      nextStage: null,
      xpIntoStage,
      xpForNextStage: null,
      progress: 1,
    }
  }

  const xpForNextStage = next.threshold - current.threshold
  const progress =
    xpForNextStage > 0
      ? Math.min(1, Math.max(0, xpIntoStage / xpForNextStage))
      : 1

  return {
    stage: current,
    nextStage: next,
    xpIntoStage,
    xpForNextStage,
    progress,
  }
}
