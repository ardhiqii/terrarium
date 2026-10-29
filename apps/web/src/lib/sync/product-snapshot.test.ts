import { afterEach, describe, expect, it, vi } from 'vitest'
import { asCompanionId, asEventId, acceptedLedgerEvents, totalXpOf, type NormalizedEvent } from '../game/events'
import { PROTOTYPE_COMPANION_CATALOG } from '../game/companion-catalog'
import { advanceEncounter, createEncounterState } from '../game/encounters'
import { createGuestProfile } from '../game/guest-profile'
import { applyProductEvents, createProductState } from '../game/product-state'
import {
  buildProductSnapshot,
  buildProductSyncedSnapshot,
  deserializeProductSnapshot,
  mergeGuestWithServer,
  mergeProductSnapshots,
  PRODUCT_SNAPSHOT_SCHEMA_VERSION,
  restoreProductStateFromSnapshot,
  serializeProductSnapshot,
  serializeProductSyncedSnapshot,
  validateProductSnapshot,
  validateProductSyncedSnapshot,
  type ProductSnapshot,
} from './product-snapshot'
import { productEventProofPayload } from './product-event-proof-payload'
import { issueVerifiedEventProof, verifyVerifiedEventProof } from './verified-event-proof'

const now = '2026-08-28T10:00:00.000Z'
const githubId = 42

function event(id: string, companionId = 'pikachu-family'): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId(companionId),
    source: 'mounted-markdown',
    sourceId: 'vault:private',
    provenance: 'local',
    category: 'new-note',
    occurredAt: now,
    metadata: {
      path: 'private/SECRET_NOTE_TITLE.md',
      description: 'do not sync this text',
      activityCount: 1,
    },
  }
}

function githubEvent(id: string): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId('pikachu-family'),
    source: 'github',
    sourceId: 'github-account:42',
    provenance: 'verified',
    category: 'work-session',
    occurredAt: now,
  }
}

function state(events: readonly NormalizedEvent[] = []) {
  const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now })
  return createProductState(
    profile,
    { events },
    createEncounterState(),
    PROTOTYPE_COMPANION_CATALOG,
  )
}

function snapshotWith(overrides: Partial<ProductSnapshot>): ProductSnapshot {
  return { ...buildProductSnapshot(state()), ...overrides }
}

function verifiedGithubSnapshot(
  activityCount: number,
  verifiedProof: string,
  companionId = 'pikachu-family',
): ProductSnapshot {
  const snapshot = buildProductSnapshot(
    state([githubEvent('github:42:work-session:2026-08-28-04')].map((sourceEvent) => ({
      ...sourceEvent,
      companionId: asCompanionId(companionId),
    }))),
    now,
  )
  return {
    ...snapshot,
    events: [{
      ...snapshot.events[0],
      provenance: 'verified',
      verifiedProof,
      metadata: { activityCount },
    }],
  }
}

describe('product snapshot', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('exposes the versioned ProductSyncedSnapshot aliases without changing the legacy adapter', () => {
    const productSnapshot = buildProductSnapshot(state(), now)
    const syncedSnapshot = buildProductSyncedSnapshot(state(), now)

    expect(syncedSnapshot).toEqual(productSnapshot)
    expect(serializeProductSyncedSnapshot(syncedSnapshot)).toBe(serializeProductSnapshot(productSnapshot))
    expect(() => validateProductSyncedSnapshot(syncedSnapshot)).not.toThrow()
    expect(mergeProductSnapshots(productSnapshot, syncedSnapshot)).toEqual(
      mergeGuestWithServer(productSnapshot, syncedSnapshot),
    )
  })

  it('contains derived product state while excluding authored metadata and opaque source IDs', () => {
    const snapshot = buildProductSnapshot(state([event('private/SECRET_NOTE_TITLE')]))
    const serialized = serializeProductSnapshot(snapshot)

    expect(snapshot.schemaVersion).toBe(PRODUCT_SNAPSHOT_SCHEMA_VERSION)
    expect(snapshot.activeCompanionId).toBe('pikachu-family')
    expect(snapshot.companions[0]).toMatchObject({ companionId: 'pikachu-family', xp: 25 })
    expect(snapshot.events[0].provenance).toBe('local')
    expect(snapshot.events[0].category).toBe('new-note')
    expect(snapshot.events[0].metadata).toEqual({ activityCount: 1 })
    expect(serialized).not.toContain('SECRET_NOTE_TITLE')
    expect(serialized).not.toContain('do not sync this text')
    expect(serialized).not.toContain('private/SECRET_NOTE_TITLE')
    expect(serialized).not.toContain('vault:private')
  })

  it('round-trips and rejects malformed or widened snapshots', () => {
    const original = buildProductSnapshot(state([event('event-1')]))
    expect(deserializeProductSnapshot(serializeProductSnapshot(original))).toEqual(original)
    expect(deserializeProductSnapshot('{bad json')).toBeNull()
    expect(deserializeProductSnapshot(JSON.stringify({ ...original, schemaVersion: 99 }))).toBeNull()
    expect(deserializeProductSnapshot(JSON.stringify({ ...original, noteContents: ['secret'] }))).toBeNull()
    expect(() => validateProductSnapshot({ ...original, noteContents: ['secret'] })).toThrow(/unknown field/i)
    expect(() =>
      validateProductSnapshot({
        ...original,
        encounters: {
          ...original.encounters,
          processedTriggerIds: ['trigger-a', 'trigger-a'],
        },
      }),
    ).toThrow(/duplicate/i)
  })

  it('includes per-companion progression identifiers and encounter state without raw draw strings', () => {
    const profileState = state([event('event-1')])
    const encounter = advanceEncounter(
      profileState.encounters,
      { id: 'scan/private-note', progress: 100, seed: 'private seed', signals: { tags: ['secret-tag'] }, ownedCompanionIds: ['pikachu-family'] },
      PROTOTYPE_COMPANION_CATALOG,
    )
    const withEncounter = createProductState(
      { ...profileState.profile, collection: [...profileState.profile.collection, { referenceId: 'encounter-1', companionId: encounter.newDraws[0].selectedCompanionId, acquiredAt: now, acquisition: 'encounter' as const }] },
      profileState.ledger,
      encounter.state,
      PROTOTYPE_COMPANION_CATALOG,
    )
    const snapshot = buildProductSnapshot(withEncounter)
    const serialized = serializeProductSnapshot(snapshot)

    expect(snapshot.companions[0].progression).toMatchObject({ stepId: 'base', formId: 'base' })
    expect(snapshot.encounters.draws).toHaveLength(1)
    expect(snapshot.encounters.draws[0].selectedCompanionId).toBeTruthy()
    expect(serialized).not.toContain('private-note')
    expect(serialized).not.toContain('private seed')
    expect(serialized).not.toContain('secret-tag')

    const restored = restoreProductStateFromSnapshot(snapshot, profileState.profile, PROTOTYPE_COMPANION_CATALOG)
    expect(restored.encounters.draws[0]?.weights[0]).toMatchObject({
      matchedTags: [],
      matchedLanguages: [],
      matchedFileTypes: [],
    })
  })

  it('unions events and collection references, deduplicates replayed IDs, and keeps a valid guest active companion', () => {
    const guest = buildProductSnapshot(state([event('event-1')]))
    const serverState = state([event('event-1'), event('event-2')])
    const server = buildProductSnapshot(serverState)
    const merged = mergeGuestWithServer(guest, server)

    expect(merged.events).toHaveLength(2)
    expect(merged.collection).toHaveLength(1)
    expect(merged.activeCompanionId).toBe('pikachu-family')
    expect(merged.companions.find((companion) => companion.companionId === 'pikachu-family')?.xp).toBe(50)
  })

  it('keeps the server record when the same derived event ID conflicts', () => {
    const guest = buildProductSnapshot(state([event('event-1')]))
    const server = buildProductSnapshot(state([event('event-1')]))
    const serverEvent = { ...server.events[0], provenance: 'verified' as const, category: 'successful-ci' as const }

    const merged = mergeGuestWithServer(
      guest,
      { ...server, events: [serverEvent] },
    )

    expect(merged.events[0]).toMatchObject({ provenance: 'verified', category: 'successful-ci' })
  })

  it('lets a receipt-backed local delivery upgrade an older local copy without duplicating XP', () => {
    const guest = buildProductSnapshot(state([event('event-1')]))
    const server = buildProductSnapshot(state([event('event-1')]))
    const upgradedGuest: ProductSnapshot = {
      ...guest,
      events: [{ ...guest.events[0], provenance: 'verified', verifiedProof: 'server-receipt' }],
    }

    const merged = mergeGuestWithServer(upgradedGuest, server)

    expect(merged.events[0]).toMatchObject({ provenance: 'verified', verifiedProof: 'server-receipt' })
    expect(merged.companions.find((companion) => companion.companionId === 'pikachu-family')?.xp).toBe(25)
  })

  it('refreshes same-ID verified GitHub metadata when the receipt-backed activity count grows', () => {
    const server = verifiedGithubSnapshot(2, 'server-receipt')
    const guest = verifiedGithubSnapshot(3, 'newer-receipt')

    const merged = mergeGuestWithServer(guest, server)

    expect(merged.events[0]).toMatchObject({
      provenance: 'verified',
      verifiedProof: 'newer-receipt',
      metadata: { activityCount: 3 },
    })
  })

  it('keeps server ownership when a newer replay is bound to another companion', () => {
    const server = verifiedGithubSnapshot(2, 'server-receipt', 'pikachu-family')
    const switchedGuest = verifiedGithubSnapshot(3, 'switched-receipt', 'ditto-like')

    const merged = mergeGuestWithServer(switchedGuest, server)

    expect(merged.events[0]).toMatchObject({
      companionId: 'pikachu-family',
      verifiedProof: 'server-receipt',
      metadata: { activityCount: 2 },
    })
    expect(merged.companions.find((companion) => companion.companionId === 'pikachu-family')?.xp).toBe(10)
  })

  it('does not let a stale receipt-backed GitHub client downgrade the server aggregate', () => {
    const server = verifiedGithubSnapshot(3, 'server-receipt')
    const staleGuest = verifiedGithubSnapshot(2, 'stale-receipt')

    const merged = mergeGuestWithServer(staleGuest, server)

    expect(merged.events[0]).toMatchObject({
      provenance: 'verified',
      verifiedProof: 'server-receipt',
      metadata: { activityCount: 3 },
    })
  })

  it('keeps XP deduplicated when a verified GitHub aggregate is refreshed', () => {
    const server = verifiedGithubSnapshot(2, 'server-receipt')
    const guest = verifiedGithubSnapshot(4, 'newer-receipt')

    const merged = mergeGuestWithServer(guest, server)

    expect(merged.events).toHaveLength(1)
    expect(merged.companions.find((companion) => companion.companionId === 'pikachu-family')?.xp).toBe(10)
  })

  it('falls back to the server active companion only when the guest active ID is invalid', () => {
    const guest = snapshotWith({ activeCompanionId: 'missing-companion' })
    const server = snapshotWith({
      activeCompanionId: 'pikachu-family',
      collection: [
        ...snapshotWith({}).collection,
        { referenceId: 'ref-ditto', companionId: 'ditto-like', acquiredAt: now, acquisition: 'history' },
      ],
      companions: [
        ...snapshotWith({}).companions,
        { companionId: 'ditto-like', familyId: 'ditto-family', xp: 0, essence: 0, encounterCount: 1, progression: null },
      ],
    })

    expect(mergeGuestWithServer(guest, server).activeCompanionId).toBe('pikachu-family')
  })

  it('rehydrates a cloud snapshot into a local runtime without restoring source identities', () => {
    const cloud = buildProductSnapshot(state([event('event-1')]), now)
    const localProfile = createGuestProfile({ guestId: 'fresh-browser', starterCompanionId: 'pikachu-family', now })
    const restored = restoreProductStateFromSnapshot(
      cloud,
      localProfile,
      PROTOTYPE_COMPANION_CATALOG,
    )

    expect(restored.profile.guestId).toBe('guest-1')
    expect(restored.profile.activeCompanionId).toBe('pikachu-family')
    expect(restored.profile.sourceBaselines).toEqual([])
    expect(restored.ledger.events).toHaveLength(1)
    expect(restored.companions.find((companion) => companion.companionId === 'pikachu-family')?.xp).toBe(25)
  })

  it('keeps restored GitHub events idempotent when the provider delivers the same source ID again', () => {
    const sourceEvent = githubEvent('github:42:commit:abc123')
    const cloud = buildProductSnapshot(state([sourceEvent]), now)
    const restored = restoreProductStateFromSnapshot(
      cloud,
      createGuestProfile({ guestId: 'fresh-browser', starterCompanionId: 'pikachu-family', now }),
      PROTOTYPE_COMPANION_CATALOG,
    )

    const replayed = applyProductEvents(restored, [sourceEvent], PROTOTYPE_COMPANION_CATALOG)

    expect(replayed.ledger.events).toHaveLength(1)
    expect(replayed.companions.find((companion) => companion.companionId === 'pikachu-family')?.xp).toBe(10)
  })

  it('reproduces a server-issued receipt after a build -> restore -> build round trip', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const source: NormalizedEvent = {
      eventId: asEventId('github:42:work-session:2026-08-28-04'),
      companionId: asCompanionId('pikachu-family'),
      source: 'github',
      sourceId: 'github-account:42',
      provenance: 'verified',
      category: 'work-session',
      occurredAt: now,
      cap: { key: 'github:42:2026-08-28:work-session', limit: 2 },
      metadata: {
        activityCount: 2,
        sessionBucket: '2026-08-28-04',
        repositoryId: 'repo-1',
        linkedPullRequestId: 'pr-1',
      },
    }
    const firstPass = buildProductSnapshot(state([source]), now)
    const proofs = Object.fromEntries(
      firstPass.events.map((snapshotEvent): [string, string] => [
        snapshotEvent.eventId,
        issueVerifiedEventProof(snapshotEvent, githubId),
      ]),
    )
    const cloud = buildProductSnapshot(state([source]), now, proofs)
    const restored = restoreProductStateFromSnapshot(
      cloud,
      createGuestProfile({ guestId: 'fresh-browser', starterCompanionId: 'pikachu-family', now }),
      PROTOTYPE_COMPANION_CATALOG,
    )
    const rebuilt = buildProductSnapshot(restored, now, proofs)
    const cloudEvent = cloud.events[0]
    const restoredEvent = rebuilt.events[0]

    expect(restoredEvent.cap).toEqual(cloudEvent.cap)
    expect(restoredEvent.metadata).toEqual(cloudEvent.metadata)
    expect(productEventProofPayload(restoredEvent, githubId)).toBe(
      productEventProofPayload(cloudEvent, githubId),
    )
    expect(verifyVerifiedEventProof(restoredEvent, githubId, restoredEvent.verifiedProof as string)).toBe(true)
  })

  it('restores the safe event fields and keeps opaque source hashes lossless', () => {
    const original = buildProductSnapshot(state([event('event-1')]), now)
    const cloud = {
      ...original,
      events: [{
        ...original.events[0],
        cap: { key: 'cap-hash', limit: 1 },
        metadata: {
          activityCount: 1,
          bucket: 2,
          number: 3,
          repositoryIdHash: 'repo-hash',
          linkedPullRequestIdHash: 'linked-pr-hash',
          pullRequestIdHash: 'pr-hash',
          sessionBucket: '2026-08-28-0',
        },
      }],
    }
    const restored = restoreProductStateFromSnapshot(
      cloud,
      createGuestProfile({ guestId: 'fresh-browser', starterCompanionId: 'pikachu-family', now }),
      PROTOTYPE_COMPANION_CATALOG,
    )

    expect(restored.ledger.events[0]).toMatchObject({
      cap: { key: 'cap-hash', limit: 1 },
      metadata: { activityCount: 1, bucket: 2, number: 3, sessionBucket: '2026-08-28-0' },
    })
    })

    describe('eggs and repository assignments survive a sync', () => {
    it('keeps an unopened egg through serialize, deserialize, and restore', () => {
    // Without this, signing in on a second device silently discards every
    // companion the user had drawn but not yet opened: the collection would look
    // correct and the eggs would simply be gone.
    const now = '2026-08-28T10:00:00.000Z'
    const profile = {
      ...createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now }),
      eggs: [{ drawId: 'guest:0', companionId: 'ditto-like', laidAt: now }],
    }
    const state = createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG)
    const snapshot = buildProductSnapshot(state, now)

    expect(snapshot.eggs).toEqual([{ drawId: 'guest:0', companionId: 'ditto-like', laidAt: now }])

    const roundTripped = deserializeProductSnapshot(serializeProductSnapshot(snapshot))
    expect(roundTripped).not.toBeNull()
    validateProductSnapshot(roundTripped)

    const restored = restoreProductStateFromSnapshot(
      roundTripped as ProductSnapshot,
      createGuestProfile({ guestId: 'other-browser', starterCompanionId: 'pikachu-family', now }),
      PROTOTYPE_COMPANION_CATALOG,
    )
    expect(restored.profile.eggs).toEqual([{ drawId: 'guest:0', companionId: 'ditto-like', laidAt: now }])
    })

    it('keeps a repository assignment through the same trip', () => {
    const now = '2026-08-28T10:00:00.000Z'
    const profile = {
      ...createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now }),
      assignments: [
        { repositoryId: '12345', referenceId: 'guest-1:starter', companionId: 'pikachu-family', assignedAt: now },
      ],
    }
    const state = createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG)
    const restored = restoreProductStateFromSnapshot(
      deserializeProductSnapshot(serializeProductSnapshot(buildProductSnapshot(state, now))) as ProductSnapshot,
      createGuestProfile({ guestId: 'other-browser', starterCompanionId: 'pikachu-family', now }),
      PROTOTYPE_COMPANION_CATALOG,
    )
    expect(restored.profile.assignments).toEqual([
      { repositoryId: '12345', referenceId: 'guest-1:starter', companionId: 'pikachu-family', assignedAt: now },
    ])
    })

    it('still accepts a snapshot written before eggs existed', () => {
    // A payload already in flight from an older client has neither field, and
    // making them required would have rejected it with a 400 on first sync.
    const now = '2026-08-28T10:00:00.000Z'
    const state = createProductState(
      createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now }),
      { events: [] },
      createEncounterState(),
      PROTOTYPE_COMPANION_CATALOG,
    )
    const snapshot = buildProductSnapshot(state, now)
    const { eggs: _eggs, assignments: _assignments, ...legacy } = snapshot

    expect(() => validateProductSnapshot(legacy)).not.toThrow()

    const restored = restoreProductStateFromSnapshot(
      legacy as ProductSnapshot,
      createGuestProfile({ guestId: 'other-browser', starterCompanionId: 'pikachu-family', now }),
      PROTOTYPE_COMPANION_CATALOG,
    )
    expect(restored.profile.eggs).toEqual([])
    expect(restored.profile.assignments).toEqual([])
    })
  })
})

/**
 * The daily budget is enforced on the day carried by a cap key, and the sync contract
 * hashes that key. These tests exist because the hash swallowed the day: every event that
 * crossed the boundary fell back to its own timestamp, and a local note's timestamp is the
 * file mtime the caps stopped trusting.
 */
describe('the daily budget survives the sync contract', () => {
  const scanDay = '2026-10-01'

  function cappedNotes(count: number): NormalizedEvent[] {
    return Array.from({ length: count }, (_, i) => ({
      ...event(`note-${i}`),
      occurredAt: `2019-03-${String(1 + (i % 28)).padStart(2, '0')}T09:00:00.000Z`,
      cap: { key: `mounted-markdown:${scanDay}:new-note`, limit: count },
    }))
  }

  function restoredXp(snapshot: ProductSnapshot): number {
    const restored = restoreProductStateFromSnapshot(
      snapshot,
      createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now }),
      PROTOTYPE_COMPANION_CATALOG,
    )
    return totalXpOf(acceptedLedgerEvents(restored.ledger))
  }

  it('still costs one day after build -> serialize -> restore, not one day per mtime', () => {
    // Sixty notes at 25 XP is 1,500. The budget allows 300. Before the day was carried
    // through the wire format this returned 1,500: the hashed key hid the day, so each
    // forged mtime became its own budget.
    const built = buildProductSnapshot(state(cappedNotes(60)), now)
    expect(built.events[0].cap?.key).toMatch(/^cap-[0-9a-f]{8}-[0-9a-f]{8}@2026-10-01$/u)

    const serialized = serializeProductSnapshot(built)
    const parsed = deserializeProductSnapshot(serialized)
    expect(parsed).not.toBeNull()

    expect(restoredXp(parsed as ProductSnapshot)).toBe(300)
  })

  it('keeps the cap key opaque apart from the day', () => {
    // The source identity inside a cap key is still hashed: the annotation is a date, not
    // a folder or repository name.
    const built = buildProductSnapshot(state(cappedNotes(1)), now)
    const key = built.events[0].cap?.key ?? ''

    expect(key).not.toContain('mounted-markdown')
    expect(key.slice(0, key.indexOf('@'))).toMatch(/^cap-[0-9a-f]{8}-[0-9a-f]{8}$/u)
  })

  it('does not annotate a VERIFIED event, because its cap is inside the receipt payload', () => {
    // `productEventProofPayload` covers `cap` whole, so changing this encoding would make
    // every stored receipt stop verifying and the trust boundary would drop the account's
    // GitHub history.
    const verified: NormalizedEvent = {
      ...githubEvent('github:42:work-session:2026-08-28-04'),
      cap: { key: 'github:account:2026-08-28:work-session', limit: 2 },
    }
    const built = buildProductSnapshot(state([verified]), now)

    expect(built.events[0].cap?.key).toMatch(/^cap-[0-9a-f]{8}-[0-9a-f]{8}$/u)
    expect(built.events[0].cap?.key).not.toContain('@')
  })

  it('reproduces the same ids and caps when a restored snapshot is rebuilt', () => {
    // Two devices must derive the same wire form, or the merge sees two copies of one
    // event and the receipt/cap strings stop matching between them.
    const built = buildProductSnapshot(state(cappedNotes(3)), now)
    const restored = deserializeProductSnapshot(serializeProductSnapshot(built)) as ProductSnapshot
    const rebuilt = buildProductSnapshot(
      restoreProductStateFromSnapshot(
        restored,
        createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now }),
        PROTOTYPE_COMPANION_CATALOG,
      ),
      now,
    )

    expect(rebuilt.events.map((e) => [e.eventId, e.cap?.key])).toEqual(
      built.events.map((e) => [e.eventId, e.cap?.key]),
    )
  })
})

describe('merging twice', () => {
  it('is idempotent, so a retried upload cannot add XP or duplicate entries', () => {
    const guest = buildProductSnapshot(state([event('guest-1')]), now)
    const server = buildProductSnapshot(state([event('server-1')]), now)

    const merged = mergeGuestWithServer(guest, server)
    const again = mergeGuestWithServer(merged, server)

    expect(again).toEqual(merged)
    expect(mergeGuestWithServer(merged, merged)).toEqual(merged)
    expect(again.events).toHaveLength(2)
  })

  it('does not lose an egg or a collection entry when the same merge runs again', () => {
    const guest = buildProductSnapshot(state([event('guest-1')]), now)
    const server = buildProductSnapshot(state([event('server-1')]), now)
    const withEggs: ProductSnapshot = {
      ...guest,
      eggs: [{ drawId: 'guest:0', companionId: 'ditto-like', laidAt: now }],
    }

    const merged = mergeGuestWithServer(withEggs, server)
    const again = mergeGuestWithServer(merged, server)

    expect(again.eggs?.map((egg) => egg.drawId)).toEqual(['guest:0'])
    expect(again.collection.map((entry) => entry.referenceId)).toEqual(
      merged.collection.map((entry) => entry.referenceId),
    )
  })

  it('keeps an unopened egg the server has when this browser has not seen it', () => {
    // A client that has not fetched since the egg was laid: its profile is stale, so the
    // server's list is the newer one and the egg survives.
    const stale = buildProductSnapshot(state([event('guest-1')]), now)
    const server: ProductSnapshot = {
      ...buildProductSnapshot(state([event('server-1')]), now),
      eggs: [{ drawId: 'server:0', companionId: 'ditto-like', laidAt: now }],
    }

    const merged = mergeGuestWithServer(
      { ...stale, eggs: [], updatedAt: '2026-08-01T00:00:00.000Z' },
      server,
    )

    expect(merged.eggs?.map((egg) => egg.drawId)).toEqual(['server:0'])
  })

  it('does NOT resurrect an egg the user has already hatched', () => {
    // Hatching removes the egg from the profile, so the newer side is authoritative for the
    // list. A union here would hand back every egg the server had not heard about yet, and the
    // user would hatch the same companion twice.
    const hatched = buildProductSnapshot(state([event('guest-1')]), now)
    const server: ProductSnapshot = {
      ...buildProductSnapshot(state([event('server-1')]), now),
      eggs: [{ drawId: 'guest:0', companionId: 'ditto-like', laidAt: now }],
    }

    const merged = mergeGuestWithServer(
      { ...hatched, eggs: [], updatedAt: '2026-08-28T11:00:00.000Z' },
      server,
    )

    expect(merged.eggs).toEqual([])
  })
})
