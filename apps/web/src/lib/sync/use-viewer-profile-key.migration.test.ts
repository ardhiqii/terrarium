/**
 * The guest import performs two writes: the merged profile under the account key, then
 * the removal of the guest key. Anything can happen between them.
 *
 * WHY THIS FILE EXISTS: `guest-migration.test.ts` covers the pure planner, and the
 * caller was covered only by grepping its source for function names. That left the one
 * failure that loses a user's visible progress untested — a run that writes the account
 * copy and then dies before the cleanup. The next run sees two profiles with the SAME
 * guest id, the planner correctly returns null, and a caller that treats null as "nothing
 * to do" never finishes the job. Two live profiles survive, and the next sign-out reads
 * the stale one, which is the exact bug `guest-migration.ts` was written to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GUEST_PROFILE_STORAGE_KEY, createGuestProfile, loadGuestProfile, saveGuestProfile } from '@/lib/game/guest-profile'
import type { GuestProfileStorage } from '@/lib/game/guest-profile'

const ACCOUNT_KEY = 'terrarium:guest-profile:github-123'
const NOW = '2026-10-08T00:00:00.000Z'

interface FakeStorage extends GuestProfileStorage {
  /** Fail the next `removeItem`, the way a quota or privacy error would. */
  failRemoveOnce(): void
  readonly map: Map<string, string>
}

function fakeStorage(): FakeStorage {
  const map = new Map<string, string>()
  let failNextRemove = false
  return {
    map,
    failRemoveOnce: () => {
      failNextRemove = true
    },
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      if (failNextRemove) {
        failNextRemove = false
        throw new Error('storage refused the removal')
      }
      map.delete(key)
    },
  }
}

describe('migrating a guest profile into an account', () => {
  let storage: FakeStorage

  beforeEach(() => {
    vi.resetModules()
    storage = fakeStorage()
    // The module reads `window` lazily inside each call, so a bare stub is enough and
    // no DOM is needed.
    vi.stubGlobal('window', {
      localStorage: storage,
      dispatchEvent: () => true,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears the guest key when the first attempt wrote the profile but could not clean up', async () => {
    const guest = createGuestProfile({ guestId: 'guest-a', starterCompanionId: 'pikachu-family', now: NOW })
    const account = createGuestProfile({ guestId: 'acct-b', starterCompanionId: 'ditto-like', now: NOW })
    saveGuestProfile(storage, guest, GUEST_PROFILE_STORAGE_KEY)
    saveGuestProfile(storage, account, ACCOUNT_KEY)
    storage.failRemoveOnce()

    const { migrateGuestProfileIntoAccount } = await import('./use-viewer-profile-key')

    migrateGuestProfileIntoAccount(ACCOUNT_KEY)
    // The write landed and the cleanup did not: the half-migrated state.
    expect(storage.map.has(GUEST_PROFILE_STORAGE_KEY)).toBe(true)
    expect(loadGuestProfile(storage, ACCOUNT_KEY)?.guestId).toBe('guest-a')

    migrateGuestProfileIntoAccount(ACCOUNT_KEY)

    // The second run sees the same identity and must still finish the cleanup.
    expect(storage.map.has(GUEST_PROFILE_STORAGE_KEY)).toBe(false)
    expect(loadGuestProfile(storage, ACCOUNT_KEY)?.guestId).toBe('guest-a')
  })

  it('leaves the guest key alone when the account write could not happen at all', async () => {
    const guest = createGuestProfile({ guestId: 'guest-a', starterCompanionId: 'pikachu-family', now: NOW })
    const account = createGuestProfile({ guestId: 'acct-b', starterCompanionId: 'ditto-like', now: NOW })
    saveGuestProfile(storage, guest, GUEST_PROFILE_STORAGE_KEY)
    saveGuestProfile(storage, account, ACCOUNT_KEY)
    // Every write fails, so nothing can be imported: the guest copy must survive.
    storage.setItem = () => {
      throw new Error('storage is full')
    }

    const { migrateGuestProfileIntoAccount } = await import('./use-viewer-profile-key')
    migrateGuestProfileIntoAccount(ACCOUNT_KEY)

    expect(storage.map.has(GUEST_PROFILE_STORAGE_KEY)).toBe(true)
  })

  it('does nothing while signed out', async () => {
    const guest = createGuestProfile({ guestId: 'guest-a', starterCompanionId: 'pikachu-family', now: NOW })
    saveGuestProfile(storage, guest, GUEST_PROFILE_STORAGE_KEY)

    const { migrateGuestProfileIntoAccount } = await import('./use-viewer-profile-key')
    migrateGuestProfileIntoAccount(GUEST_PROFILE_STORAGE_KEY)

    expect(storage.map.has(GUEST_PROFILE_STORAGE_KEY)).toBe(true)
  })
})
