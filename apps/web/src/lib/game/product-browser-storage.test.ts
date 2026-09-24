import { describe, expect, it } from 'vitest'
import { createEncounterState } from './encounters'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { createGuestProfile } from './guest-profile'
import { createProductState } from './product-state'
import { buildProductSnapshot } from '../sync/product-snapshot'
import {
  DEFAULT_STORED_SYNC_SCHEDULE,
  browserProductStorage,
  loadGithubSyncRecovery,
  loadSyncRequestUsage,
  loadSyncScheduleState,
  loadVerifiedEventProofs,
  mergeVerifiedEventProofs,
  saveGithubSyncRecovery,
  saveSyncRequestUsage,
  saveSyncScheduleState,
  saveVerifiedEventProofs,
  type BrowserProductStorage,
  type StoredGithubSyncRecovery,
} from './product-browser-storage'

function storage(): BrowserProductStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function productSnapshot() {
  const now = '2026-09-23T10:00:00.000Z'
  const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now })
  return buildProductSnapshot(
    createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
    now,
  )
}

describe('browser GitHub receipt storage', () => {
  it('falls back to a session memory store when browser storage is unavailable', () => {
    const value = browserProductStorage()
    const key = `terrarium:test-storage-fallback:${Date.now()}`

    expect(() => value.setItem(key, 'recoverable')).not.toThrow()
    expect(value.getItem(key)).toBe('recoverable')
    expect(() => value.removeItem(key)).not.toThrow()
    expect(value.getItem(key)).toBeNull()
  })

  it('keeps only valid receipts for the current event set', () => {
    const value = storage()
    const eventId = 'event-12345678-abcdef12'

    saveVerifiedEventProofs(
      value,
      {
        [eventId]: 'receipt',
        'event-not-valid': 'discard-me',
        'event-12345678-deadbeef': 'discard-me-too',
      },
      [eventId],
      'github-42',
    )

    expect(loadVerifiedEventProofs(value, 'github-42')).toEqual({ [eventId]: 'receipt' })
    expect(loadVerifiedEventProofs(value, 'github-43')).toEqual({})
  })

  it('merges a repaired proof without erasing unrelated receipts', () => {
    const value = storage()
    const first = 'event-12345678-abcdef12'
    const second = 'event-12345678-deadbeef'

    saveVerifiedEventProofs(value, { [first]: 'old-first', [second]: 'old-second' }, undefined, 'github-42')
    mergeVerifiedEventProofs(value, { [first]: 'fresh-first' }, 'github-42')

    expect(loadVerifiedEventProofs(value, 'github-42')).toEqual({
      [first]: 'fresh-first',
      [second]: 'old-second',
    })
  })

  it('persists a bounded recovery snapshot and leaves it available after a failed upload', () => {
    const value = storage()
    const recovery: StoredGithubSyncRecovery = {
      snapshot: productSnapshot(),
      checkpoint: 'signed-checkpoint',
      failures: [{
        eventId: 'event-12345678-abcdef12',
        reason: 'receipt-mismatch',
        payloadDigest: '0123456789abcdef',
      }],
      blockedEventIds: ['event-12345678-abcdef12'],
      attemptedAt: '2026-09-23T10:05:00.000Z',
    }

    saveGithubSyncRecovery(value, recovery, 'github-42')
    expect(loadGithubSyncRecovery(value, 'github-42')).toEqual(recovery)
    expect(loadGithubSyncRecovery(value, 'github-43')).toBeNull()
  })

  it('fails closed for malformed stored data', () => {
    const value = storage()
    value.setItem('terrarium:github-event-proofs:github-42', '{bad json')

    expect(loadVerifiedEventProofs(value, 'github-42')).toEqual({})
  })

  it('round-trips the automatic-sync cadence per account namespace', () => {
    const value = storage()

    expect(loadSyncScheduleState(value, 'github-42')).toEqual(DEFAULT_STORED_SYNC_SCHEDULE)
    expect(DEFAULT_STORED_SYNC_SCHEDULE.interval).toBe('15')

    saveSyncScheduleState(value, { interval: '5', lastAttemptAt: 1_700_000_000_000 }, 'github-42')
    expect(loadSyncScheduleState(value, 'github-42')).toEqual({
      interval: '5',
      lastAttemptAt: 1_700_000_000_000,
    })
    expect(loadSyncScheduleState(value, 'github-43')).toEqual(DEFAULT_STORED_SYNC_SCHEDULE)
  })

  it('fails closed on an unknown schedule value and keeps the last attempt time', () => {
    const value = storage()
    value.setItem('terrarium:github-sync-schedule:github-42', JSON.stringify({
      interval: '2',
      lastAttemptAt: 5,
    }))
    expect(loadSyncScheduleState(value, 'github-42')).toEqual({ interval: '15', lastAttemptAt: 5 })

    value.setItem('terrarium:github-sync-schedule:github-42', 'not json')
    expect(loadSyncScheduleState(value, 'github-42')).toEqual(DEFAULT_STORED_SYNC_SCHEDULE)
  })

  it('keeps only the request usage inside the rolling hour window', () => {
    const value = storage()
    const now = 1_700_000_000_000
    saveSyncRequestUsage(
      value,
      [
        { at: now - 61 * 60 * 1000, requests: 900 },
        { at: now - 10 * 60 * 1000, requests: 800 },
        { at: now - 60 * 1000, requests: 25 },
      ],
      'github-42',
      now,
    )

    expect(loadSyncRequestUsage(value, 'github-42', now)).toEqual([
      { at: now - 10 * 60 * 1000, requests: 800 },
      { at: now - 60 * 1000, requests: 25 },
    ])
    expect(loadSyncRequestUsage(value, 'github-43', now)).toEqual([])
  })

  it('merges a peer tab\'s usage instead of erasing it', () => {
    // REGRESSION: two tabs share one browser profile. Each held its own whole
    // list and wrote it whole, so the second write erased the first tab's
    // spend and the account's real hourly total was undercounted -- each tab
    // still thought the full 4,000-request budget was free.
    const value = storage()
    const now = 1_700_000_000_000

    saveSyncRequestUsage(value, [{ at: now - 20 * 60 * 1000, requests: 800 }], 'github-42', now)
    const merged = saveSyncRequestUsage(value, [{ at: now - 60 * 1000, requests: 250 }], 'github-42', now)

    expect(merged).toEqual([
      { at: now - 20 * 60 * 1000, requests: 800 },
      { at: now - 60 * 1000, requests: 250 },
    ])
    expect(loadSyncRequestUsage(value, 'github-42', now)).toHaveLength(2)
  })

  it('does not throw when browser storage refuses a write', () => {
    // REGRESSION: these writes sit in the sync panel's `finally` block. In
    // Safari private mode or on a full quota a refused write used to throw out
    // of that block, leaving the panel busy forever and the scheduler blocked
    // on a dead abort controller, with the rejection unhandled.
    const hostile: BrowserProductStorage = {
      getItem: () => { throw new Error('storage is unavailable') },
      setItem: () => { throw new Error('quota exceeded') },
      removeItem: () => { throw new Error('storage is unavailable') },
    }

    expect(() => saveSyncScheduleState(hostile, { interval: '15', lastAttemptAt: 1 })).not.toThrow()
    expect(() => saveSyncRequestUsage(hostile, [{ at: 1, requests: 10 }], 'github-42', 1)).not.toThrow()
    // The merged in-memory record survives the refused write.
    expect(saveSyncRequestUsage(hostile, [{ at: 1, requests: 10 }], 'github-42', 1))
      .toEqual([{ at: 1, requests: 10 }])
  })
})
