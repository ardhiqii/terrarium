import { describe, expect, it } from 'vitest'
import {
  advanceEncounter,
  createEncounterState,
  getEncounterWeights,
  type EncounterState,
} from './encounters'
import { createCompanionCatalog, PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'

describe('encounter engine', () => {
  it('shows transparent tag, language, and file-type weighting', () => {
    const pikachu = getEncounterWeights(PROTOTYPE_COMPANION_CATALOG, {
      tags: ['#Momentum', 'social'],
      languages: ['TypeScript'],
      fileTypes: ['.TSX'],
    }).find((candidate) => candidate.companionId === 'pikachu-family')!

    expect(pikachu.matchedTags).toEqual(['momentum', 'social'])
    expect(pikachu.matchedLanguages).toEqual(['typescript'])
    expect(pikachu.matchedFileTypes).toEqual(['tsx'])
    expect(pikachu.tagBonus).toBe(24)
    expect(pikachu.languageBonus).toBe(20)
    expect(pikachu.fileTypeBonus).toBe(16)
    expect(pikachu.finalWeight).toBe(160)
  })

  it('draws deterministically from the same catalog, seed, and sequence', () => {
    const trigger = {
      id: 'activity-1',
      progress: 100,
      seed: 'stable-profile-seed',
      signals: { languages: ['typescript'] },
      ownedCompanionIds: [],
    }
    const left = advanceEncounter(createEncounterState(), trigger, PROTOTYPE_COMPANION_CATALOG)
    const right = advanceEncounter(createEncounterState(), trigger, PROTOTYPE_COMPANION_CATALOG)
    expect(left.newDraws[0]).toEqual(right.newDraws[0])
  })

  it('persists the result and ignores replayed trigger IDs', () => {
    const trigger = {
      id: 'activity-1',
      progress: 100,
      seed: 'first-seed',
      signals: { tags: ['adaptation'] },
      ownedCompanionIds: [],
    }
    const first = advanceEncounter(createEncounterState(), trigger, PROTOTYPE_COMPANION_CATALOG)
    const replay = advanceEncounter(
      first.state,
      { ...trigger, seed: 'different-seed', signals: { tags: ['energy'] } },
      PROTOTYPE_COMPANION_CATALOG,
    )

    expect(replay.ignored).toBe(true)
    expect(replay.newDraws).toEqual(first.newDraws)
    expect(replay.state).toEqual(first.state)
  })

  it('converts duplicate encounters into family-specific Essence', () => {
    const single = createCompanionCatalog([
      PROTOTYPE_COMPANION_CATALOG.get('ditto-like')!,
    ])
    const base: EncounterState = createEncounterState()
    const first = advanceEncounter(
      base,
      {
        id: 'first',
        progress: 100,
        seed: 'same',
        signals: {},
        ownedCompanionIds: [],
      },
      single,
    )
    const second = advanceEncounter(
      first.state,
      {
        id: 'second',
        progress: 100,
        seed: 'same',
        signals: {},
        ownedCompanionIds: ['ditto-like'],
      },
      single,
    )

    expect(first.newDraws[0].isDuplicate).toBe(false)
    expect(second.newDraws[0].isDuplicate).toBe(true)
    expect(second.newDraws[0].essenceAwarded).toBe(2)
    expect(second.state.essenceByFamily).toEqual({ 'ditto-family': 2 })
  })

  it('can produce multiple persisted draws when a large milestone crosses thresholds', () => {
    const result = advanceEncounter(
      createEncounterState(),
      {
        id: 'large-milestone',
        progress: 250,
        seed: 'batch',
        signals: {},
        ownedCompanionIds: [],
      },
      PROTOTYPE_COMPANION_CATALOG,
    )
    expect(result.newDraws).toHaveLength(2)
    expect(result.state.meter).toBe(50)
    expect(result.state.nextSequence).toBe(2)
  })

  it('rejects negative progress and invalid encounter configuration', () => {
    expect(() =>
      advanceEncounter(
        createEncounterState(),
        {
          id: 'bad',
          progress: -1,
          seed: 'seed',
          signals: {},
          ownedCompanionIds: [],
        },
        PROTOTYPE_COMPANION_CATALOG,
      ),
    ).toThrow(/non-negative/)

    expect(() =>
      advanceEncounter(
        createEncounterState(),
        {
          id: 'bad-config',
          progress: 100,
          seed: 'seed',
          signals: {},
          ownedCompanionIds: [],
        },
        PROTOTYPE_COMPANION_CATALOG,
        { threshold: 0, profileKey: 'guest' },
      ),
    ).toThrow(/threshold/)
  })
})
