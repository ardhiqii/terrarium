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
})
