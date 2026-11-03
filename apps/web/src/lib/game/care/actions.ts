/**
 * What a care action does, and what it refuses.
 *
 * A PURE STATE TRANSITION: `(care, action, context) → care'` plus a scene. No
 * XP, no ledger write, no storage. The renderer decides when to call it and
 * where to persist the result; keeping the decision out of the renderer is what
 * lets the same six actions serve the website, a desktop overlay, and a future
 * device without three implementations to keep in step.
 *
 * ITEMS ARE THE PRICE, NEEDS ARE THE PRODUCT. Every action either spends an
 * item (feed, play, clean, heal) or costs nothing (sleep, pet). Nothing here
 * grants an item — earning is `items.ts`'s job, and keeping the two apart is
 * what stops "care for the companion" from becoming a way to farm.
 */

import { deriveMood, type MoodInput } from './mood'
import { deriveNeeds, isDormant, needForAction, type CareSignals } from './needs'
import {
  buildCareScene,
  type CareActionKind,
  type CareDialogueKey,
  type CareItemKind,
  type CareNeeds,
  type CareRefusal,
  type CareScene,
} from './scene'
import {
  careAnchors,
  inventoryOf,
  mintCareItems,
  spendItem,
  type CareState,
} from './state'
import type { EventLedger } from '../events'

/** Which item an action consumes, if any. */
export function itemForAction(
  action: CareActionKind,
  inventory: Readonly<Record<CareItemKind, number>>,
): CareItemKind | null {
  switch (action) {
    case 'feed':
      // Food first, a treat only when there is no ordinary meal left. A treat
      // also lifts the mood, so it should be the deliberate choice, not the
      // default the button reaches for while food is sitting in the cupboard.
      if ((inventory.food ?? 0) > 0) return 'food'
      if ((inventory.treat ?? 0) > 0) return 'treat'
      return null
    case 'play':
      return (inventory.toy ?? 0) > 0 ? 'toy' : null
    case 'clean':
      return (inventory.soap ?? 0) > 0 ? 'soap' : null
    case 'heal':
      return (inventory.medicine ?? 0) > 0 ? 'medicine' : null
    case 'sleep':
    case 'pet':
      return null
  }
}

export interface CareContext {
  readonly companionId: string
  readonly needs: CareNeeds
  readonly signals: CareSignals
  readonly now: Date
  readonly dormant: boolean
}

export interface ActionAvailability {
  readonly action: CareActionKind
  readonly available: boolean
  readonly reason: CareRefusal | null
  /** The item that would be spent, for the button's label. */
  readonly item: CareItemKind | null
}

/**
 * Whether an action can be taken, and why not.
 *
 * Shared by the House's buttons and by `applyCareAction`, so a button is never
 * enabled for something the transition would refuse — the two disagreeing is
 * how a UI ends up telling a user "not enough food" about a button that was
 * never offered.
 */
export function actionAvailability(
  context: CareContext,
  inventory: Readonly<Record<CareItemKind, number>>,
): readonly ActionAvailability[] {
  return (['feed', 'play', 'clean', 'heal', 'sleep', 'pet'] as const).map((action) => {
    const item = itemForAction(action, inventory)
    const need = needForAction(action)

    if (action !== 'pet' && context.dormant) {
      return { action, available: false, reason: 'dormant' as const, item }
    }

    // The need is checked BEFORE the item: a companion that is already full
    // should be told "not hungry", not "you have no food" — the second is true
    // but useless, and it points the user at the wrong problem.
    if (need !== null) {
      const value = context.needs[need]
      if (value === null) {
        return { action, available: false, reason: 'not-measured' as const, item }
      }
      if (value >= 100) {
        return { action, available: false, reason: 'not-needed' as const, item }
      }
    }

    const costsItem =
      action === 'feed' || action === 'play' || action === 'clean' || action === 'heal'
    if (costsItem && item === null) {
      return { action, available: false, reason: 'no-item' as const, item }
    }

    return { action, available: true, reason: null, item }
  })
}

export type CareActionOutcome =
  | {
      readonly ok: true
      readonly state: CareState
      readonly scene: CareScene
      /** The item spent, so the renderer can say what it cost. */
      readonly spentItem: CareItemKind | null
      readonly dialogue: CareDialogueKey
    }
  | { readonly ok: false; readonly reason: CareRefusal }

/**
 * Take a care action.
 *
 * `dialogue` is returned alongside the scene because the reaction ("Ate one
 * food") is about the transition, not about the resulting state: a scene built
 * only from the new needs would say `idle` a millisecond after a meal, which is
 * the exact moment the user expects a reaction.
 */
export function applyCareAction(
  state: CareState,
  action: CareActionKind,
  context: CareContext,
): CareActionOutcome {
  const inventory = inventoryOf(state)
  const availability = actionAvailability(context, inventory).find(
    (entry) => entry.action === action,
  )
  if (!availability) return { ok: false, reason: 'not-needed' }
  if (!availability.available) return { ok: false, reason: availability.reason ?? 'not-needed' }

  const now = context.now
  const iso = now.toISOString()
  const spentItem = availability.item
  let next = spentItem ? spendItem(state, spentItem, now) : state

  switch (action) {
    case 'feed':
      next = {
        ...next,
        lastFedAt: iso,
        // A treat is the mood-lifting one (`PRODUCT.md` §3.3). Plain food feeds
        // without changing the face, which keeps the two worth distinguishing.
        lastRewardAt: spentItem === 'treat' ? iso : next.lastRewardAt,
        updatedAt: iso,
      }
      break
    case 'play':
      next = { ...next, lastPlayedAt: iso, lastRewardAt: iso, updatedAt: iso }
      break
    case 'clean':
      next = { ...next, lastCleanedAt: iso, updatedAt: iso }
      break
    case 'heal':
      next = { ...next, lastHealedAt: iso, updatedAt: iso }
      break
    case 'sleep':
      next = { ...next, lastRestedAt: iso, updatedAt: iso }
      break
    case 'pet':
      next = { ...next, lastPettedAt: iso, lastRewardAt: iso, updatedAt: iso }
      break
  }

  const anchors = careAnchors(next)
  const needs = deriveNeeds(anchors, context.signals, now)
  const dormant = isDormant(needs, anchors, now)
  const moodInput: MoodInput = {
    needs,
    dormant,
    now,
    lastRewardAt: next.lastRewardAt,
    lastRestedAt: next.lastRestedAt,
    lastWorkSessionAt: context.signals.lastWorkSessionAt,
    lastNoteAt: context.signals.lastNoteAt,
  }
  const mood = deriveMood(moodInput)
  const scene = buildCareScene({
    companionId: context.companionId,
    mood,
    needs,
    inventory: inventoryOf(next),
    dormant,
    availableActions: actionAvailability(
      { ...context, needs, dormant },
      inventoryOf(next),
    )
      .filter((entry) => entry.available)
      .map((entry) => entry.action),
    dialogue: dialogueForAction(action, spentItem),
    now,
  })

  return { ok: true, state: next, scene, spentItem, dialogue: scene.dialogue }
}

/**
 * The line the companion says right after an action.
 *
 * Separate from the mood's own dialogue because a full companion that was just
 * fed is still `idle`, and "idle" is not a reaction. These keys are short on
 * purpose: the renderer supplies the sentence, and the desktop popover needs a
 * different length than the House does.
 */
function dialogueForAction(
  action: CareActionKind,
  item: CareItemKind | null,
): CareDialogueKey {
  switch (action) {
    case 'feed':
      return item === 'treat' ? 'excited' : 'greeting'
    case 'play':
      return 'excited'
    case 'clean':
      return 'idle'
    case 'heal':
      return 'unwell'
    case 'sleep':
      return 'resting'
    case 'pet':
      return 'greeting'
  }
}

/**
 * Everything a renderer needs in one call: mint what the ledger earned, derive
 * needs, decide the mood, and build the scene.
 *
 * WHY ONE ENTRY POINT: three surfaces already exist on the roadmap (web, desktop,
 * device) and each would otherwise repeat the four-step sequence. The order
 * matters — minting before deriving means a freshly earned meal shows in the
 * cupboard on the same render the user sees it — and repeating an order four
 * times is how it eventually gets repeated wrongly.
 */
export function buildCareReadout(input: {
  companionId: string
  state: CareState
  ledger: EventLedger
  signals: CareSignals
  now: Date
  utcOffsetMinutes?: number
  dialogue?: CareDialogueKey
}): { state: CareState; needs: CareNeeds; scene: CareScene; signals: CareSignals; dormant: boolean } {
  const state = mintCareItems(input.state, input.ledger, input.now, {
    utcOffsetMinutes: input.utcOffsetMinutes ?? 0,
    today: input.signals.today,
  })
  const anchors = careAnchors(state)
  const needs = deriveNeeds(anchors, input.signals, input.now)
  const dormant = isDormant(needs, anchors, input.now)
  const mood = deriveMood({
    needs,
    dormant,
    now: input.now,
    lastRewardAt: state.lastRewardAt,
    lastRestedAt: state.lastRestedAt,
    lastWorkSessionAt: input.signals.lastWorkSessionAt,
    lastNoteAt: input.signals.lastNoteAt,
  })
  const inventory = inventoryOf(state)
  const context: CareContext = {
    companionId: input.companionId,
    needs,
    signals: input.signals,
    now: input.now,
    dormant,
  }
  const scene = buildCareScene({
    companionId: input.companionId,
    mood,
    needs,
    inventory,
    dormant,
    availableActions: actionAvailability(context, inventory)
      .filter((entry) => entry.available)
      .map((entry) => entry.action),
    dialogue: input.dialogue,
    now: input.now,
    utcOffsetMinutes: input.utcOffsetMinutes ?? 0,
  })
  return { state, needs, scene, signals: input.signals, dormant }
}
