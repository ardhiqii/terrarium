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
