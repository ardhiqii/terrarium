import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type EventLedger, type NormalizedEvent } from './events'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { createEncounterState, type EncounterState } from './encounters'
import { createGuestProfile } from './guest-profile'
import {
  computeLegacyCreatureXp,
  fingerprintLegacyCreatureInput,
  migrateLegacyCreature,
  type LegacyCreatureInput,
} from './companion-migration'
import { applyProductEvents, createProductState, switchActiveCompanion } from './product-state'
import type { GardenStats, GithubStats } from './types'

const now = '2026-08-28T10:00:00.000Z'

const legacyStats: GardenStats = {
  noteCount: 10,
  projectCount: 0,
  totalWords: 500,
  resolvedWikilinks: 10,
  backlinksReceived: 11,
  tagCount: 1,
  maturityCounts: { seedling: 9, budding: 0, evergreen: 1 },
  maxBacklinksOnSingleNote: 3,
  firstPublishedAt: '2026-08-01T00:00:00.000Z',
  lastPublishedAt: '2026-08-27T00:00:00.000Z',
}

const legacyGithub: GithubStats = {
  login: 'fixture-user',
  totalCommits: 3,
  commitsByDay: { '2026-08-26': 2, '2026-08-27': 1 },
  gardenCommitsByDay: {},
  currentStreakDays: 2,
  fetchedAt: '2026-08-27T23:59:00.000Z',
}

const legacyInput: LegacyCreatureInput = {
  legacyStats,
  legacyGithub,
  sourceFingerprint: 'fixture:legacy-creature-v1',
}

function sourceEvent(
  eventId: string,
  category: NormalizedEvent['category'],
  provenance: NormalizedEvent['provenance'],
): NormalizedEvent {
  return {
    eventId: asEventId(eventId),
    companionId: asCompanionId('pikachu-family'),
    source: category === 'new-note' ? 'built-in-editor' : 'github',
    sourceId: category === 'new-note' ? 'guest-notes' : 'github-account:42',
    provenance,
    category,
    occurredAt: now,
    cap: category === 'merged-pull-request'
      ? { key: 'github:42:2026-08-28:merged-pull-request', limit: 1 }
      : undefined,
    metadata: { activityCount: 1, fixture: true },
  }
}

function fixtureEncounters(): EncounterState {
  return {
    ...createEncounterState(),
    meter: 61,
    totalProgress: 61,
  }
}

function fixtureState() {
  const profile = createGuestProfile({
    guestId: 'guest-migration-fixture',
    starterCompanionId: 'pikachu-family',
    catalog: PROTOTYPE_COMPANION_CATALOG,
    now,
  })
  const ledger: EventLedger = {
    events: [
      sourceEvent('built-in-editor:guest-notes:note-11', 'new-note', 'local'),
      sourceEvent('github:github-account%3A42:pr-101', 'merged-pull-request', 'verified'),
    ],
  }
  return createProductState(
    profile,
    ledger,
    fixtureEncounters(),
    PROTOTYPE_COMPANION_CATALOG,
  )
}

describe('legacy companion migration', () => {
  it('rejects malformed legacy numbers before minting a credit', () => {
    expect(() => computeLegacyCreatureXp({
      ...legacyInput,
      legacyStats: { ...legacyStats, totalWords: Number.NaN },
    })).toThrow(/totalWords/)
    expect(() => computeLegacyCreatureXp({
      ...legacyInput,
      legacyGithub: { ...legacyGithub, commitsByDay: { '2026-08-26': -1 } },
    })).toThrow(/commitsByDay/)
  })

  it('recomputes the fixture arithmetic instead of trusting a rendered total', () => {
    expect(computeLegacyCreatureXp(legacyInput)).toEqual({
      gardenXp: 1535,
      commitXp: 15,
      totalXp: 1550,
    })
    expect(fingerprintLegacyCreatureInput(legacyInput)).toBe(
      fingerprintLegacyCreatureInput({
        legacyGithub: { ...legacyGithub },
        legacyStats: { ...legacyStats, maturityCounts: { ...legacyStats.maturityCounts } },
      }),
    )
  })

  it('matches the exact Pikachu plus legacy Grass fixture without replaying events', () => {
    const before = fixtureState()
    const beforeEvents = before.ledger.events
    const beforeEncounters = before.encounters
    const result = migrateLegacyCreature(
      before,
      legacyInput,
      PROTOTYPE_COMPANION_CATALOG,
      { now },
    )

    expect(result.status).toBe('applied')
    expect(result.gardenXp).toBe(1535)
    expect(result.commitXp).toBe(15)
    expect(result.totalXp).toBe(1550)
    expect(result.credit).toMatchObject({
      creditId: 'migration:legacy-creature:v1:grass-family',
      migrationVersion: 'legacy-creature:v1',
      companionId: 'grass-family',
      totalXp: 1550,
      sourceFingerprint: 'fixture:legacy-creature-v1',
    })

    const migrated = result.state
    expect(migrated.profile.migrationVersion).toBe('legacy-creature:v1')
    expect(migrated.profile.activeCompanionId).toBe('grass-family')
    expect(migrated.profile.activeSelection).toMatchObject({
      companionId: 'grass-family',
      provenance: 'migration',
      migrationVersion: 'legacy-creature:v1',
    })
    expect(migrated.profile.collection).toEqual([
      ...before.profile.collection,
      {
        referenceId: 'migration:legacy-creature:v1:grass-family',
        companionId: 'grass-family',
        acquiredAt: now,
        acquisition: 'history',
      },
    ])
    expect(migrated.profile.legacyCredits).toEqual([result.credit])
    expect(migrated.activeCompanion?.companionId).toBe('grass-family')
    expect(migrated.activeCompanion?.xp).toBe(1550)
    expect(migrated.activeCompanion?.progression).toMatchObject({
      step: { id: 'mossling' },
      xpIntoStep: 50,
      xpForNextStep: 3500,
    })
    expect(migrated.companions.find((companion) => companion.companionId === 'pikachu-family')?.xp).toBe(50)
    expect(migrated.companions.find((companion) => companion.companionId === 'grass-family')?.xp).not.toBe(1600)

    expect(migrated.ledger.events).toEqual(beforeEvents)
    expect(migrated.encounters).toEqual(beforeEncounters)
    expect(migrated.ledger.events.map((event) => [event.eventId, event.companionId, event.provenance])).toEqual([
      ['built-in-editor:guest-notes:note-11', 'pikachu-family', 'local'],
      ['github:github-account%3A42:pr-101', 'pikachu-family', 'verified'],
    ])

    const replayed = applyProductEvents(migrated, beforeEvents, PROTOTYPE_COMPANION_CATALOG, {
      encounterProgress: 100,
      triggerId: 'migration-replay',
    })
    expect(replayed.ledger.events).toEqual(migrated.ledger.events)
    expect(replayed.encounters).toEqual(migrated.encounters)
    expect(replayed.companions.find((item) => item.companionId === 'grass-family')?.xp).toBe(1550)
  })

  it('fails closed when the migration reference ID is already owned by another companion', () => {
    const original = fixtureState()
    const tampered = {
      ...original,
      profile: {
        ...original.profile,
        collection: [
          ...original.profile.collection,
          {
            referenceId: 'migration:legacy-creature:v1:grass-family',
            companionId: 'pikachu-family',
            acquiredAt: now,
            acquisition: 'history' as const,
          },
        ],
      },
    }
    const result = migrateLegacyCreature(tampered, legacyInput, PROTOTYPE_COMPANION_CATALOG, { now })
    expect(result.status).toBe('conflict')
    expect(result.changed).toBe(false)
    expect(result.state).toBe(tampered)
  })

  it('is idempotent across retries, including a different retry timestamp', () => {
    const first = migrateLegacyCreature(fixtureState(), legacyInput, PROTOTYPE_COMPANION_CATALOG, { now })
    const second = migrateLegacyCreature(
      first.state,
      legacyInput,
      PROTOTYPE_COMPANION_CATALOG,
      { now: '2026-08-29T10:00:00.000Z' },
    )

    expect(second.status).toBe('already-applied')
    expect(second.changed).toBe(false)
    expect(second.state).toBe(first.state)
    expect(second.state.profile.legacyCredits).toHaveLength(1)
    expect(second.state.companions.find((item) => item.companionId === 'grass-family')?.xp).toBe(1550)
  })

  it('preserves deliberate user selection and rejects a conflicting credit without mutation', () => {
    const original = fixtureState()
    const switched = switchActiveCompanion(
      original,
      'pikachu-family',
      PROTOTYPE_COMPANION_CATALOG,
      now,
    )
    const result = migrateLegacyCreature(switched, legacyInput, PROTOTYPE_COMPANION_CATALOG, { now })
    expect(result.state.profile.activeCompanionId).toBe('pikachu-family')
    expect(result.state.profile.activeSelection?.provenance).toBe('user')

    const conflicting = {
      ...switched,
      profile: {
        ...switched.profile,
        legacyCredits: [{
          ...result.credit,
          totalXp: 999,
        }],
      },
    }
    const conflict = migrateLegacyCreature(conflicting, legacyInput, PROTOTYPE_COMPANION_CATALOG, { now })
    expect(conflict.status).toBe('conflict')
    expect(conflict.changed).toBe(false)
    expect(conflict.state).toBe(conflicting)
  })

  it('keeps migration pure so a failed persistence write can retry from the original state', () => {
    const original = fixtureState()
    const originalSerialized = JSON.stringify(original)
    const result = migrateLegacyCreature(original, legacyInput, PROTOTYPE_COMPANION_CATALOG, { now })

    // Simulate a write that fails before its caller replaces the durable state.
    expect(() => { throw new Error('simulated persistence failure') }).toThrow()
    expect(JSON.stringify(original)).toBe(originalSerialized)
    expect(original.profile.legacyCredits).toEqual([])
    const retry = migrateLegacyCreature(original, legacyInput, PROTOTYPE_COMPANION_CATALOG, { now })
    expect(retry.status).toBe('applied')
    expect(result.state.profile.legacyCredits).toEqual(retry.state.profile.legacyCredits)
  })

  it('attributes future events to the active companion without changing encounter state', () => {
    const migrated = migrateLegacyCreature(fixtureState(), legacyInput, PROTOTYPE_COMPANION_CATALOG, { now }).state
    const grassEvent = sourceEvent('future-grass-event', 'new-note', 'local')
    const grass = applyProductEvents(migrated, [{ ...grassEvent, companionId: asCompanionId('grass-family') }], PROTOTYPE_COMPANION_CATALOG, { encounterProgress: 0 })
    expect(grass.companions.find((item) => item.companionId === 'grass-family')?.xp).toBe(1575)
    expect(grass.companions.find((item) => item.companionId === 'pikachu-family')?.xp).toBe(50)
    expect(grass.encounters.meter).toBe(migrated.encounters.meter)
    expect(grass.encounters.totalProgress).toBe(migrated.encounters.totalProgress)
    expect(grass.encounters.draws).toEqual(migrated.encounters.draws)

    const pikachu = switchActiveCompanion(grass, 'pikachu-family', PROTOTYPE_COMPANION_CATALOG, now)
    const pikachuEvent = sourceEvent('future-pikachu-event', 'new-note', 'local')
    const afterSwitch = applyProductEvents(
      pikachu,
      [{ ...pikachuEvent, companionId: asCompanionId('pikachu-family') }],
      PROTOTYPE_COMPANION_CATALOG,
      { encounterProgress: 0 },
    )
    expect(afterSwitch.companions.find((item) => item.companionId === 'grass-family')?.xp).toBe(1575)
    expect(afterSwitch.companions.find((item) => item.companionId === 'pikachu-family')?.xp).toBe(75)
  })
})
