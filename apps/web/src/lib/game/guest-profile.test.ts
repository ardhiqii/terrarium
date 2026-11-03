import { describe, expect, it } from 'vitest'
import {
  GUEST_PROFILE_SCHEMA_VERSION,
  GUEST_PROFILE_STORAGE_KEY,
  InMemoryGuestProfileStorage,
  clearGuestProfile,
  createGuestProfile,
  deserializeGuestProfile,
  loadGuestProfile,
  saveGuestProfile,
  serializeGuestProfile,
  activeCollectionReference,
  activeReferenceIdOf,
  collapseDuplicateStarters,
  type GuestProfile,
} from './guest-profile'
import { createCareState } from './care/state'

const now = '2026-08-28T09:00:00.000Z'

function profile(): GuestProfile {
  return {
    ...createGuestProfile({
      guestId: 'guest-123',
      starterCompanionId: 'pikachu-default',
      now,
    }),
    updatedAt: '2026-08-28T10:00:00.000Z',
    sourceBaselines: [
      {
        sourceId: 'vault:main',
        kind: 'notes',
        fingerprint: 'sha256:vault-snapshot',
        observedAt: '2026-08-28T10:00:00.000Z',
        metrics: { noteCount: 12, totalWords: 2400, resolvedWikilinks: 9 },
      },
      {
        sourceId: 'github:octo/repo',
        kind: 'github',
        fingerprint: 'commit:abc123',
        observedAt: '2026-08-28T10:00:00.000Z',
        metrics: { commits: 4, mergedPullRequests: 1 },
      },
    ],
    collection: [
      ...createGuestProfile({
        guestId: 'guest-123',
        starterCompanionId: 'pikachu-default',
        now,
      }).collection,
      {
        referenceId: 'encounter-1',
        companionId: 'ditto-default',
        acquiredAt: '2026-08-28T09:30:00.000Z',
        acquisition: 'encounter',
      },
      {
        referenceId: 'encounter-2',
        companionId: 'ditto-default',
        acquiredAt: '2026-08-28T09:45:00.000Z',
        acquisition: 'encounter',
      },
    ],
    recoverabilityWarning: {
      status: 'shown',
      lastShownAt: '2026-08-28T09:05:00.000Z',
      dismissedAt: null,
      updatedAt: '2026-08-28T09:05:00.000Z',
    },
  }
}

describe('guest profile', () => {
  it('creates a fresh guest with an immediate starter companion', () => {
    const created = createGuestProfile({
      guestId: 'guest-1',
      starterCompanionId: 'starter-pikachu',
      now,
    })

    expect(created.schemaVersion).toBe(GUEST_PROFILE_SCHEMA_VERSION)
    expect(created.activeCompanionId).toBe('starter-pikachu')
    expect(created.collection).toEqual([
      {
        referenceId: 'guest-1:starter',
        companionId: 'starter-pikachu',
        acquiredAt: now,
        acquisition: 'starter',
      },
    ])
    expect(created.sourceBaselines).toEqual([])
    expect(created.recoverabilityWarning.status).toBe('unseen')
  })

  it('round-trips source baselines, active companion, collection, and warning state', () => {
    const original = profile()
    const restored = deserializeGuestProfile(serializeGuestProfile(original))

    expect(restored).toEqual(original)
  })

  it('permits duplicate companion references while requiring unique reference IDs', () => {
    const original = profile()
    const restored = deserializeGuestProfile(serializeGuestProfile(original))

    expect(restored?.collection.filter((item) => item.companionId === 'ditto-default')).toHaveLength(2)
  })

  it('persists and loads through the in-memory adapter without browser globals', () => {
    const storage = new InMemoryGuestProfileStorage()
    const original = profile()

    saveGuestProfile(storage, original)

    expect(storage.getItem(GUEST_PROFILE_STORAGE_KEY)).toContain('guest-123')
    expect(loadGuestProfile(storage)).toEqual(original)

    clearGuestProfile(storage)
    expect(loadGuestProfile(storage)).toBeNull()
  })

  it('supports a caller-provided storage key', () => {
    const storage = new InMemoryGuestProfileStorage()
    const original = profile()

    saveGuestProfile(storage, original, 'test:guest')

    expect(loadGuestProfile(storage, 'test:guest')).toEqual(original)
    expect(loadGuestProfile(storage)).toBeNull()
  })

  it('migrates a profile saved under the previous product name', () => {
    const storage = new InMemoryGuestProfileStorage()
    const original = profile()

    storage.setItem('digital-garden:guest-profile', serializeGuestProfile(original))

    expect(loadGuestProfile(storage)).toEqual(original)
    expect(storage.getItem(GUEST_PROFILE_STORAGE_KEY)).toBe(serializeGuestProfile(original))
  })

  it('returns null for malformed, unsupported, or unsafe persisted data', () => {
    expect(deserializeGuestProfile('{not-json')).toBeNull()
    expect(deserializeGuestProfile(JSON.stringify({ schemaVersion: 99 }))).toBeNull()
    expect(deserializeGuestProfile(JSON.stringify({ ...profile(), activeCompanionId: '' }))).toBeNull()
    expect(
      deserializeGuestProfile(
        JSON.stringify({
          ...profile(),
          sourceBaselines: [
            {
              ...profile().sourceBaselines[0],
              metrics: { totalWords: Number.NaN },
            },
          ],
        })
      )
    ).toBeNull()
  })

  it('rejects duplicate source and collection reference IDs when writing', () => {
    const duplicateSource = profile()
    duplicateSource.sourceBaselines = [
      ...duplicateSource.sourceBaselines,
      duplicateSource.sourceBaselines[0],
    ]
    expect(() => serializeGuestProfile(duplicateSource)).toThrow()

    const duplicateReference = profile()
    duplicateReference.collection = [
      ...duplicateReference.collection,
      duplicateReference.collection[0],
    ]
    expect(() => serializeGuestProfile(duplicateReference)).toThrow()
  })

  it('drops a corrupt condition layer instead of the whole profile', () => {
    // The care layer is optional and entirely recoverable; the profile around it
    // is not. Letting a bad care counter throw here made deserialization return
    // null, which the runtime answers by minting a new guest — XP, stage and
    // collection gone because one number was negative.
    const corrupted = {
      ...profile(),
      care: {
        ...createCareState(now),
        spent: { food: -5, treat: 0, medicine: 0, toy: 0, soap: 0 },
      },
    }
    const restored = deserializeGuestProfile(JSON.stringify(corrupted))
    expect(restored).not.toBeNull()
    expect(restored?.guestId).toBe('guest-123')
    expect(restored?.collection).toHaveLength(profile().collection.length)
    expect(restored?.care).toBeUndefined()
  })
})

describe('which companion is active', () => {
  const now = '2026-08-28T09:00:00.000Z'

  /** Two Pikachu acquisitions, the shape that produced the double-active bug. */
  function twoPikachu(): GuestProfile {
    return {
      ...createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now }),
      collection: [
        { referenceId: 'guest-1:starter', companionId: 'pikachu-family', acquiredAt: now, acquisition: 'starter' },
        { referenceId: 'guest-2:starter', companionId: 'pikachu-family', acquiredAt: now, acquisition: 'starter' },
      ],
    }
  }

  it('starts pointing at the starter acquisition, not just the species', () => {
    const created = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now })
    expect(created.activeCompanionId).toBe('pikachu-family')
    expect(created.activeReferenceId).toBe('guest-1:starter')
  })

  it('resolves exactly one of two same-species entries', () => {
    const profile = twoPikachu()
    const pointed = { ...profile, activeReferenceId: 'guest-2:starter' }
    expect(activeCollectionReference(pointed)?.referenceId).toBe('guest-2:starter')
    // The other Pikachu must NOT resolve as active.
    expect(activeReferenceIdOf(pointed)).not.toBe('guest-1:starter')
  })

  it('falls back to the first entry of the active species for older profiles', () => {
    const profile = twoPikachu()
    // No activeReferenceId: every profile written before the field existed.
    expect(activeCollectionReference(profile)?.referenceId).toBe('guest-1:starter')
  })

  it('falls back when the pointer names an entry that no longer exists', () => {
    const profile = { ...twoPikachu(), activeReferenceId: 'guest-9:starter' }
    expect(activeCollectionReference(profile)?.referenceId).toBe('guest-1:starter')
  })

  it('survives serialization round-trip', () => {
    const profile = { ...twoPikachu(), activeReferenceId: 'guest-2:starter' }
    const restored = deserializeGuestProfile(serializeGuestProfile(profile))
    expect(restored?.activeReferenceId).toBe('guest-2:starter')
  })
})

describe('collapsing duplicate starters', () => {
  const now = '2026-08-28T09:00:00.000Z'
  const later = '2026-08-29T09:00:00.000Z'

  function withStarters(
    entries: GuestProfile['collection'],
    overrides: Partial<GuestProfile> = {},
  ): GuestProfile {
    return {
      ...createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now }),
      // Cleared by default: `createGuestProfile` points at guest-1's starter, and
      // every test here is about what happens without an explicit choice.
      activeReferenceId: undefined,
      collection: entries,
      ...overrides,
    }
  }

  const dittoStarter = {
    referenceId: 'guest-1:starter',
    companionId: 'pikachu-family',
    acquiredAt: later,
    acquisition: 'starter' as const,
  }
  const guestStarter = {
    referenceId: 'guest-2:starter',
    companionId: 'pikachu-family',
    acquiredAt: now,
    acquisition: 'starter' as const,
  }

  it('folds two starters of one species into one entry', () => {
    const collapsed = collapseDuplicateStarters(withStarters([dittoStarter, guestStarter]), now)
    expect(collapsed.collection).toHaveLength(1)
    // Ties are broken by acquisition time, so the older grant survives.
    expect(collapsed.collection[0].referenceId).toBe('guest-2:starter')
  })

  it('keeps the one the user made active, even when it is newer', () => {
    const collapsed = collapseDuplicateStarters(
      withStarters([dittoStarter, guestStarter], { activeReferenceId: 'guest-1:starter' }),
      now,
    )
    expect(collapsed.collection.map((entry) => entry.referenceId)).toEqual(['guest-1:starter'])
    expect(collapsed.activeReferenceId).toBe('guest-1:starter')
  })

  it('remaps a pointer that named the folded-away entry', () => {
    const collapsed = collapseDuplicateStarters(
      withStarters([dittoStarter, guestStarter], { activeReferenceId: 'guest-2:starter' }),
      now,
    )
    expect(collapsed.activeReferenceId).toBe('guest-2:starter')
    expect(collapsed.collection[0].referenceId).toBe('guest-2:starter')
  })

  it('keeps an assigned starter over an unassigned one, and remaps its assignment', () => {
    const profile = withStarters([dittoStarter, guestStarter], {
      // The assigned entry is the one that would otherwise be folded away.
      assignments: [
        {
          repositoryId: '42',
          referenceId: 'guest-1:starter',
          companionId: 'pikachu-family',
          assignedAt: now,
        },
      ],
    })
    const collapsed = collapseDuplicateStarters(profile, now)
    expect(collapsed.collection.map((entry) => entry.referenceId)).toEqual(['guest-1:starter'])
    expect(collapsed.assignments?.[0].referenceId).toBe('guest-1:starter')
  })

  it('releases one repository rather than double-booking the keeper', () => {
    const profile = withStarters([dittoStarter, guestStarter], {
      assignments: [
        { repositoryId: '42', referenceId: 'guest-1:starter', companionId: 'pikachu-family', assignedAt: now },
        { repositoryId: '43', referenceId: 'guest-2:starter', companionId: 'pikachu-family', assignedAt: now },
      ],
    })
    const collapsed = collapseDuplicateStarters(profile, now)
    expect(collapsed.collection).toHaveLength(1)
    // One companion dresses one repository: the second dressing is released, and
    // the profile still validates.
    expect(collapsed.assignments).toHaveLength(1)
    expect(() => serializeGuestProfile(collapsed)).not.toThrow()
  })

  it('leaves a single starter and other acquisitions alone, returning the same object', () => {
    const profile = withStarters([
      dittoStarter,
      { referenceId: 'enc-1', companionId: 'ditto-like', acquiredAt: now, acquisition: 'encounter' },
    ])
    expect(collapseDuplicateStarters(profile, now)).toBe(profile)
  })

  it('is idempotent', () => {
    const once = collapseDuplicateStarters(withStarters([dittoStarter, guestStarter]), now)
    expect(collapseDuplicateStarters(once, later)).toBe(once)
  })

  it('does not fold two starters of different species', () => {
    const profile = withStarters([
      dittoStarter,
      { referenceId: 'guest-2:starter', companionId: 'ditto-like', acquiredAt: now, acquisition: 'starter' },
    ])
    expect(collapseDuplicateStarters(profile, now).collection).toHaveLength(2)
  })
})
