/**
 * Mood: the one thing a renderer shows without being asked.
 *
 * WHY MOOD IS DERIVED AND NOT STORED: it is a reading of needs plus what just
 * happened. Storing it would let a synced device show a stale face, and every
 * write to it would be a chance for the two to disagree. `needs` already
 * changes on its own; mood is a pure projection of it.
 *
 * PRIORITY ORDER IS THE DESIGN. A companion can be tired, hungry and unwell at
 * once, and only one face fits on the sprite. The order below puts the things
 * the user can act on first: sickness, then hunger, then tiredness, then the
 * happy states. A "happy" companion with a red build would be the panel
 * congratulating the user while something is wrong.
 */

import type { CareNeeds, CareMood } from './scene'
import { FUTURE_TOLERANCE_MS, parseTimestamp } from './needs'

/**
 * How long a mood-triggering event keeps the face it caused.
 *
 * One hour for rewards: long enough that a user who fed the companion and then
 * looked away still sees the reaction, short enough that it is not the face
 * they see all day. Focus and curiosity use longer windows because work and
 * writing are slower signals than a meal.
 */
export const REWARD_MOOD_MS = 60 * 60 * 1000
export const RESTING_MOOD_MS = 2 * 60 * 60 * 1000
export const FOCUSED_MOOD_MS = 2 * 60 * 60 * 1000
export const CURIOUS_MOOD_MS = 6 * 60 * 60 * 1000

export interface MoodInput {
  readonly needs: CareNeeds
  readonly dormant: boolean
  readonly now: Date
  readonly lastRewardAt?: string | null
  readonly lastRestedAt?: string | null
  readonly lastWorkSessionAt?: string | null
  readonly lastNoteAt?: string | null
}

function within(nowMs: number, timestamp: string | null | undefined, windowMs: number): boolean {
  const ms = parseTimestamp(timestamp ?? null)
  if (ms === null) return false
  const age = nowMs - ms
  // A future timestamp more than a few minutes ahead is a broken clock, not a
  // reaction that just happened. Without this upper bound one device set a year
  // ahead makes the companion "excited" on every device it syncs to.
  if (age < -FUTURE_TOLERANCE_MS) return false
  return age <= windowMs
}

/**
 * The companion's mood right now.
 *
 * `dormant` returns `resting` rather than a mood of its own: the scene carries
 * dormancy as a separate flag so a renderer can draw the greyed sprite, and
 * overloading the mood would give two renderers two ways to say the same thing.
 */
export function deriveMood(input: MoodInput): CareMood {
  const nowMs = input.now.getTime()
  const { needs } = input

  if (input.dormant) return 'resting'
  if (needs.health !== null && needs.health < 50) return 'unwell'
  if (needs.hunger !== null && needs.hunger < 30) return 'hungry'
  if (needs.energy !== null && needs.energy < 30) return 'sleepy'
  if (within(nowMs, input.lastRewardAt, REWARD_MOOD_MS)) return 'excited'
  if (within(nowMs, input.lastRestedAt, RESTING_MOOD_MS)) return 'resting'
  if (needs.energy !== null && needs.energy < 45) return 'resting'
  if (within(nowMs, input.lastWorkSessionAt, FOCUSED_MOOD_MS)) return 'focused'
  if (within(nowMs, input.lastNoteAt, CURIOUS_MOOD_MS)) return 'curious'
  return 'idle'
}
