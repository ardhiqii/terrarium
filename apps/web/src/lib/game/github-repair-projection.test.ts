import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type NormalizedEvent } from './events'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { createEncounterState } from './encounters'
import { createGuestProfile } from './guest-profile'
import { createProductState } from './product-state'
import {
  buildProductSnapshot,
  validateProductSnapshot,
  type ProductSnapshot,
} from '../sync/product-snapshot'
import { productEventId } from '../sync/product-event-id'
import {
  canStartReceiptRepair,
  projectPartialProductSnapshot,
} from './github-repair-projection'

const now = '2026-09-24T10:00:00.000Z'

function event(id: string, companionId = 'pikachu-family'): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId(companionId),
    source: 'github',
    sourceId: 'github-sync',
    provenance: 'verified',
    category: 'new-note',
    occurredAt: now,
  }
}

function snapshotWithRewards(): ProductSnapshot {
  const profile = createGuestProfile({ guestId: 'guest-repair', starterCompanionId: 'pikachu-family', now })
  const state = createProductState(
    profile,
    { events: [event('valid'), event('blocked')] },
    createEncounterState(),
    PROTOTYPE_COMPANION_CATALOG,
  )
  const base = buildProductSnapshot(state, now, {
    [productEventId(state.ledger.events[0]!.eventId)]: 'valid-receipt',
    [productEventId(state.ledger.events[1]!.eventId)]: 'blocked-receipt',
  })
  return {
    ...base,
    activeCompanionId: 'eevee-family',
    companions: [
      ...base.companions,
      {
        companionId: 'eevee-family',
        familyId: 'eevee-family',
        xp: 99,
        essence: 7,
        encounterCount: 1,
        progression: null,
      },
    ],
    collection: [
      ...base.collection,
      {
        referenceId: 'history-ref',
        companionId: 'eevee-family',
        acquiredAt: now,
        acquisition: 'history',
      },
      {
        referenceId: 'encounter-ref',
        companionId: 'eevee-family',
        acquiredAt: now,
        acquisition: 'encounter',
      },
    ],
    encounters: {
      meter: 17,
      totalProgress: 117,
      nextSequence: 4,
      draws: [{
        id: 'draw-00000001-00000001',
        sequence: 3,
        triggerId: 'trigger-00000001-00000001',
        seed: 'seed-00000001-00000001',
        selectedCompanionId: 'eevee-family',
        selectedFamilyId: 'eevee-family',
        isDuplicate: false,
        essenceAwarded: 7,
        weights: [],
      }],
      processedTriggerIds: ['trigger-00000001-00000001'],
      essenceByFamily: { 'eevee-family': 7 },
    },
  }
}

describe('partial GitHub receipt-repair projection', () => {
  it('checks the legacy receipt capability before taking the repair lock', () => {
    expect(canStartReceiptRepair(null, ['event-a'], new Set())).toBe(false)
    expect(canStartReceiptRepair(null, ['event-a'], new Set(['event-a']))).toBe(true)
    expect(canStartReceiptRepair('signed-checkpoint', ['event-a'], new Set())).toBe(true)
  })

  it('keeps valid owned events and profile history but removes blocked-derived rewards', () => {
    const snapshot = snapshotWithRewards()
    const blockedId = snapshot.events.find((event) => event.verifiedProof === 'blocked-receipt')!.eventId
    const projected = projectPartialProductSnapshot(snapshot, new Set([blockedId]))

    expect(projected.events.map((event) => event.verifiedProof)).toEqual(['valid-receipt'])
    expect(snapshot.events.map((event) => event.verifiedProof)).toEqual(['valid-receipt', 'blocked-receipt'])
    expect(projected.collection.map((reference) => reference.acquisition)).toEqual(['starter', 'history'])
    expect(projected.activeCompanionId).toBe('eevee-family')
    expect(projected.encounters).toEqual({
      meter: 0,
      totalProgress: 0,
      nextSequence: 0,
      draws: [],
      processedTriggerIds: [],
      essenceByFamily: {},
    })
    expect(projected.companions.map((companion) => companion.companionId)).toEqual([
      'pikachu-family',
      'eevee-family',
    ])
    expect(projected.companions.every((companion) => companion.xp === 0 && companion.essence === 0 && companion.progression === null)).toBe(true)
    expect(() => validateProductSnapshot(projected)).not.toThrow()
  })

  it('does not project when the blocked overlay names no event in the snapshot', () => {
    const snapshot = snapshotWithRewards()
    expect(projectPartialProductSnapshot(snapshot, new Set(['event-missing']))).toBe(snapshot)
  })

  it('returns the original snapshot when there is no blocked event', () => {
    const snapshot = snapshotWithRewards()
    expect(projectPartialProductSnapshot(snapshot, new Set())).toBe(snapshot)
  })
})
