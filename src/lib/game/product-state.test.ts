import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type EventLedger, type NormalizedEvent } from './events'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { createProductState, applyProductEvents, switchActiveCompanion } from './product-state'
import { createGuestProfile } from './guest-profile'

const now = '2026-08-28T10:00:00.000Z'

function event(id: string, companionId = 'pikachu-family'): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId(companionId),
    source: 'built-in-editor',
    sourceId: 'guest-notes',
    provenance: 'local',
    category: 'new-note',
    occurredAt: now,
  }
}

function initialState() {
  const profile = createGuestProfile({
    guestId: 'guest-1',
    starterCompanionId: 'pikachu-family',
    now,
  })
  const ledger: EventLedger = { events: [] }
  return createProductState(profile, ledger, undefined, PROTOTYPE_COMPANION_CATALOG)
}

describe('product state', () => {
  it('starts with an active starter companion at zero XP', () => {
    const state = initialState()
    expect(state.activeCompanion?.companionId).toBe('pikachu-family')
    expect(state.activeCompanion?.xp).toBe(0)
    expect(state.activeCompanion?.progression?.step.id).toBe('base')
  })

  it('attributes new events to the active companion and advances progression', () => {
    const state = initialState()
    const next = applyProductEvents(
      state,
      [event('note-1'), event('note-2'), event('note-3'), event('note-4')],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 0 },
    )

    expect(next.activeCompanion?.xp).toBe(100)
    expect(next.activeCompanion?.progression?.step.id).toBe('evolved')
    expect(next.ledger.events).toHaveLength(4)
  })

  it('does not count replayed events or reroll the encounter', () => {
    const state = initialState()
    const first = applyProductEvents(
      state,
      [event('note-1')],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 100, triggerId: 'scan-1', seed: 'stable' },
    )
    const replay = applyProductEvents(
      first,
      [event('note-1')],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 100, triggerId: 'scan-1', seed: 'different' },
    )

    expect(replay.ledger.events).toHaveLength(1)
    expect(replay.encounters.draws).toEqual(first.encounters.draws)
    expect(replay.profile.collection).toEqual(first.profile.collection)
  })

  it('keeps XP with the original companion after switching', () => {
    const state = initialState()
    const earned = applyProductEvents(
      state,
      [event('note-1'), event('note-2')],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 0 },
    )
    const withSecond = {
      ...earned,
      profile: {
        ...earned.profile,
        collection: [
          ...earned.profile.collection,
          {
            referenceId: 'second',
            companionId: 'ditto-like',
            acquiredAt: now,
            acquisition: 'history' as const,
          },
        ],
      },
    }
    const switched = switchActiveCompanion(withSecond, 'ditto-like', PROTOTYPE_COMPANION_CATALOG)
    expect(switched.activeCompanion?.companionId).toBe('ditto-like')
    expect(switched.companions.find((item) => item.companionId === 'pikachu-family')?.xp).toBe(50)
    expect(switched.activeCompanion?.xp).toBe(0)
  })
})
