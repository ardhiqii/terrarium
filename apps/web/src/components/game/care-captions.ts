import type { CareNeeds, CareScene } from '@/lib/game/care'

/**
 * Captions under the House's condition meters (`DESIGN.md` §7, rule R6).
 *
 * Pure, so it is testable without rendering the client-only House. A caption
 * appears only when a need wants attention and says what would help; a full or
 * unmeasured need gets none, because its value label already says it all.
 */

/** Below this, a need is low enough to say what would help. */
const LOW_NEED = 50

/**
 * Each meter, with a caption only when the need wants attention (`null` when
 * it is full, or not measured: the value label already says "not measured").
 */
export function meterCaptions(
  needs: CareNeeds,
  scene: CareScene,
): { label: string; value: number | null; caption: string | null }[] {
  const daysHungry = Math.round((100 - (needs.hunger ?? 100)) / 25)
  return [
    {
      label: 'Hunger',
      value: needs.hunger,
      caption:
        needs.hunger === null || needs.hunger >= 100
          ? null
          : needs.hunger === 0
            ? 'Has not eaten in days. Work today to feed it.'
            : `${daysHungry} ${daysHungry === 1 ? 'day' : 'days'} since the last meal`,
    },
    {
      label: 'Energy',
      value: needs.energy,
      caption:
        scene.mood === 'resting'
          ? 'Recovering from a rest'
          : needs.energy !== null && needs.energy < LOW_NEED
            ? 'Tired. Let it rest.'
            : null,
    },
    {
      label: 'Health',
      value: needs.health,
      caption:
        needs.health !== null && needs.health < 100
          ? 'Default branch is red. Medicine restores it.'
          : null,
    },
    {
      label: 'Cleanliness',
      value: needs.cleanliness,
      caption:
        needs.cleanliness !== null && needs.cleanliness < 100
          ? 'Your own pull requests are sitting open'
          : null,
    },
    {
      label: 'Diet',
      value: needs.diet,
      caption:
        needs.diet !== null && needs.diet < LOW_NEED
          ? 'Try a different kind of work this week'
          : null,
    },
  ]
}
