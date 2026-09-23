import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type EventLedger, type NormalizedEvent } from './events'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { createEncounterState } from './encounters'
import { createProductState, applyProductEvents, switchActiveCompanion } from './product-state'
import { createGuestProfile } from './guest-profile'

const now = '2026-08-28T10:00:00.000Z'

function event(
  id: string,
  companionId = 'pikachu-family',
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId(companionId),
    source: 'built-in-editor',
    sourceId: 'guest-notes',
    provenance: 'local',
    category: 'new-note',
    occurredAt: now,
    ...overrides,
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

  it('refreshes changed metadata and cap on a stable verified event ID', () => {
    const firstEvidence = event('verified-1', 'pikachu-family', {
      source: 'github',
      sourceId: 'github-account:1',
      provenance: 'verified',
      metadata: { activityCount: 1 },
      cap: { key: 'github:1:2026-08-28:work-session', limit: 1 },
    })
    const first = applyProductEvents(
      initialState(),
      [firstEvidence],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 0 },
    )
    const refreshedEvidence = {
      ...firstEvidence,
      occurredAt: '2026-08-28T11:00:00.000Z',
      metadata: { activityCount: 2, bucket: '2026-08-28-11' },
      cap: { key: 'github:1:2026-08-28:work-session', limit: 2 },
    }

    const refreshed = applyProductEvents(
      first,
      [refreshedEvidence],
      PROTOTYPE_COMPANION_CATALOG,
    )

    expect(refreshed.ledger.events).toHaveLength(1)
    expect(refreshed.ledger.events[0]).toMatchObject({
      provenance: 'verified',
      occurredAt: '2026-08-28T11:00:00.000Z',
      metadata: { activityCount: 2, bucket: '2026-08-28-11' },
      cap: { key: expect.stringMatching(/^cap-[0-9a-f]{8}-[0-9a-f]{8}$/u), limit: 2 },
    })
  })

  it('normalizes restored and fresh cap keys into one capped bucket', () => {
    const first = event('capped-1', 'pikachu-family', {
      source: 'github',
      sourceId: 'github-account:1',
      provenance: 'verified',
      category: 'work-session',
      occurredAt: '2026-08-28T10:00:00.000Z',
      cap: { key: 'github:1:2026-08-28:work-session', limit: 2 },
    })
    const second = event('capped-2', 'pikachu-family', {
      source: 'github',
      sourceId: 'github-account:1',
      provenance: 'verified',
      category: 'work-session',
      occurredAt: '2026-08-28T10:30:00.000Z',
      cap: { key: 'github:1:2026-08-28:work-session', limit: 2 },
    })
    const third = event('capped-3', 'pikachu-family', {
      source: 'github',
      sourceId: 'github-account:1',
      provenance: 'verified',
      category: 'work-session',
      occurredAt: '2026-08-28T11:00:00.000Z',
      cap: { key: 'github:1:2026-08-28:work-session', limit: 2 },
    })

    // Simulate a ledger restored from before cap keys were opaque: the first
    // record is already in state, while the next delivery is fresh.
    const restored = createProductState(
      initialState().profile,
      { events: [first] },
      createEncounterState(),
      PROTOTYPE_COMPANION_CATALOG,
    )
    const state = applyProductEvents(restored, [second, third], PROTOTYPE_COMPANION_CATALOG)

    expect(state.activeCompanion?.xp).toBe(20)
    expect(new Set(state.ledger.events.map((item) => item.cap?.key)).size).toBe(1)
  })

  it('does not award duplicate XP or rerun encounters for a verified evidence refresh', () => {
    const original = event('verified-2', 'pikachu-family', {
      source: 'github',
      sourceId: 'github-account:1',
      provenance: 'verified',
      metadata: { activityCount: 1 },
    })
    const first = applyProductEvents(
      initialState(),
      [original],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 100, triggerId: 'scan-1', seed: 'stable' },
    )
    const refreshed = applyProductEvents(
      first,
      [{ ...original, metadata: { activityCount: 2 } }],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 100, triggerId: 'scan-2', seed: 'different' },
    )

    expect(refreshed.activeCompanion?.xp).toBe(first.activeCompanion?.xp)
    expect(refreshed.encounters).toEqual(first.encounters)
    expect(refreshed.encounters.draws).toHaveLength(1)
    expect(refreshed.ledger.events).toHaveLength(1)
  })

  it('keeps verified event ownership when a replay arrives after switching companions', () => {
    const original = event('owned-evidence', 'pikachu-family', {
      source: 'github',
      sourceId: 'github-account:1',
      provenance: 'verified',
      metadata: { activityCount: 1 },
    })
    const first = applyProductEvents(initialState(), [original], PROTOTYPE_COMPANION_CATALOG)
    const replayedForNewCompanion = applyProductEvents(
      first,
      [{ ...original, companionId: asCompanionId('ditto-like'), metadata: { activityCount: 2 } }],
      PROTOTYPE_COMPANION_CATALOG,
    )

    expect(replayedForNewCompanion.ledger.events[0]?.companionId).toBe('pikachu-family')
    expect(replayedForNewCompanion.companions.find((item) => item.companionId === 'pikachu-family')?.xp).toBe(25)
    expect(replayedForNewCompanion.companions.find((item) => item.companionId === 'ditto-like')).toBeUndefined()
  })

  it('upgrades local evidence to verified and ignores a later local replay', () => {
    const local = event('shared-evidence')
    const first = applyProductEvents(initialState(), [local], PROTOTYPE_COMPANION_CATALOG)
    const verified = {
      ...local,
      source: 'github' as const,
      sourceId: 'github-account:1',
      provenance: 'verified' as const,
      metadata: { activityCount: 2 },
      cap: { key: 'github:1:2026-08-28:work-session', limit: 1 },
    }
    const upgraded = applyProductEvents(first, [verified], PROTOTYPE_COMPANION_CATALOG)
    const localReplay = applyProductEvents(
      upgraded,
      [{ ...verified, provenance: 'local', metadata: { activityCount: 3 } }],
      PROTOTYPE_COMPANION_CATALOG,
    )

    expect(upgraded.ledger.events[0]).toMatchObject({
      provenance: 'verified',
      metadata: { activityCount: 2 },
    })
    expect(localReplay.ledger.events[0]).toEqual(upgraded.ledger.events[0])
    expect(localReplay.activeCompanion?.xp).toBe(upgraded.activeCompanion?.xp)
    expect(localReplay.encounters).toEqual(upgraded.encounters)
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
