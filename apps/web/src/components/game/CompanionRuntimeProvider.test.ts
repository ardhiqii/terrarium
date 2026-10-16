import { describe, expect, it } from 'vitest'
import { companionRuntimeEventMatchesNamespace, mergeEncounterState } from './CompanionRuntimeProvider'
import { createEncounterState, type EncounterState } from '@/lib/game/encounters'

describe('companion runtime namespace notifications', () => {
  it('accepts an event for the same account namespace only', () => {
    const event = { detail: { namespace: 'github-42' } } as unknown as Event

    expect(companionRuntimeEventMatchesNamespace(event, 'github-42')).toBe(true)
    expect(companionRuntimeEventMatchesNamespace(event, 'github-99')).toBe(false)
  })

  it('does not let an account runtime consume an unnamespaced guest event', () => {
    const event = { detail: undefined } as unknown as Event

    expect(companionRuntimeEventMatchesNamespace(event)).toBe(true)
    expect(companionRuntimeEventMatchesNamespace(event, 'github-42')).toBe(false)
  })

  it('preserves concurrent distinct draws, Essence, and progress', () => {
    const base = createEncounterState()
    const left: EncounterState = {
      ...base,
      meter: 0,
      totalProgress: 100,
      nextSequence: 1,
      draws: [{
        id: 'guest:0:left',
        sequence: 0,
        triggerId: 'left-trigger',
        seed: 'left-seed',
        selectedCompanionId: 'ditto-like',
        selectedFamilyId: 'ditto-family',
        isDuplicate: true,
        essenceAwarded: 2,
        weights: [],
      }],
      processedTriggerIds: ['left-trigger'],
      essenceByFamily: { 'ditto-family': 2 },
      progressByTriggerId: { 'left-trigger': 100 },
    }
    const right: EncounterState = {
      ...base,
      meter: 0,
      totalProgress: 100,
      nextSequence: 1,
      draws: [{
        id: 'guest:0:right',
        sequence: 0,
        triggerId: 'right-trigger',
        seed: 'right-seed',
        selectedCompanionId: 'ditto-like',
        selectedFamilyId: 'ditto-family',
        isDuplicate: true,
        essenceAwarded: 2,
        weights: [],
      }],
      processedTriggerIds: ['right-trigger'],
      essenceByFamily: { 'ditto-family': 2 },
      progressByTriggerId: { 'right-trigger': 100 },
    }

    const merged = mergeEncounterState(left, right)

    expect(merged.draws).toHaveLength(2)
    expect(merged.essenceByFamily).toEqual({ 'ditto-family': 4 })
    expect(merged.totalProgress).toBe(200)
    expect(merged.meter).toBe(0)
    expect(new Set(merged.processedTriggerIds)).toEqual(new Set(['left-trigger', 'right-trigger']))
  })

  it('preserves multiple draws produced by one trigger', () => {
    const base = createEncounterState()
    const left: EncounterState = {
      ...base,
      totalProgress: 250,
      nextSequence: 2,
      draws: [
        { id: 'guest:0:burst', sequence: 0, triggerId: 'burst', seed: 'burst', selectedCompanionId: 'a', selectedFamilyId: 'family-a', isDuplicate: true, essenceAwarded: 1, weights: [] },
        { id: 'guest:1:burst', sequence: 1, triggerId: 'burst', seed: 'burst', selectedCompanionId: 'b', selectedFamilyId: 'family-b', isDuplicate: true, essenceAwarded: 2, weights: [] },
      ],
      processedTriggerIds: ['burst'],
      essenceByFamily: { 'family-a': 1, 'family-b': 2 },
      progressByTriggerId: { burst: 250 },
    }

    const merged = mergeEncounterState(base, left)

    expect(merged.draws.map((draw) => draw.id)).toEqual(['guest:0:burst', 'guest:1:burst'])
    expect(merged.essenceByFamily).toEqual({ 'family-a': 1, 'family-b': 2 })
    expect(merged.totalProgress).toBe(250)
  })
})
