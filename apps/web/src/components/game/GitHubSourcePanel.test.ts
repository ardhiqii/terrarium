import { describe, expect, it } from 'vitest'
import { createEncounterState } from '@/lib/game/encounters'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { buildProductSnapshot } from '@/lib/sync/product-snapshot'
import {
  beginAccountHydration,
  commitAccountHydration,
  createAccountNamespaceGate,
  invalidateAccountNamespace,
} from '@/lib/game/github-account-scope'
import { adoptUploadedSnapshot, isCurrentAccountActivation } from './GitHubSourcePanel'

describe('GitHubSourcePanel account activation guard', () => {
  it('accepts only the current action for the current hydrated account', () => {
    const started = beginAccountHydration(createAccountNamespaceGate(), 42)
    const committed = commitAccountHydration(started.gate, started.token)

    expect(committed.scope).not.toBeNull()
    expect(isCurrentAccountActivation(committed.gate, committed.scope!, 7, 7)).toBe(true)
  })

  it('rejects an activation continuation after the account generation changes', () => {
    const started = beginAccountHydration(createAccountNamespaceGate(), 42)
    const committed = commitAccountHydration(started.gate, started.token)
    const switched = beginAccountHydration(committed.gate, 99)

    expect(committed.scope).not.toBeNull()
    expect(isCurrentAccountActivation(switched.gate, committed.scope!, 7, 7)).toBe(false)
  })

  it('rejects an older activation when a newer action token exists', () => {
    const started = beginAccountHydration(createAccountNamespaceGate(), 42)
    const committed = commitAccountHydration(started.gate, started.token)
    const invalidated = invalidateAccountNamespace(committed.gate)

    expect(committed.scope).not.toBeNull()
    expect(isCurrentAccountActivation(invalidated, committed.scope!, 7, 8)).toBe(false)
  })

  it('keeps local encounter rewards when the server upload response omits them', () => {
    const now = '2026-09-23T10:00:00.000Z'
    const profile = createGuestProfile({ guestId: 'guest-upload', starterCompanionId: 'pikachu-family', now })
    const local = createProductState(
      {
        ...profile,
        collection: [...profile.collection, {
          referenceId: 'encounter:local:1',
          companionId: 'pikachu-family',
          acquiredAt: now,
          acquisition: 'encounter' as const,
        }],
      },
      { events: [] },
      {
        ...createEncounterState(),
        meter: 0,
        totalProgress: 100,
        nextSequence: 1,
        draws: [{
          id: 'guest:0:local',
          sequence: 0,
          triggerId: 'local-trigger',
          seed: 'local-seed',
          selectedCompanionId: 'pikachu-family',
          selectedFamilyId: 'pikachu-family',
          isDuplicate: true,
          essenceAwarded: 1,
          weights: [],
        }],
        processedTriggerIds: ['local-trigger'],
        essenceByFamily: { 'pikachu-family': 1 },
      },
      PROTOTYPE_COMPANION_CATALOG,
    )
    const serverProfile = createGuestProfile({ guestId: 'guest-upload', starterCompanionId: 'pikachu-family', now })
    const serverSnapshot = buildProductSnapshot(
      createProductState(serverProfile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
      now,
    )

    const restored = adoptUploadedSnapshot(
      JSON.parse(JSON.stringify(serverSnapshot)) as Record<string, unknown>,
      local.profile,
      'github-42',
      local,
    )

    expect(restored?.encounters.draws).toHaveLength(1)
    expect(restored?.encounters.essenceByFamily).toEqual({ 'pikachu-family': 1 })
    expect(restored?.profile.collection.some((reference) => reference.acquisition === 'encounter')).toBe(true)
  })
})
