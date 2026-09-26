import { describe, expect, it } from 'vitest'
import {
  adoptAccountGuestIdentity,
  canRunGuestIdentityAction,
  describeGuestIdentityConflict,
  describeGuestIdentitySide,
  GUEST_IDENTITY_CONFLICT_ERROR,
  guestIdentityActionPlan,
  guestIdentityActionSummary,
  isGuestIdentityConflict,
  summarizeGuestSnapshot,
  type GuestIdentityConflictAction,
  type GuestIdentityConflictView,
  type GuestIdentitySideSummary,
} from './guest-identity-conflict'
import { asCompanionId, asEventId, type NormalizedEvent } from './events'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { createEncounterState } from './encounters'
import { createGuestProfile } from './guest-profile'
import { createProductState } from './product-state'
import { buildProductSnapshot, mergeProductSnapshots } from '../sync/product-snapshot'

function side(values: Partial<GuestIdentitySideSummary> & { guestId: string }): GuestIdentitySideSummary {
  return {
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
    eventCount: 18,
    companionCount: 1,
    collectionCount: 1,
    baselineCount: 0,
    totalXp: 620,
    totalEssence: 0,
    isBlank: false,
    ...values,
  }
}

const LOCAL = side({ guestId: 'guest-1413a934-2b44-4a2b-ae83-dff5f3427f36' })
const CLOUD = side({ guestId: 'guest-3e0b3494-459a-4fac-82db-95ec2bcb7278', eventCount: 0, totalXp: 0, isBlank: true })

function planFor(view: GuestIdentityConflictView, action: GuestIdentityConflictAction) {
  const plan = guestIdentityActionPlan(view, action)
  if (!plan) throw new Error(`missing plan for ${action}`)
  return plan
}

describe('isGuestIdentityConflict', () => {
  it('recognises the identity guard only on a 409 with its exact refusal text', () => {
    expect(isGuestIdentityConflict(409, { error: GUEST_IDENTITY_CONFLICT_ERROR })).toBe(true)
    expect(isGuestIdentityConflict(409, { error: ` ${GUEST_IDENTITY_CONFLICT_ERROR} ` })).toBe(true)
  })

  it('never treats another 409 as an identity choice', () => {
    expect(isGuestIdentityConflict(409, {
      error: 'GitHub activity changed while this condition was being saved. Sync again.',
    })).toBe(false)
    expect(isGuestIdentityConflict(409, {
      error: 'This condition changed on another device. Sync again to merge the latest state.',
    })).toBe(false)
    expect(isGuestIdentityConflict(409, { error: 'Sync checkpoint events are missing from the product snapshot.' })).toBe(false)
  })

  it('never fires on a non-409 even when the text matches', () => {
    expect(isGuestIdentityConflict(200, { error: GUEST_IDENTITY_CONFLICT_ERROR })).toBe(false)
    expect(isGuestIdentityConflict(500, { error: GUEST_IDENTITY_CONFLICT_ERROR })).toBe(false)
  })

  it('fails closed for missing, empty, or non-object bodies', () => {
    expect(isGuestIdentityConflict(409, {})).toBe(false)
    expect(isGuestIdentityConflict(409, { error: 42 })).toBe(false)
    expect(isGuestIdentityConflict(409, null)).toBe(false)
    expect(isGuestIdentityConflict(409, 'different guest profile')).toBe(false)
  })
})

describe('summarizeGuestSnapshot', () => {
  it('reads event, companion, XP, essence, and created date from a real snapshot', () => {
    const now = '2026-08-28T10:00:00.000Z'
    const starter = PROTOTYPE_COMPANION_CATALOG.list()[0].id
    const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: starter, now })
    const events: NormalizedEvent[] = ['event-a', 'event-b'].map((eventId) => ({
      eventId: asEventId(eventId),
      companionId: asCompanionId(starter),
      source: 'github',
      sourceId: 'github-sync',
      provenance: 'local',
      category: 'work-session',
      occurredAt: now,
    }))
    const snapshot = buildProductSnapshot(
      createProductState(profile, { events }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
      now,
    )

    const summary = summarizeGuestSnapshot(snapshot)
    expect(summary).not.toBeNull()
    expect(summary?.guestId).toBe('guest-1')
    expect(summary?.eventCount).toBe(2)
    expect(summary?.companionCount).toBe(1)
    expect(summary?.collectionCount).toBe(1)
    expect(summary?.createdAt).toBe(now)
    expect(summary?.totalXp).toBeGreaterThan(0)
    expect(summary?.isBlank).toBe(false)
  })

  it('calls a starter-only snapshot empty even though it holds one companion', () => {
    const now = '2026-08-28T10:00:00.000Z'
    const starter = PROTOTYPE_COMPANION_CATALOG.list()[0].id
    const snapshot = buildProductSnapshot(
      createProductState(
        createGuestProfile({ guestId: 'guest-empty', starterCompanionId: starter, now }),
        { events: [] },
        createEncounterState(),
        PROTOTYPE_COMPANION_CATALOG,
      ),
      now,
    )

    const summary = summarizeGuestSnapshot(snapshot)
    expect(summary?.isBlank).toBe(true)
    expect(summary?.eventCount).toBe(0)
    expect(summary?.collectionCount).toBe(1)
    expect(summary?.totalXp).toBe(0)
  })

  it('does not call a side empty when it carries XP, baselines, or extra companions', () => {
    expect(summarizeGuestSnapshot({ guestId: 'guest-x', events: [], collection: [], companions: [{ xp: 10 }] })?.isBlank).toBe(false)
    expect(summarizeGuestSnapshot({ guestId: 'guest-x', events: [], collection: [], sourceBaselines: [{ sourceIdHash: 'a' }] })?.isBlank).toBe(false)
    expect(summarizeGuestSnapshot({ guestId: 'guest-x', events: [], collection: [{}, {}] })?.isBlank).toBe(false)
  })

  it('returns null for anything without an identity', () => {
    expect(summarizeGuestSnapshot(null)).toBeNull()
    expect(summarizeGuestSnapshot('guest-1')).toBeNull()
    expect(summarizeGuestSnapshot([])).toBeNull()
    expect(summarizeGuestSnapshot({})).toBeNull()
    expect(summarizeGuestSnapshot({ guestId: '   ' })).toBeNull()
  })

  it('drops an unparseable created date instead of showing Invalid Date', () => {
    const summary = summarizeGuestSnapshot({ guestId: 'guest-x', createdAt: 'not-a-date' })
    expect(summary?.createdAt).toBeNull()
    expect(describeGuestIdentitySide(summary!).createdAt).toBeNull()
  })
})

describe('describeGuestIdentityConflict', () => {
  it('frames two non-empty sides under different identities and recommends keeping both', () => {
    const view = describeGuestIdentityConflict(LOCAL, side({ guestId: 'guest-other' }))

    expect(view.sameIdentity).toBe(false)
    expect(view.cloudAvailable).toBe(true)
    expect(view.emptySides).toEqual([])
    expect(view.bothSidesHoldProgress).toBe(true)
    expect(view.headline).toContain('each hold their own progress')
    expect(planFor(view, 'keep-both').recommended).toBe(true)
    expect(planFor(view, 'keep-both').requiresConfirmation).toBe(false)
    expect(planFor(view, 'keep-both').destructive).toBe(false)
    expect(planFor(view, 'keep-both').available).toBe(true)
  })

  it('describes each action with the copy it discards and the identity it adopts', () => {
    const view = describeGuestIdentityConflict(LOCAL, side({ guestId: 'guest-other' }))

    const keepBoth = planFor(view, 'keep-both')
    expect(keepBoth.adoptsAccountIdentity).toBe(true)
    expect(keepBoth.discardsCloudSnapshot).toBe(false)
    expect(keepBoth.replacesLocalProgress).toBe(false)

    const useBrowser = planFor(view, 'use-browser')
    expect(useBrowser.destructive).toBe(true)
    expect(useBrowser.requiresConfirmation).toBe(true)
    expect(useBrowser.adoptsAccountIdentity).toBe(false)
    expect(useBrowser.discardsCloudSnapshot).toBe(true)
    expect(useBrowser.replacesLocalProgress).toBe(false)

    const useAccount = planFor(view, 'use-account')
    expect(useAccount.destructive).toBe(true)
    expect(useAccount.requiresConfirmation).toBe(true)
    expect(useAccount.adoptsAccountIdentity).toBe(true)
    expect(useAccount.discardsCloudSnapshot).toBe(false)
    expect(useAccount.replacesLocalProgress).toBe(true)

    for (const plan of view.actions) expect(plan.reuploads).toBe(true)
  })

  it('phrases the same-identity case without treating it as a fresh conflict', () => {
    const view = describeGuestIdentityConflict(LOCAL, side({ guestId: LOCAL.guestId }))

    expect(view.sameIdentity).toBe(true)
    expect(view.bothSidesHoldProgress).toBe(true)
    expect(view.headline).toContain('now share one identity')
    expect(view.headline).toContain('The earlier upload was refused')
  })

  it('names the empty side when only the browser copy is empty', () => {
    const view = describeGuestIdentityConflict(side({ guestId: 'guest-new', eventCount: 0, totalXp: 0, isBlank: true }), side({ guestId: 'guest-cloud' }))

    expect(view.emptySides).toEqual(['local'])
    expect(view.bothSidesHoldProgress).toBe(false)
    expect(view.headline).toContain('This browser holds no progress yet')
    // Nothing local to lose, so following the account needs no confirm step.
    expect(planFor(view, 'use-account').destructive).toBe(false)
    expect(planFor(view, 'use-account').requiresConfirmation).toBe(false)
    expect(planFor(view, 'use-account').available).toBe(true)
  })

  it('names the empty side when only the cloud copy is empty', () => {
    const view = describeGuestIdentityConflict(LOCAL, CLOUD)

    expect(view.emptySides).toEqual(['cloud'])
    expect(view.bothSidesHoldProgress).toBe(false)
    expect(view.headline).toContain("the account's cloud copy is empty")
    expect(planFor(view, 'keep-both').available).toBe(true)
  })

  it('names both empty sides when neither copy holds progress', () => {
    const blank = side({ guestId: 'guest-a', eventCount: 0, totalXp: 0, isBlank: true })
    const view = describeGuestIdentityConflict(blank, side({ guestId: 'guest-b', eventCount: 0, totalXp: 0, isBlank: true }))

    expect(view.emptySides).toEqual(['local', 'cloud'])
    expect(view.headline).toContain('Both copies hold no progress')
  })

  it('keeps the identity actions unavailable when the cloud copy cannot be read', () => {
    const view = describeGuestIdentityConflict(LOCAL, null)

    expect(view.cloudAvailable).toBe(false)
    expect(view.sameIdentity).toBe(false)
    expect(view.cloud).toBeNull()
    expect(view.headline).toContain('could not be read')
    // Only the action that does not need the cloud identity stays available.
    expect(planFor(view, 'keep-both').available).toBe(false)
    expect(planFor(view, 'use-account').available).toBe(false)
    expect(planFor(view, 'use-browser').available).toBe(true)
  })
})

describe('canRunGuestIdentityAction', () => {
  const view = describeGuestIdentityConflict(LOCAL, side({ guestId: 'guest-other' }))

  it('refuses the destructive action until the confirm step has happened', () => {
    expect(canRunGuestIdentityAction(view, 'use-browser', false)).toBe(false)
    expect(canRunGuestIdentityAction(view, 'use-browser', true)).toBe(true)
  })

  it('requires a confirm before local progress is replaced by the account copy', () => {
    expect(canRunGuestIdentityAction(view, 'use-account', false)).toBe(false)
    expect(canRunGuestIdentityAction(view, 'use-account', true)).toBe(true)

    const blankLocal = describeGuestIdentityConflict(
      side({ guestId: 'guest-new', eventCount: 0, totalXp: 0, isBlank: true }),
      CLOUD,
    )
    expect(canRunGuestIdentityAction(blankLocal, 'use-account', false)).toBe(true)
  })

  it('lets the non-destructive recommendation run from one click', () => {
    expect(canRunGuestIdentityAction(view, 'keep-both', false)).toBe(true)
  })

  it('refuses an action whose side is unreadable even with confirmation', () => {
    const unavailable = describeGuestIdentityConflict(LOCAL, null)
    expect(canRunGuestIdentityAction(unavailable, 'keep-both', true)).toBe(false)
    expect(canRunGuestIdentityAction(unavailable, 'use-account', true)).toBe(false)
    expect(canRunGuestIdentityAction(unavailable, 'use-browser', true)).toBe(true)
  })

  it('refuses an action that does not exist', () => {
    expect(canRunGuestIdentityAction(view, 'wipe-everything' as GuestIdentityConflictAction, true)).toBe(false)
    expect(guestIdentityActionPlan(view, 'wipe-everything' as GuestIdentityConflictAction)).toBeNull()
  })
})

describe('describeGuestIdentitySide', () => {
  it('pluralises counts and shortens the identity', () => {
    const description = describeGuestIdentitySide(side({ guestId: 'guest-1234567890abcdef', eventCount: 1, companionCount: 1 }))
    expect(description.events).toBe('1 event')
    expect(description.companions).toBe('1 companion')
    expect(description.xp).toBe('620 XP')
    expect(description.guestIdShort).toBe('…567890abcdef')
  })

  it('keeps a short identity whole and marks an empty side', () => {
    const description = describeGuestIdentitySide(side({ guestId: 'guest-1', eventCount: 0, totalXp: 0, isBlank: true }))
    expect(description.guestIdShort).toBe('guest-1')
    expect(description.events).toBe('0 events')
    expect(description.emptinessNote).toBe('No progression yet.')
  })
})

describe('guestIdentityActionSummary', () => {
  it('reports each successful action with what the cloud now holds', () => {
    expect(guestIdentityActionSummary('keep-both', { result: 'succeeded' })).toBe(
      "Cloud backup settled · this browser's progress and the account's copy are now one, under the account's guest identity.",
    )
    expect(guestIdentityActionSummary('use-browser', { result: 'succeeded' })).toBe(
      "Cloud copy replaced · the account's cloud copy now holds this browser's progress.",
    )
    expect(guestIdentityActionSummary('use-account', { result: 'succeeded' })).toBe(
      "Cloud copy restored · this browser now follows the account's progress.",
    )
  })

  it('distinguishes a failed deletion from a failed re-upload', () => {
    expect(guestIdentityActionSummary('use-browser', { result: 'failed', step: 'delete-cloud', detail: 'Sign in required.' })).toBe(
      "Cloud copy was not replaced · the account's cloud copy could not be removed: Sign in required.",
    )
    expect(guestIdentityActionSummary('use-browser', { result: 'failed', step: 'upload', detail: 'Rate limit exceeded.' })).toBe(
      "Cloud copy removed · the account's cloud copy was deleted, but this browser's copy could not be uploaded: Rate limit exceeded.",
    )
  })

  it('distinguishes a failed identity write from a failed upload for keep-both', () => {
    expect(guestIdentityActionSummary('keep-both', { result: 'failed', step: 'adopt-identity', detail: 'storage refused' })).toBe(
      "Cloud backup was not saved · the account's guest identity could not be stored in this browser: storage refused",
    )
    expect(guestIdentityActionSummary('keep-both', { result: 'failed', step: 'upload', detail: 'try again later' })).toBe(
      "Cloud backup was not saved · this browser adopted the account's identity, but the upload failed: try again later",
    )
  })

  it('reports where use-account stopped', () => {
    expect(guestIdentityActionSummary('use-account', { result: 'failed', step: 'replace-local' })).toBe(
      "Cloud copy was not restored · this browser could not store the account's copy: try again",
    )
    expect(guestIdentityActionSummary('use-account', { result: 'failed', step: 'read-cloud', detail: '404' })).toBe(
      "Cloud copy was not restored · the account's cloud copy could not be read: 404",
    )
    expect(guestIdentityActionSummary('use-account', { result: 'failed' })).toBe(
      "Cloud copy restored locally · the account's copy could not be uploaded again: try again",
    )
  })
})

describe('adoptAccountGuestIdentity', () => {
  const now = '2026-08-28T10:00:00.000Z'
  const starter = PROTOTYPE_COMPANION_CATALOG.list()[0].id

  it('adopts the account identity while keeping the local progression', () => {
    const profile = createGuestProfile({ guestId: 'guest-local', starterCompanionId: starter, now })
    const adopted = adoptAccountGuestIdentity(profile, 'guest-account', '2026-08-29T10:00:00.000Z')

    expect(adopted.guestId).toBe('guest-account')
    expect(adopted.updatedAt).toBe('2026-08-29T10:00:00.000Z')
    expect(adopted.createdAt).toBe(profile.createdAt)
    // The starter ID embeds the old identity; keeping it would union a second
    // starter entry for the same companion on the next merge.
    expect(adopted.collection[0]?.referenceId).toBe('guest-account:starter')
    // The input profile is never mutated.
    expect(profile.guestId).toBe('guest-local')
    expect(profile.collection[0]?.referenceId).toBe('guest-local:starter')
  })

  it('leaves encounter references untouched', () => {
    const profile = createGuestProfile({ guestId: 'guest-local', starterCompanionId: starter, now })
    const withEncounter = {
      ...profile,
      collection: [
        ...profile.collection,
        { referenceId: 'draw-7', companionId: starter, acquiredAt: now, acquisition: 'encounter' as const },
      ],
    }

    const adopted = adoptAccountGuestIdentity(withEncounter, 'guest-account', now)
    expect(adopted.collection.map((reference) => reference.referenceId)).toEqual(['guest-account:starter', 'draw-7'])
  })

  it("reuses the account's own starter reference when it is known", () => {
    const profile = createGuestProfile({ guestId: 'guest-local', starterCompanionId: starter, now })
    const adopted = adoptAccountGuestIdentity(profile, 'guest-account', now, 'ref-5ccd4e7d-8ae3db72')

    expect(adopted.collection[0]?.referenceId).toBe('ref-5ccd4e7d-8ae3db72')
    // A profile restored from the cloud already stores the opaque form; with no
    // account reference supplied it must not be re-derived.
    const restored = adoptAccountGuestIdentity(
      { ...profile, collection: [{ ...profile.collection[0], referenceId: 'ref-5ccd4e7d-8ae3db72' }] },
      'guest-account',
      now,
    )
    expect(restored.collection[0]?.referenceId).toBe('ref-5ccd4e7d-8ae3db72')
  })

  it('dedupes an opaque account starter on the next merge', () => {
    const localProfile = createGuestProfile({ guestId: 'guest-local', starterCompanionId: starter, now })
    const cloudSnapshot = buildProductSnapshot(
      createProductState(
        createGuestProfile({ guestId: 'guest-account', starterCompanionId: starter, now }),
        { events: [] },
        createEncounterState(),
        PROTOTYPE_COMPANION_CATALOG,
      ),
      now,
    )
    const cloudStarterReferenceId = cloudSnapshot.collection[0]?.referenceId ?? null

    const adoptedLocal = buildProductSnapshot(
      createProductState(
        adoptAccountGuestIdentity(localProfile, cloudSnapshot.guestId, now, cloudStarterReferenceId),
        { events: [] },
        createEncounterState(),
        PROTOTYPE_COMPANION_CATALOG,
      ),
      now,
    )
    const merged = mergeProductSnapshots(adoptedLocal, cloudSnapshot)

    expect(adoptedLocal.collection).toHaveLength(1)
    expect(merged.collection).toHaveLength(1)
    expect(merged.companions[0]?.encounterCount).toBe(1)
  })

  it('merges the adopted local snapshot with the account snapshot without duplicating the starter', () => {
    const localProfile = createGuestProfile({ guestId: 'guest-local', starterCompanionId: starter, now })
    const events: NormalizedEvent[] = [{
      eventId: asEventId('event-local'),
      companionId: asCompanionId(starter),
      source: 'github',
      sourceId: 'github-sync',
      provenance: 'local',
      category: 'work-session',
      occurredAt: now,
    }]
    const localSnapshot = buildProductSnapshot(
      createProductState(localProfile, { events }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
      now,
    )
    const cloudSnapshot = buildProductSnapshot(
      createProductState(
        createGuestProfile({ guestId: 'guest-account', starterCompanionId: starter, now }),
        { events: [] },
        createEncounterState(),
        PROTOTYPE_COMPANION_CATALOG,
      ),
      now,
    )

    const adoptedLocal = buildProductSnapshot(
      createProductState(
        adoptAccountGuestIdentity(localProfile, cloudSnapshot.guestId, now),
        { events },
        createEncounterState(),
        PROTOTYPE_COMPANION_CATALOG,
      ),
      now,
    )
    // Without the identity rewrite the two starter references would not match,
    // and the merge would count two encounters for one companion.
    expect(localSnapshot.collection[0]?.referenceId).not.toBe(cloudSnapshot.collection[0]?.referenceId)
    expect(adoptedLocal.collection[0]?.referenceId).toBe(cloudSnapshot.collection[0]?.referenceId)

    const merged = mergeProductSnapshots(adoptedLocal, cloudSnapshot)

    expect(merged.guestId).toBe('guest-account')
    expect(merged.events).toHaveLength(1)
    expect(merged.collection).toHaveLength(1)
    expect(merged.companions).toHaveLength(1)
    expect(merged.companions[0]?.encounterCount).toBe(1)
  })
})
