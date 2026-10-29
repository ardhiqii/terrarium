/**
 * The migration is the part where a bug loses a user's companions, so the guarantees
 * from PRODUCT.md 4.4 are pinned here: collections union, XP and duplicates survive,
 * the active companion is kept when it still exists, and a profile that is already
 * the one in use is left alone.
 */

import { describe, expect, it } from 'vitest'
import { createGuestProfile, type GuestProfile } from './guest-profile'
import { planGuestMigration } from './guest-migration'

const NOW = '2026-10-08T00:00:00.000Z'

function profile(overrides: Partial<GuestProfile> = {}): GuestProfile {
  return {
    ...createGuestProfile({ guestId: 'guest-a', starterCompanionId: 'pikachu-family', now: NOW }),
    ...overrides,
  }
}

describe('nothing to do', () => {
  it('returns null when there is no guest profile', () => {
    expect(planGuestMigration(null, profile())).toBeNull()
  })

  it('returns null when both profiles are the same identity', () => {
    // The normal case for a browser that has only ever used one profile. Migrating here
    // would clear a key that is still in use.
    const one = profile({ guestId: 'same' })
    expect(planGuestMigration(one, profile({ guestId: 'same' }))).toBeNull()
  })

  it('still merges when the same identity holds progress the account has not seen', () => {
    // Signed out, played, signed back in: the account key adopted this guest id long ago, so
    // the two ids match while the guest copy carries a companion the account lacks. Treating
    // equal ids as "already migrated" threw that progress away.
    const account = profile({
      guestId: 'same',
      collection: [
        { referenceId: 'a1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
      ],
    })
    const guest = profile({
      guestId: 'same',
      collection: [
        { referenceId: 'a1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
        { referenceId: 'g2', companionId: 'ditto-like', acquiredAt: NOW, acquisition: 'encounter' },
      ],
    })

    const plan = planGuestMigration(guest, account)

    expect(plan).not.toBeNull()
    expect(plan?.profile.collection.map((entry) => entry.referenceId)).toEqual(['a1', 'g2'])
    expect(plan?.clearGuest).toBe(true)
  })

  it('treats an unopened egg the account lacks as progress worth merging', () => {
    const account = profile({ guestId: 'same', eggs: [] })
    const guest = profile({
      guestId: 'same',
      eggs: [{ drawId: 'g:0', companionId: 'ditto-like', laidAt: NOW }],
    })

    expect(planGuestMigration(guest, account)?.profile.eggs?.map((egg) => egg.drawId)).toEqual(['g:0'])
  })

  it('keeps a differing active companion instead of quietly dropping it', () => {
    // Same collection, different choice. The guest was the profile on screen a moment ago, so
    // its choice is the one the user expects after signing in.
    const shared = { referenceId: 'a1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' as const }
    const account = profile({ guestId: 'same', collection: [shared], activeCompanionId: 'pikachu-family' })
    const guest = profile({ guestId: 'same', collection: [shared], activeCompanionId: 'pikachu-family' })

    expect(planGuestMigration(guest, account)).toBeNull()

    const other = profile({
      guestId: 'same',
      collection: [shared, { referenceId: 'g2', companionId: 'ditto-like', acquiredAt: NOW, acquisition: 'encounter' }],
      activeCompanionId: 'ditto-like',
    })
    const plan = planGuestMigration(other, account)

    expect(plan?.profile.activeCompanionId).toBe('ditto-like')
    expect(plan?.activeCompanionChanged).toBe(true)
  })
})

describe('unions the collection', () => {
  it('keeps both sides, account first', () => {
    const account = profile({
      guestId: 'acct',
      collection: [
        { referenceId: 'a1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
      ],
    })
    const guest = profile({
      guestId: 'guest',
      collection: [
        { referenceId: 'g1', companionId: 'ditto-like', acquiredAt: NOW, acquisition: 'encounter' },
      ],
    })

    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.collection.map((c) => c.referenceId)).toEqual(['a1', 'g1'])
  })

  it('keeps two draws of the same species as two entries', () => {
    // Duplicates are what bank Essence. Folding them by species would silently delete
    // Essence the user had already earned.
    const account = profile({
      guestId: 'acct',
      collection: [
        { referenceId: 'a1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
      ],
    })
    const guest = profile({
      guestId: 'guest',
      collection: [
        { referenceId: 'g1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'encounter' },
      ],
    })

    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.collection).toHaveLength(2)
    expect(plan?.profile.collection.map((c) => c.companionId)).toEqual([
      'pikachu-family',
      'pikachu-family',
    ])
  })

  it('does not duplicate a reference present on both sides', () => {
    const shared = { referenceId: 'same', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' as const }
    const account = profile({ guestId: 'acct', collection: [shared] })
    const guest = profile({ guestId: 'guest', collection: [shared] })

    expect(planGuestMigration(guest, account)?.profile.collection).toHaveLength(1)
  })
})

describe('carries eggs and assignments', () => {
  it('keeps unopened eggs from both sides', () => {
    const account = profile({
      guestId: 'acct',
      eggs: [{ drawId: 'acct:0', companionId: 'pikachu-family', laidAt: NOW }],
    })
    const guest = profile({
      guestId: 'guest',
      eggs: [{ drawId: 'guest:0', companionId: 'ditto-like', laidAt: NOW }],
    })

    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.eggs?.map((e) => e.drawId)).toEqual(['acct:0', 'guest:0'])
  })

  it('keeps repository assignments from both sides', () => {
    const account = profile({
      guestId: 'acct',
      assignments: [
        { repositoryId: '1', referenceId: 'acct:starter', companionId: 'pikachu-family', assignedAt: NOW },
      ],
    })
    const guest = profile({
      guestId: 'guest',
      assignments: [
        { repositoryId: '2', referenceId: 'guest:starter', companionId: 'pikachu-family', assignedAt: NOW },
      ],
    })

    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.assignments).toHaveLength(2)
  })

  it('tolerates a profile written before eggs existed', () => {
    const account = profile({ guestId: 'acct', eggs: undefined, assignments: undefined })
    const guest = profile({ guestId: 'guest', eggs: undefined, assignments: undefined })
    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.eggs).toEqual([])
    expect(plan?.profile.assignments).toEqual([])
  })
})

describe('the active companion', () => {
  it('keeps the guest choice when it survived the union', () => {
    // The user was looking at the guest profile a moment ago, so that choice is the one
    // they expect to see after signing in.
    const account = profile({
      guestId: 'acct',
      collection: [
        { referenceId: 'a1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
      ],
    })
    const guest = profile({
      guestId: 'guest',
      activeCompanionId: 'ditto-like',
      collection: [
        { referenceId: 'g1', companionId: 'ditto-like', acquiredAt: NOW, acquisition: 'encounter' },
      ],
    })

    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.activeCompanionId).toBe('ditto-like')
    expect(plan?.activeCompanionChanged).toBe(true)
  })

  it('falls back to the account choice when the guest choice is gone', () => {
    const account = profile({
      guestId: 'acct',
      activeCompanionId: 'pikachu-family',
      collection: [
        { referenceId: 'a1', companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'starter' },
      ],
    })
    // A guest profile pointing at a companion that is not in either collection:
    // reachable from a hand-edited profile or a partial restore.
    const guest = profile({ guestId: 'guest', activeCompanionId: 'gone', collection: [] })

    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.activeCompanionId).toBe('pikachu-family')
    expect(plan?.activeCompanionChanged).toBe(false)
  })
})

describe('what the plan tells the caller to do', () => {
  it('adopts the guest identity so the merged copy can sync', () => {
    // The product route refuses an upload whose guest id does not match the row it is
    // writing to, so continuing the guest identity is what makes the merge uploadable.
    const plan = planGuestMigration(profile({ guestId: 'guest' }), profile({ guestId: 'acct' }))
    expect(plan?.profile.guestId).toBe('guest')
  })

  it('keeps the account baselines rather than the guest ones', () => {
    // Baselines are the "already counted" marks. Taking the guest's would re-baseline
    // the account's repositories and award their history a second time.
    const account = profile({
      guestId: 'acct',
      sourceBaselines: [
        { sourceId: 'vault:acct', kind: 'notes', fingerprint: 'acct-fp', observedAt: NOW, metrics: { noteCount: 5 } },
      ],
    })
    const guest = profile({
      guestId: 'guest',
      sourceBaselines: [
        { sourceId: 'vault:guest', kind: 'notes', fingerprint: 'guest-fp', observedAt: NOW, metrics: { noteCount: 9 } },
      ],
    })

    const plan = planGuestMigration(guest, account)
    expect(plan?.profile.sourceBaselines.map((b) => b.sourceId)).toEqual(['vault:acct'])
  })

  it('asks for the guest key to be cleared only after a real merge', () => {
    expect(planGuestMigration(profile({ guestId: 'guest' }), profile({ guestId: 'acct' }))?.clearGuest).toBe(true)
  })
})
