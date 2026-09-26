import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { asCompanionId, asEventId, type NormalizedEvent } from '@/lib/game/events'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createEncounterState } from '@/lib/game/encounters'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { applyProductEvents, createProductState } from '@/lib/game/product-state'
import {
  buildProductSnapshot,
  type ProductSnapshot,
} from '@/lib/sync/product-snapshot'
import {
  issueGithubSyncCheckpoint,
  MAX_CHECKPOINT_TOKEN_LENGTH,
} from '@/lib/sync/github-sync-checkpoint'
import { issueVerifiedEventProof } from '@/lib/sync/verified-event-proof'
import { GUEST_IDENTITY_CONFLICT_ERROR } from '@/lib/game/guest-identity-conflict'

function request(method: string, body?: string, headers?: HeadersInit): NextRequest {
  return new NextRequest('http://localhost/api/sync/product', {
    method,
    ...(body !== undefined ? { body, headers } : {}),
  })
}

function fakeGithubId(handle: string): number {
  let hash = 0
  for (const character of handle) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return Math.abs(hash) || 1
}

function snapshot(eventIds: readonly string[] = [], guestId = 'guest-1'): ProductSnapshot {
  const now = '2026-08-28T10:00:00.000Z'
  const profile = createGuestProfile({ guestId, starterCompanionId: 'pikachu-family', now })
  const events: NormalizedEvent[] = eventIds.map((eventId) => ({
    eventId: asEventId(eventId),
    companionId: asCompanionId('pikachu-family'),
    source: 'mounted-markdown',
    sourceId: 'vault:42',
    provenance: 'local',
    category: 'work-session',
    occurredAt: now,
  }))
  return buildProductSnapshot(
    createProductState(
      profile,
      { events },
      createEncounterState(),
      PROTOTYPE_COMPANION_CATALOG,
    ),
    now,
  )
}

/**
 * Seed the account row so a deferred checkpoint can actually advance a
 * baseline. Uses the real SQLite account store; nothing here reaches GitHub.
 */
async function seedGithubAccount(handle: string): Promise<number> {
  vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
  const { resetGithubAccountStoreForTests, getGithubAccountStore } = await import('@/lib/sync/github-account-store')
  resetGithubAccountStoreForTests(':memory:')
  const githubId = fakeGithubId(handle)
  const store = getGithubAccountStore()
  await store.putCredential({ githubId, handle, avatarUrl: null }, 'server-token', ['repo'])
  await store.saveSettings(githubId, {
    trackedRepositoryIds: [],
    excludedRepositoryIds: [],
    autoIncludePersonal: true,
    autoIncludeOrganizations: [],
    baselineByRepositoryId: {},
    lastSyncedAt: null,
  })
  return githubId
}

function checkpointFor(
  githubId: number,
  value: ProductSnapshot,
  nextBaselineByRepositoryId: Record<string, string> = {},
): string {
  return issueGithubSyncCheckpoint({
    githubId,
    previousBaselineByRepositoryId: {},
    nextBaselineByRepositoryId,
    nextLastSyncedAt: '2026-08-28T10:05:00.000Z',
    eventIds: value.events.map((event) => event.eventId),
  })
}

describe('POST/GET/DELETE /api/sync/product', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SYNC_STORE', 'sqlite')
    vi.stubEnv('SYNC_DB_PATH', '')
    vi.stubEnv('STUB_SESSION_HANDLE', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('requires a signed-in session for every method', async () => {
    const { POST, GET, DELETE } = await import('./route')
    const serialized = JSON.stringify(snapshot())

    await expect(POST(request('POST', serialized))).resolves.toHaveProperty('status', 401)
    await expect(GET()).resolves.toHaveProperty('status', 401)
    await expect(DELETE(request('DELETE'))).resolves.toHaveProperty('status', 401)
  })

  it('persists a valid snapshot, restores it with GET, and deletes it', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'Octocat')
    const { POST, GET, DELETE } = await import('./route')
    const serialized = JSON.stringify(snapshot())

    const post = await POST(request('POST', serialized, { 'content-type': 'application/json' }))
    expect(post.status).toBe(200)
    expect((await post.json()).guestId).toBe('guest-1')

    const get = await GET()
    expect(get.status).toBe(200)
    expect((await get.json()).guestId).toBe('guest-1')
    const version = get.headers.get('x-product-snapshot-version')
    expect(version).toBeTruthy()

    expect((await DELETE(request(
      'DELETE',
      JSON.stringify({ expectedVersion: version }),
      { 'content-type': 'application/json' },
    ))).status).toBe(204)
    expect((await GET()).status).toBe(404)
  })

  it('recomputes derived XP before the first snapshot is stored', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, GET } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      companions: value.companions.map((companion) => ({
        ...companion,
        xp: 9999,
        essence: 9999,
        encounterCount: 999,
        progression: null,
      })),
    }

    const response = await POST(request('POST', JSON.stringify(forged)))

    expect(response.status).toBe(200)
    expect((await response.json()).companions[0].xp).toBe(10)
    const restored = await GET()
    expect(await restored.json()).toMatchObject({ companions: [{ xp: 10 }] })
  })

  it('recomputes stale stored companion totals before returning a trusted snapshot', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, GET } = await import('./route')
    const { getProductStore } = await import('@/lib/sync/product-store')

    await POST(request('POST', JSON.stringify(snapshot(['event-1']))))
    const store = getProductStore()
    const record = await store.getRecord(fakeGithubId('octocat'), 'octocat')
    expect(record).not.toBeNull()
    if (!record) return
    const stale: ProductSnapshot = {
      ...record.snapshot,
      companions: record.snapshot.companions.map((companion) => ({
        ...companion,
        xp: 9999,
        progression: null,
      })),
    }
    expect(await store.put(record.githubId, record.handle, stale, '2026-08-28T10:01:00.000Z', record.updatedAt)).toBe(true)

    const restored = await GET()
    expect(restored.status).toBe(200)
    expect((await restored.json()).companions[0].xp).toBe(10)
  })

  it('merges new events without double-counting replayed events', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, GET } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1']))))
    const merged = await POST(request('POST', JSON.stringify(snapshot(['event-1', 'event-2']))))
    expect(merged.status).toBe(200)
    expect((await merged.json()).events).toHaveLength(2)

    const restored = await GET()
    expect((await restored.json()).events).toHaveLength(2)
  })

  it('rejects a different guest profile instead of dropping server history', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1'], 'guest-1'))))
    const conflict = await POST(request('POST', JSON.stringify(snapshot(['event-2'], 'guest-2'))))
    expect(conflict.status).toBe(409)
  })

  it('answers the identity guard with the exact text the client detects', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1'], 'guest-1'))))
    const conflict = await POST(request('POST', JSON.stringify(snapshot(['event-2'], 'guest-2'))))

    // The panel only offers the identity chooser for this exact sentence; a
    // reworded guard would silently turn the choice back into a dead end.
    expect(await conflict.json()).toEqual({ error: GUEST_IDENTITY_CONFLICT_ERROR })
  })

  it('lets the browser copy replace the account copy after the cloud row is deleted', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, DELETE, GET } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1'], 'guest-1'))))
    expect((await POST(request('POST', JSON.stringify(snapshot(['event-2'], 'guest-2'))))).status).toBe(409)

    // This is the server half of the destructive "Use this browser" action:
    // delete the account's row, then re-upload the browser's snapshot.
    const current = await GET()
    const version = current.headers.get('x-product-snapshot-version')
    expect(version).toBeTruthy()
    expect((await DELETE(request(
      'DELETE',
      JSON.stringify({ expectedVersion: version }),
      { 'content-type': 'application/json' },
    ))).status).toBe(204)
    const replaced = await POST(request('POST', JSON.stringify(snapshot(['event-2'], 'guest-2'))))
    expect(replaced.status).toBe(200)
    expect((await replaced.json()).guestId).toBe('guest-2')
    expect((await GET()).status).toBe(200)
  })

  it('refuses an unversioned destructive delete', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, DELETE, GET } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1']))))
    expect((await DELETE(request('DELETE', JSON.stringify({})))).status).toBe(428)
    expect((await GET()).status).toBe(200)
  })

  it('refuses a stale destructive delete without removing the newer cloud row', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, DELETE, GET } = await import('./route')

    await POST(request('POST', JSON.stringify(snapshot(['event-1'], 'guest-1'))))
    const current = await GET()
    const version = current.headers.get('x-product-snapshot-version')
    expect(version).toBeTruthy()

    const staleDelete = await DELETE(request(
      'DELETE',
      JSON.stringify({ expectedVersion: `${version}-stale` }),
      { 'content-type': 'application/json' },
    ))
    expect(staleDelete.status).toBe(409)
    expect((await GET()).status).toBe(200)

    const currentDelete = await DELETE(request(
      'DELETE',
      JSON.stringify({ expectedVersion: version }),
      { 'content-type': 'application/json' },
    ))
    expect(currentDelete.status).toBe(204)
  })

  it('rejects malformed, widened, newer, and oversized payloads before storage', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST, GET } = await import('./route')
    const valid = snapshot()

    expect((await POST(request('POST', '{bad json'))).status).toBe(400)
    expect((await POST(request('POST', JSON.stringify({ ...valid, privateNote: 'secret' })))).status).toBe(400)
    expect((await POST(request('POST', JSON.stringify({ ...valid, schemaVersion: 99 })))).status).toBe(400)
    expect((await POST(request('POST', 'x'.repeat(2 * 1024 * 1024 + 1), {
      'content-length': String(2 * 1024 * 1024 + 1),
    }))).status).toBe(413)
    expect((await GET()).status).toBe(404)
  })

  it('rejects a snapshot that invents a companion outside the server catalog', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      activeCompanionId: 'invented-companion',
      companions: value.companions.map((companion) => ({ ...companion, companionId: 'invented-companion' })),
      collection: value.collection.map((reference) => ({ ...reference, companionId: 'invented-companion' })),
      events: value.events.map((event) => ({ ...event, companionId: 'invented-companion' })),
    }

    const response = await POST(request('POST', JSON.stringify(forged)))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/unrecognized companion/i) })
  })

  it('rejects a known companion that is not owned by the snapshot collection', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot()
    const forged: ProductSnapshot = {
      ...value,
      activeCompanionId: 'ditto-like',
      companions: [...value.companions, {
        companionId: 'ditto-like',
        familyId: 'ditto-family',
        xp: 0,
        essence: 0,
        encounterCount: 0,
        progression: null,
      }],
    }

    const response = await POST(request('POST', JSON.stringify(forged)))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/outside its collection/i) })
  })

  it('rejects a client-forged verified GitHub event without a server receipt', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      events: [{ ...value.events[0], provenance: 'verified' }],
    }

    const response = await POST(request('POST', JSON.stringify(forged)))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/server-issued receipt/i) })
  })

  it('rejects a forged GitHub event downgraded to local provenance', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      events: [{ ...value.events[0], source: 'github', provenance: 'local' }],
    }

    const response = await POST(request('POST', JSON.stringify(forged)))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/server-issued receipt/i) })
  })

  it('names the failing event and the reason when a receipt does not verify', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      events: [{ ...value.events[0], source: 'github', provenance: 'verified', verifiedProof: 'not-a-real-receipt' }],
    }

    const response = await POST(request('POST', JSON.stringify(forged)))

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      receiptFailures?: readonly { eventId: string; reason: string; payloadDigest: string }[]
      receiptFailureCount?: number
    }
    // A generic 400 was indistinguishable from a signing-key mismatch. The body
    // must now name the event, why it failed, and a digest of the payload the
    // verifier recomputed, so the mint-side digest can be compared against it.
    expect(body.receiptFailureCount).toBe(1)
    expect(body.receiptFailures?.[0]).toMatchObject({
      eventId: expect.any(String),
      reason: 'receipt-mismatch',
      payloadDigest: expect.stringMatching(/^[0-9a-f]{16}$/u),
    })
  })

  it('reports a missing receipt separately from a mismatched one', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const forged: ProductSnapshot = {
      ...value,
      events: [{ ...value.events[0], source: 'github', provenance: 'verified' }],
    }

    const response = await POST(request('POST', JSON.stringify(forged)))
    const body = (await response.json()) as { receiptFailures?: readonly { reason: string }[] }

    expect(response.status).toBe(400)
    expect(body.receiptFailures?.[0]?.reason).toBe('missing-receipt')
  })

  it('preserves a valid verified GitHub event at the trusted snapshot boundary', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const { POST, GET } = await import('./route')
    const githubId = fakeGithubId('octocat')
    const value = snapshot(['trusted-event'])
    const unsigned = { ...value.events[0], source: 'github' as const, provenance: 'verified' as const }
    const trusted: ProductSnapshot = {
      ...value,
      events: [{ ...unsigned, verifiedProof: issueVerifiedEventProof(unsigned, githubId) }],
    }

    expect((await POST(request('POST', JSON.stringify(trusted)))).status).toBe(200)
    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0].source).toBe('github')
    expect(body.companions[0].xp).toBe(10)
  })

  it('drops legacy verified events without a valid receipt and recomputes XP before returning them', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const dbPath = path.join(tmpdir(), `terrarium-product-route-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    vi.stubEnv('SYNC_DB_PATH', dbPath)
    const { POST, GET } = await import('./route')
    const { getProductStore } = await import('@/lib/sync/product-store')

    await POST(request('POST', JSON.stringify(snapshot(['legacy-event']))))
    const store = getProductStore()
    const record = await store.getRecord(fakeGithubId('octocat'), 'octocat')
    expect(record).not.toBeNull()
    if (!record) return

    const legacyVerified: ProductSnapshot = {
      ...record.snapshot,
      events: [{ ...record.snapshot.events[0], source: 'github', provenance: 'verified', verifiedProof: 'invalid-proof' }],
    }
    expect(await store.put(record.githubId, record.handle, legacyVerified, '2026-08-28T10:01:00.000Z', record.updatedAt)).toBe(true)

    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.events).toEqual([])
    expect(body.companions[0].xp).toBe(0)
    expect((await store.getRecord(record.githubId, record.handle))?.snapshot.events[0].provenance).toBe('verified')
  })

  it('accepts the signed checkpoint in the body and commits the baseline', async () => {
    // REGRESSION: the checkpoint used to travel only in a request header. A real
    // account's checkpoint is tens of kilobytes, which a request-header budget
    // rejects upstream as a bodyless 500 before this route runs, so the
    // computed baseline was never persisted. The body is the transport now.
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const githubId = await seedGithubAccount('octocat')
    const { POST } = await import('./route')
    const { getGithubAccountStore } = await import('@/lib/sync/github-account-store')
    const local = snapshot(['event-1'])
    const unsigned = {
      ...local.events[0],
      source: 'github' as const,
      provenance: 'verified' as const,
    }
    const value: ProductSnapshot = {
      ...local,
      events: [{ ...unsigned, verifiedProof: issueVerifiedEventProof(unsigned, githubId) }],
    }
    const checkpoint = checkpointFor(githubId, value, { '101': '2026-08-28T10:05:00.000Z' })

    const response = await POST(request('POST', JSON.stringify({ snapshot: value, checkpoint })))

    expect(response.status).toBe(200)
    const settings = await getGithubAccountStore().getSettings(githubId)
    expect(settings.baselineByRepositoryId).toEqual({ '101': '2026-08-28T10:05:00.000Z' })
    expect(settings.lastSyncedAt).toBe('2026-08-28T10:05:00.000Z')
    expect((await response.json()).events).toHaveLength(1)
  })

  it('rejects a checkpoint whose event ID is substituted with a local event', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const githubId = await seedGithubAccount('octocat')
    const { POST } = await import('./route')
    const value = snapshot(['event-1'])
    const checkpoint = checkpointFor(githubId, value, { '101': '2026-08-28T10:05:00.000Z' })

    const response = await POST(request('POST', JSON.stringify({ snapshot: value, checkpoint })))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/verified GitHub events/i) })
    expect((await (await import('@/lib/sync/github-account-store')).getGithubAccountStore().getSettings(githubId)).baselineByRepositoryId).toEqual({})
  })

  it('rejects a body checkpoint whose issued events are missing from the snapshot', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const githubId = await seedGithubAccount('octocat')
    const { POST } = await import('./route')
    const checkpoint = issueGithubSyncCheckpoint({
      githubId,
      previousBaselineByRepositoryId: {},
      nextBaselineByRepositoryId: { '101': '2026-08-28T10:05:00.000Z' },
      nextLastSyncedAt: null,
      eventIds: ['event-12345678-abcdef12'],
    })

    const response = await POST(request('POST', JSON.stringify({
      snapshot: snapshot(['event-1']),
      checkpoint,
    })))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/missing from the product snapshot/i) })
  })

  it('rejects a forged, non-string, or oversized body checkpoint without storing it', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const githubId = await seedGithubAccount('octocat')
    const { POST } = await import('./route')
    const { getGithubAccountStore } = await import('@/lib/sync/github-account-store')
    const value = snapshot(['event-1'])
    const forged = `${checkpointFor(githubId, value)}x`

    const forgedResponse = await POST(request('POST', JSON.stringify({ snapshot: value, checkpoint: forged })))
    expect(forgedResponse.status).toBe(400)
    expect(await forgedResponse.json()).toMatchObject({ error: expect.stringMatching(/invalid or expired/i) })

    const typed = await POST(request('POST', JSON.stringify({ snapshot: value, checkpoint: 7 })))
    expect(typed.status).toBe(400)
    expect(await typed.json()).toMatchObject({ error: expect.stringMatching(/signed token/i) })

    const oversized = await POST(request('POST', JSON.stringify({
      snapshot: value,
      checkpoint: 'x'.repeat(MAX_CHECKPOINT_TOKEN_LENGTH + 1),
    })))
    expect(oversized.status).toBe(413)

    expect((await getGithubAccountStore().getSettings(githubId)).baselineByRepositoryId).toEqual({})
  })

  it('drops legacy local GitHub events instead of preserving unverified XP', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const dbPath = path.join(tmpdir(), `terrarium-product-route-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    vi.stubEnv('SYNC_DB_PATH', dbPath)
    const { POST, GET } = await import('./route')
    const { getProductStore } = await import('@/lib/sync/product-store')

    await POST(request('POST', JSON.stringify(snapshot(['legacy-event']))))
    const store = getProductStore()
    const record = await store.getRecord(fakeGithubId('octocat'), 'octocat')
    expect(record).not.toBeNull()
    if (!record) return

    const legacyForged: ProductSnapshot = {
      ...record.snapshot,
      events: [{ ...record.snapshot.events[0], source: 'github', provenance: 'local' }],
    }
    expect(await store.put(record.githubId, record.handle, legacyForged, '2026-08-28T10:02:00.000Z', record.updatedAt)).toBe(true)

    const response = await GET()
    expect(response.status).toBe(200)
    expect((await response.json()).events).toEqual([])
  })

  it('invalidates encounter rewards that cannot be tied to trusted events', async () => {
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const dbPath = path.join(tmpdir(), `terrarium-product-route-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    vi.stubEnv('SYNC_DB_PATH', dbPath)
    const { GET, POST } = await import('./route')
    const { getProductStore } = await import('@/lib/sync/product-store')
    const now = '2026-08-28T10:00:00.000Z'
    const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now })
    const event: NormalizedEvent = {
      eventId: asEventId('encounter-event'),
      companionId: asCompanionId('pikachu-family'),
      source: 'mounted-markdown',
      sourceId: 'vault:42',
      provenance: 'local',
      category: 'work-session',
      occurredAt: now,
    }
    const state = applyProductEvents(
      createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
      [event],
      PROTOTYPE_COMPANION_CATALOG,
      { triggerId: 'legacy-github', encounterProgress: 100 },
    )
    const value = buildProductSnapshot(state, now)
    const forged: ProductSnapshot = {
      ...value,
      events: [{ ...value.events[0], source: 'github', provenance: 'verified', verifiedProof: 'invalid-proof' }],
    }

    const first = await POST(request('POST', JSON.stringify(value)))
    expect(first.status).toBe(200)
    const store = getProductStore()
    const record = await store.getRecord(fakeGithubId('octocat'), 'octocat')
    expect(record).not.toBeNull()
    if (!record) return
    expect(await store.put(record.githubId, record.handle, forged, '2026-08-28T10:01:00.000Z', record.updatedAt)).toBe(true)

    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.encounters.draws).toEqual([])
    expect(body.collection.every((reference: { acquisition: string }) => reference.acquisition !== 'encounter')).toBe(true)
    expect(body.companions).toHaveLength(1)
    expect(body.companions[0].essence).toBe(0)
    expect(body.companions[0].encounterCount).toBe(1)
  })
})
