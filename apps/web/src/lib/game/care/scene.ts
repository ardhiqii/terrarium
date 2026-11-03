/**
 * The vocabulary shared by every renderer of the living companion.
 *
 * WHY THIS FILE HOLDS NO LOGIC: the web House, a desktop overlay, and any
 * future device all need to agree on what a "pose", a "mood", or a "visible
 * item" means. If each renderer derived those words from needs on its own, two
 * surfaces showing the same companion could disagree about whether it is
 * asleep, and neither would be wrong by its own code. So `scene` is the single
 * contract: `needs.ts`, `mood.ts` and `actions.ts` produce it, and renderers
 * consume it without re-deriving anything.
 *
 * Everything here is a plain type or a pure builder. No React, no DOM, no Node
 * built-ins (see `client-bundle-safety.test.ts`).
 */

/** The five condition values. `null` means "not measured", never "zero". */
export type CareNeedKey = 'hunger' | 'energy' | 'health' | 'cleanliness' | 'diet'

export type CareNeeds = Readonly<Record<CareNeedKey, number | null>>

/**
 * Every need value, in the order the House shows them.
 *
 * The order is deliberately physical-first: a person reading the panel learns
 * what the creature needs before how varied its week was.
 */
export const CARE_NEED_KEYS: readonly CareNeedKey[] = [
  'hunger',
  'energy',
  'health',
  'cleanliness',
  'diet',
] as const

/**
 * Moods. The first five already existed as dialogue states; `sleepy`,
 * `unwell` and `hungry` are the condition layer's additions.
 */
export type CareMood =
  | 'idle'
  | 'focused'
  | 'curious'
  | 'excited'
  | 'resting'
  | 'sleepy'
  | 'unwell'
  | 'hungry'

export type CarePose = 'stand' | 'sit' | 'sleep' | 'play' | 'sick'

/**
 * The deliberately small action set. Small because every action has to be
 * reachable with three buttons on a future hardware device, and because a
 * companion you can do fifteen things to is a menu, not a pet.
 */
export type CareActionKind = 'feed' | 'play' | 'clean' | 'heal' | 'sleep' | 'pet'

export const CARE_ACTION_KINDS: readonly CareActionKind[] = [
  'feed',
  'play',
  'clean',
  'heal',
  'sleep',
  'pet',
] as const

/** The kinds of item. Earning is separate from caring (see `items.ts`). */
export type CareItemKind = 'food' | 'treat' | 'medicine' | 'toy' | 'soap'

export const CARE_ITEM_KINDS: readonly CareItemKind[] = [
  'food',
  'treat',
  'medicine',
  'toy',
  'soap',
] as const

/**
 * A dialogue key, not a sentence.
 *
 * WHY: the same scene is rendered by the website, a 420 px desktop popover, and
 * eventually a 240 px device. Copy length and tone differ per surface; the
 * decision about what the companion is feeling belongs here, the words belong
 * to the renderer.
 */
export type CareDialogueKey =
  | 'idle'
  | 'greeting'
  | 'focused'
  | 'curious'
  | 'excited'
  | 'resting'
  | 'sleepy'
  | 'unwell'
  | 'hungry'
  | 'dormant'
  | 'welcome-back'

/** Why a care action could not be taken. The UI says which one it was. */
export type CareRefusal =
  | 'dormant'
  | 'no-item'
  | 'not-measured'
  | 'not-needed'

/** Day part, from the viewer's local clock. Drives the window in the House. */
export type DayPart = 'dawn' | 'day' | 'dusk' | 'night'

/**
 * A renderer-ready description of the companion right now.
 *
 * `needs` is included rather than left implicit because the interface rules
 * require a labelled meter for each one, and a renderer that had to import
 * `needs.ts` itself would be a second place for the numbers to be computed.
 */
export interface CareScene {
  readonly companionId: string
  readonly mood: CareMood
  readonly pose: CarePose
  readonly needs: CareNeeds
  readonly inventory: Readonly<Record<CareItemKind, number>>
  /** True when the companion has been neglected long enough to sleep. */
  readonly dormant: boolean
  /** Items with at least one in stock, so the House only draws real objects. */
  readonly visibleItems: readonly CareItemKind[]
  /** Actions that can be taken right now (inventory and need already checked). */
  readonly availableActions: readonly CareActionKind[]
  readonly dialogue: CareDialogueKey
  readonly dayPart: DayPart
}

const POSES: Readonly<Record<CareMood, CarePose>> = {
  // A hungry or unwell companion still stands: lying down reads as "asleep",
  // and a sleeping creature that is actually starving would be a lie the sprite
  // tells. `unwell` is the only pose change, because sickness has its own
  // silhouette in the sprite set.
  idle: 'sit',
  focused: 'stand',
  curious: 'stand',
  excited: 'play',
  resting: 'sleep',
  sleepy: 'sleep',
  unwell: 'sick',
  hungry: 'sit',
}

const DIALOGUE: Readonly<Record<CareMood, CareDialogueKey>> = {
  idle: 'idle',
  focused: 'focused',
  curious: 'curious',
  excited: 'excited',
  resting: 'resting',
  sleepy: 'sleepy',
  unwell: 'unwell',
  hungry: 'hungry',
}

/** The pose a mood takes. Exported so a preview can show one without a full scene. */
export function poseForMood(mood: CareMood): CarePose {
  return POSES[mood] ?? 'sit'
}

/** The local hour (0–23) for a moment, given the viewer's offset east of UTC. */
export function localHour(now: Date, utcOffsetMinutes = 0): number {
  const shifted = new Date(now.getTime() + utcOffsetMinutes * 60_000)
  const hour = shifted.getUTCHours()
  return Number.isFinite(hour) ? hour : 0
}

/**
 * The local day part for a timestamp.
 *
 * `utcOffsetMinutes` is the viewer's offset east of UTC (as
 * `-Date.getTimezoneOffset()`), never the server's: the companion lives where
 * the user is.
 */
export function dayPartFor(now: Date, utcOffsetMinutes = 0): DayPart {
  const hour = localHour(now, utcOffsetMinutes)
  if (hour >= 5 && hour < 8) return 'dawn'
  if (hour >= 8 && hour < 17) return 'day'
  if (hour >= 17 && hour < 20) return 'dusk'
  return 'night'
}

/**
 * Assemble a scene from parts already computed by the care layer.
 *
 * The default dialogue is the mood's own key; `greeting` and `welcome-back` are
 * chosen by the caller because they depend on what happened in the *previous*
 * render (a returning user, an action just completed), which a pure function
 * of the current state cannot see.
 */
export function buildCareScene(input: {
  companionId: string
  mood: CareMood
  needs: CareNeeds
  inventory: Readonly<Record<CareItemKind, number>>
  dormant: boolean
  availableActions: readonly CareActionKind[]
  dialogue?: CareDialogueKey
  now: Date
  utcOffsetMinutes?: number
}): CareScene {
  const visibleItems = CARE_ITEM_KINDS.filter((item) => (input.inventory[item] ?? 0) > 0)
  return {
    companionId: input.companionId,
    mood: input.mood,
    pose: poseForMood(input.mood),
    needs: { ...input.needs },
    inventory: { ...input.inventory },
    dormant: input.dormant,
    visibleItems,
    availableActions: [...input.availableActions],
    dialogue: input.dialogue ?? (input.dormant ? 'dormant' : DIALOGUE[input.mood] ?? 'idle'),
    dayPart: dayPartFor(input.now, input.utcOffsetMinutes ?? 0),
  }
}
