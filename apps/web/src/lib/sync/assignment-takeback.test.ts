/**
 * REGRESSION: a take-back must survive the next sync.
 *
 * The dressing is a LIST, and a release is the absence of an entry. The sync
 * merged the two sides by union, which cannot represent an absence: release a
 * repository on `/repos`, then sync from `/github`, and the assignment came back.
 * The route that pushes dressing also replaces the whole list, so a lost update
 * there resurrects the entry the same way.
 *
 * The fix is a stamp: whichever side replaced the list last wins it whole, and
 * only equal (or missing) stamps fall back to the union that older snapshots need.
 */

import { describe, expect, it } from 'vitest'
import { buildProductSnapshot, mergeGuestWithServer, type ProductSnapshot } from './product-snapshot'
import { createGuestProfile, type GuestProfile } from '../game/guest-profile'
import { createProductState } from '../game/product-state'
import { PROTOTYPE_COMPANION_CATALOG } from '../game/companion-catalog'
import { assignCompanion, releaseRepository } from '../game/repo-assignments'

const T0 = '2026-11-01T00:00:00.000Z'
const T1 = '2026-11-02T00:00:00.000Z'
const T2 = '2026-11-03T00:00:00.000Z'

function profileWithTwoCompanions(): GuestProfile {
  const base = createGuestProfile({ guestId: 'guest-takeback', starterCompanionId: 'pikachu-family', now: T0 })
  return {
    ...base,
    collection: [
      ...base.collection,
      { referenceId: 'guest-takeback:ref-2', companionId: 'bulbasaur-family', acquiredAt: T0, acquisition: 'encounter' },
    ],
  } as GuestProfile
}

function snapshotOf(profile: GuestProfile): ProductSnapshot {
  return buildProductSnapshot(createProductState(profile, { events: [] }, undefined, PROTOTYPE_COMPANION_CATALOG))
}

describe('a released repository stays released', () => {
  it('the newer stamp takes the whole list instead of unioning the release away', () => {
    const base = profileWithTwoCompanions()
    const referenceId = `${base.guestId}:starter`

    const dressed = assignCompanion(base, '555', referenceId, T1)
    expect(dressed.ok).toBe(true)
    if (!dressed.ok) return
    expect(dressed.profile.assignmentsUpdatedAt).toBe(T1)

    const beforeRelease = snapshotOf(dressed.profile)
    expect(beforeRelease.assignments).toHaveLength(1)

    const released = releaseRepository(dressed.profile, '555', T2)
    expect(released.assignments ?? []).toHaveLength(0)
    expect(released.assignmentsUpdatedAt).toBe(T2)

    const merged = mergeGuestWithServer(snapshotOf(released), beforeRelease)
    expect(merged.assignments ?? []).toHaveLength(0)
  })

  it('still unions two sides that were written before the stamp existed', () => {
    const base = profileWithTwoCompanions()
    const dressed = assignCompanion(base, '555', `${base.guestId}:starter`, T1)
    if (!dressed.ok) return
    const { assignmentsUpdatedAt: _dropped, ...legacy } = snapshotOf(dressed.profile)

    const merged = mergeGuestWithServer(snapshotOf(dressed.profile), legacy as ProductSnapshot)
    expect((merged.assignments ?? []).map((entry) => entry.repositoryId)).toEqual(['555'])
  })

  it('does not invent a stamp for a profile that never dressed anything', () => {
    expect(snapshotOf(profileWithTwoCompanions()).assignmentsUpdatedAt).toBeUndefined()
  })
})
