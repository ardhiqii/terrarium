import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId } from '../events'
import {
  actionAvailability,
  applyCareAction,
  buildCareReadout,
  itemForAction,
  type CareContext,
} from './actions'
import { deriveMood } from './mood'
import type { CareNeeds, CareSignals } from './index'
import {
  createCareState,
  inventoryOf,
  mintCareItems,
  type CareState,
} from './state'

const NOW = new Date('2026-11-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString()
}

function signals(overrides: Partial<CareSignals> = {}): CareSignals {
  return {
    activityDays: [],
    lateNightDays: [],
    categoriesInWindow: [],
    lastActivityAt: null,
    lastQualifyingActiveDayAt: null,
    lastWorkSessionAt: null,
    lastNoteAt: null,
    ciStatus: 'unknown',
    ciSince: null,
    staleOwnPrDays: null,
    staleSince: null,
    today: '2026-11-03',
    ...overrides,
  }
}

function context(needs: CareNeeds, overrides: Partial<CareContext> = {}): CareContext {
  return {
    companionId: 'pikachu-family',
    needs,
    signals: signals(),
    now: NOW,
    dormant: false,
    ...overrides,
  }
}

/** A care state holding exactly one food and nothing else. */
function withFood(): CareState {
  return mintCareItems(createCareState(ago(1)), {
    events: [
      {
        eventId: asEventId('pr-1'),
        companionId: asCompanionId('pikachu-family'),
        source: 'github',
        sourceId: 'repo-1',
        provenance: 'local',
        category: 'merged-pull-request',
        occurredAt: ago(1),
      },
    ],
  }, NOW)
}

describe('choosing the item', () => {
  it('prefers food over a treat', () => {
    expect(itemForAction('feed', { food: 2, treat: 2, medicine: 0, toy: 0, soap: 0 })).toBe('food')
  })

  it('falls back to a treat when there is no food', () => {
    expect(itemForAction('feed', { food: 0, treat: 1, medicine: 0, toy: 0, soap: 0 })).toBe('treat')
  })

  it('costs nothing to sleep or to pet', () => {
    const empty = { food: 0, treat: 0, medicine: 0, toy: 0, soap: 0 }
    expect(itemForAction('sleep', empty)).toBeNull()
    expect(itemForAction('pet', empty)).toBeNull()
  })
})

describe('availability', () => {
  it('says which problem it is, and checks the need before the item', () => {
    const inventory = { food: 0, treat: 0, medicine: 0, toy: 0, soap: 0 }
    const full = context({ hunger: 100, energy: 100, health: null, cleanliness: null, diet: 50 })
    const feed = actionAvailability(full, inventory).find((entry) => entry.action === 'feed')
    // No food AND full: the useful message is "not hungry".
    expect(feed).toEqual({ action: 'feed', available: false, reason: 'not-needed', item: null })
  })

  it('distinguishes an unmeasured need from a satisfied one', () => {
    const inventory = { food: 1, treat: 0, medicine: 1, toy: 0, soap: 1 }
    const needs = { hunger: 100, energy: 100, health: null, cleanliness: null, diet: 100 }
    const available = actionAvailability(context(needs), inventory)
    expect(available.find((entry) => entry.action === 'heal')?.reason).toBe('not-measured')
    expect(available.find((entry) => entry.action === 'clean')?.reason).toBe('not-measured')
  })

  it('refuses every stocked action while dormant, but still allows petting', () => {
    const inventory = { food: 1, treat: 1, medicine: 1, toy: 1, soap: 1 }
    const needs = { hunger: 0, energy: 0, health: null, cleanliness: null, diet: 0 }
    const available = actionAvailability(context(needs, { dormant: true }), inventory)
    expect(available.find((entry) => entry.action === 'feed')?.reason).toBe('dormant')
    expect(available.find((entry) => entry.action === 'pet')?.available).toBe(true)
  })

  it('allows play whenever a toy is in the cupboard', () => {
    const needs = { hunger: 100, energy: 100, health: 100, cleanliness: 100, diet: 100 }
    const available = actionAvailability(context(needs), {
      food: 0,
      treat: 0,
      medicine: 0,
      toy: 1,
      soap: 0,
    })
    expect(available.find((entry) => entry.action === 'play')?.available).toBe(true)
  })
})

describe('taking an action', () => {
  it('feeds, spends one food, and refills hunger', () => {
    const state = withFood()
    expect(inventoryOf(state).food).toBe(1)

    const outcome = applyCareAction(
      state,
      'feed',
      context({ hunger: 25, energy: 100, health: null, cleanliness: null, diet: 25 }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.spentItem).toBe('food')
    expect(inventoryOf(outcome.state).food).toBe(0)
    expect(outcome.state.lastFedAt).toBe(NOW.toISOString())
    expect(outcome.scene.needs.hunger).toBe(100)
  })

  it('refuses to spend food on a companion that is full', () => {
    const state = withFood()
    const outcome = applyCareAction(
      state,
      'feed',
      context({ hunger: 100, energy: 100, health: null, cleanliness: null, diet: 100 }),
    )
    expect(outcome).toEqual({ ok: false, reason: 'not-needed' })
    // The cupboard is untouched: a refused action is not a partial action.
    expect(inventoryOf(state).food).toBe(1)
  })

  it('refuses to feed with an empty cupboard', () => {
    const state = createCareState(ago(1))
    const outcome = applyCareAction(
      state,
      'feed',
      context({ hunger: 10, energy: 100, health: null, cleanliness: null, diet: 0 }),
    )
    expect(outcome).toEqual({ ok: false, reason: 'no-item' })
  })

  it('a treat lifts the mood, plain food does not', () => {
    const treatState: CareState = {
      ...createCareState(ago(1)),
      mints: [{ id: 'release-1', item: 'treat', at: ago(1), granted: true }],
      granted: { food: 0, treat: 1, medicine: 0, toy: 0, soap: 0 },
    }
    const withTreat = applyCareAction(
      treatState,
      'feed',
      context({ hunger: 25, energy: 100, health: null, cleanliness: null, diet: 0 }),
    )
    expect(withTreat.ok && withTreat.scene.mood).toBe('excited')

    const withMeal = applyCareAction(
      withFood(),
      'feed',
      context({ hunger: 25, energy: 100, health: null, cleanliness: null, diet: 0 }),
    )
    expect(withMeal.ok && withMeal.scene.mood).toBe('idle')
  })

  it('sleeps for free and does not touch the inventory', () => {
    const state = createCareState(ago(6))
    const before = inventoryOf(state)
    const outcome = applyCareAction(
      state,
      'sleep',
      context({ hunger: 0, energy: 20, health: null, cleanliness: null, diet: 0 }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(inventoryOf(outcome.state)).toEqual(before)
    expect(outcome.state.lastRestedAt).toBe(NOW.toISOString())
    // The rest resets the energy counts, so the meter recovers on the spot.
    expect(outcome.scene.needs.energy).toBe(100)
  })

  it('pets for free and always reacts', () => {
    const outcome = applyCareAction(
      createCareState(ago(1)),
      'pet',
      context({ hunger: 100, energy: 100, health: null, cleanliness: null, diet: 100 }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.state.lastPettedAt).toBe(NOW.toISOString())
    expect(outcome.dialogue).toBe('greeting')
  })

  it('never lets care move XP, because care never sees it', () => {
    // Structural assertion: the state this module returns has no XP field at
    // all, so no action can be written that changes progression.
    const state = withFood()
    const outcome = applyCareAction(
      state,
      'feed',
      context({ hunger: 25, energy: 100, health: null, cleanliness: null, diet: 0 }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(Object.keys(outcome.state).sort()).toEqual([
      'granted',
      'lastCleanedAt',
      'lastFedAt',
      'lastHealedAt',
      'lastPettedAt',
      'lastPlayedAt',
      'lastRestedAt',
      'lastRewardAt',
      'mints',
      'spent',
      'startedAt',
      'updatedAt',
    ])
  })
})

describe('the readout a renderer consumes', () => {
  it('mints first, so a meal earned today is visible on the same render', () => {
    const readout = buildCareReadout({
      companionId: 'pikachu-family',
      state: createCareState(ago(2)),
      ledger: {
        events: [
          {
            eventId: asEventId('pr-today'),
            companionId: asCompanionId('pikachu-family'),
            source: 'github',
            sourceId: 'repo-1',
            provenance: 'local',
            category: 'merged-pull-request',
            occurredAt: ago(0),
          },
        ],
      },
      signals: signals(),
      now: NOW,
    })
    expect(readout.scene.inventory.food).toBe(1)
    expect(readout.scene.dialogue).toBe('idle')
    expect(readout.scene.availableActions).toContain('feed')
  })

  it('reports a dormant companion without hiding its meters', () => {
    const readout = buildCareReadout({
      companionId: 'pikachu-family',
      state: createCareState(ago(30)),
      ledger: { events: [] },
      signals: signals(),
      now: NOW,
    })
    // Hunger has decayed to zero and there is no diet variety, but energy is
    // still full (it only falls for late nights and long streaks), which is the
    // documented tuning gap that keeps dormancy rare. The scene must still tell
    // the truth about both.
    expect(readout.scene.needs.hunger).toBe(0)
    expect(readout.scene.needs.energy).toBe(100)
    expect(readout.scene.dormant).toBe(false)
  })

  it('carries the day part and the pose, so a renderer derives nothing', () => {
    const readout = buildCareReadout({
      companionId: 'pikachu-family',
      state: createCareState(ago(1)),
      ledger: { events: [] },
      signals: signals({ lastWorkSessionAt: ago(0) }),
      now: NOW,
      utcOffsetMinutes: 0,
    })
    expect(readout.scene.mood).toBe('focused')
    expect(readout.scene.pose).toBe('stand')
    expect(readout.scene.dayPart).toBe('day')
  })
})

describe('mood priority', () => {
  const base = { now: NOW }

  it('puts being unwell above everything else', () => {
    expect(
      deriveMood({
        ...base,
        needs: { hunger: 0, energy: 0, health: 40, cleanliness: 0, diet: 0 },
        dormant: false,
        lastRewardAt: ago(0),
      }),
    ).toBe('unwell')
  })

  it('puts hunger above tiredness', () => {
    expect(
      deriveMood({
        ...base,
        needs: { hunger: 20, energy: 20, health: null, cleanliness: null, diet: 0 },
        dormant: false,
      }),
    ).toBe('hungry')
  })

  it('shows a reward for an hour, then lets it go', () => {
    const needs = { hunger: 100, energy: 100, health: null, cleanliness: null, diet: 100 }
    expect(
      deriveMood({ ...base, needs, dormant: false, lastRewardAt: new Date(NOW.getTime() - 59 * 60_000).toISOString() }),
    ).toBe('excited')
    expect(
      deriveMood({ ...base, needs, dormant: false, lastRewardAt: ago(3) }),
    ).toBe('idle')
  })

  it('a dormant companion reads as resting', () => {
    expect(
      deriveMood({
        ...base,
        needs: { hunger: 0, energy: 0, health: null, cleanliness: null, diet: 0 },
        dormant: true,
        lastRewardAt: ago(0),
      }),
    ).toBe('resting')
  })
})
