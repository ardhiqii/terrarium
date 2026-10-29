/**
 * The server-side trust boundary for stored product snapshots.
 *
 * WHY THIS FILE EXISTS: this module is applied on both the write path and the read path, and
 * it decides whether an account KEEPS its unopened eggs, its essence, and its draw history.
 * It had no tests of its own — only incidental coverage through the route.
 *
 * The distinction it now makes: `changed` means "the shape was repaired", which happens for
 * bookkeeping reasons too (an active companion that is not owned, a catalog entry that was
 * removed). `droppedEvents` means "an event was removed", which is the only case where
 * invalidating encounter rewards is the honest answer. Tying the reset to `changed` wiped a
 * real account's entire egg and essence history over a mismatch that had nothing to do with
 * untrusted activity.
 */
import { describe, expect, it } from 'vitest'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createEncounterState } from '@/lib/game/encounters'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { asCompanionId, asEventId, type NormalizedEvent } from '@/lib/game/events'
import { buildProductSnapshot, type ProductSnapshot } from './product-snapshot'
import { trustStoredProductSnapshot } from './trusted-product-snapshot'

const NOW = '2026-10-01T12:00:00.000Z'
const GITHUB_ID = 4242

function localEvent(id: string): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId('pikachu-family'),
    source: 'mounted-markdown',
    sourceId: 'vault-1',
    provenance: 'local',
    category: 'new-note',
    occurredAt: NOW,
  }
}

function snapshot(events: NormalizedEvent[]): ProductSnapshot {
  const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now: NOW })
  return buildProductSnapshot(
    createProductState(profile, { events }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
    NOW,
  )
}

const DRAWS = [
  {
    id: 'draw-1',
    sequence: 0,
    triggerId: 'trigger-1',
    seed: 'seed-1',
    selectedCompanionId: 'pikachu-family',
    selectedFamilyId: 'pikachu',
    isDuplicate: false,
    essenceAwarded: 12,
    weights: [
      {
        companionId: 'pikachu-family',
        baseWeight: 1,
        tagMatchCount: 0,
        languageMatchCount: 0,
        fileTypeMatchCount: 0,
        tagBonus: 0,
        languageBonus: 0,
        fileTypeBonus: 0,
        finalWeight: 1,
      },
    ],
  },
] satisfies ProductSnapshot['encounters']['draws']

describe('a snapshot whose SHAPE was repaired keeps its encounter history', () => {
  it('does not reset draws, meter, or essence when no event was removed', () => {
    // The trigger: a collection entry naming a companion outside the catalog. The shape is
    // repaired (the entry is filtered) but every event is still trusted.
    const base = snapshot([localEvent('note-1')])
    const withStranger: ProductSnapshot = {
      ...base,
      collection: [
        ...base.collection,
        {
          referenceId: 'guest-1:ghost',
          companionId: 'not-in-the-catalog',
          acquiredAt: NOW,
          acquisition: 'encounter',
        },
      ],
      encounters: {
        ...base.encounters,
        meter: 7,
        totalProgress: 3,
        draws: DRAWS,
        processedTriggerIds: ['trigger-1'],
        essenceByFamily: { pikachu: 12 },
      },
    }

    const trusted = trustStoredProductSnapshot(withStranger, GITHUB_ID)

    expect(trusted.collection.some((entry) => entry.companionId === 'not-in-the-catalog')).toBe(false)
    expect(trusted.encounters.draws).toHaveLength(1)
    expect(trusted.encounters.meter).toBe(7)
    expect(trusted.encounters.essenceByFamily).toEqual({ pikachu: 12 })
  })
})

describe('a snapshot that LOST an event gives up the rewards tied to it', () => {
  it('resets encounter rewards when a GitHub event has no valid receipt', () => {
    // Reachable after a signing-key rotation: the stored event no longer verifies, so its XP
    // must not survive the boundary — and neither may a draw it produced.
    const base = snapshot([
      {
        eventId: asEventId('github:4242:merged-pull-request:1'),
        companionId: asCompanionId('pikachu-family'),
        source: 'github',
        sourceId: 'github-account:4242',
        provenance: 'verified',
        category: 'merged-pull-request',
        occurredAt: NOW,
      },
    ])
    const withRewards: ProductSnapshot = {
      ...base,
      events: base.events.map((event) => ({ ...event, verifiedProof: 'not-a-real-receipt' })),
      encounters: {
        ...base.encounters,
        meter: 7,
        draws: DRAWS,
        processedTriggerIds: ['trigger-1'],
        essenceByFamily: { pikachu: 12 },
      },
    }

    const trusted = trustStoredProductSnapshot(withRewards, GITHUB_ID)

    expect(trusted.events).toHaveLength(0)
    expect(trusted.encounters.draws).toEqual([])
    expect(trusted.encounters.meter).toBe(0)
    expect(trusted.encounters.essenceByFamily).toEqual({})
  })

  it('drops a local event that claims to be verified', () => {
    // Verified provenance is only meaningful with a server receipt, so a local event claiming
    // it is malformed, not merely untrusted.
    const base = snapshot([localEvent('note-1')])
    const claiming: ProductSnapshot = {
      ...base,
      events: base.events.map((event) => ({ ...event, provenance: 'verified' as const })),
    }

    expect(trustStoredProductSnapshot(claiming, GITHUB_ID).events).toHaveLength(0)
  })

  it('returns an untouched snapshot when nothing needs repairing', () => {
    const base = snapshot([localEvent('note-1')])
    const withRewards: ProductSnapshot = {
      ...base,
      encounters: { ...base.encounters, draws: DRAWS, essenceByFamily: { pikachu: 12 } },
    }

    const trusted = trustStoredProductSnapshot(withRewards, GITHUB_ID)

    expect(trusted.events).toHaveLength(1)
    expect(trusted.encounters.draws).toHaveLength(1)
    expect(trusted.encounters.essenceByFamily).toEqual({ pikachu: 12 })
  })
})
