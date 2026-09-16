import { afterEach, describe, expect, it, vi } from 'vitest'
import { asCompanionId, asEventId, type NormalizedEvent } from '../game/events'
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
    expect(restored.ledger.events[0]?.metadata).toMatchObject({
      repositoryIdHash: 'repo-hash',
      linkedPullRequestIdHash: 'linked-pr-hash',
      pullRequestIdHash: 'pr-hash',
    })
  })
})
