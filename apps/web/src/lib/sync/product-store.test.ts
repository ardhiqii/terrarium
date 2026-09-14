import { describe, expect, it } from 'vitest'
import { ProductSqliteStore } from './product-store'
import { buildProductSnapshot } from './product-snapshot'
import { createCompanionCatalog, type CompanionCatalog } from '../game/companion-catalog'
import { createProductState } from '../game/product-state'
import { createEncounterState } from '../game/encounters'
import { createGuestProfile } from '../game/guest-profile'
import { PROTOTYPE_COMPANION_CATALOG } from '../game/companion-catalog'

function baseSnapshot() {
  const profile = createGuestProfile({
    guestId: 'guest-abc',
    starterCompanionId: 'pikachu-family',
    now: '2026-09-12T00:00:00.000Z',
  })
  const catalog: CompanionCatalog = PROTOTYPE_COMPANION_CATALOG
  const state = createProductState(profile, { events: [] }, createEncounterState(), catalog)
  return buildProductSnapshot(state, '2026-09-12T00:00:00.000Z')
}

describe('ProductSqliteStore', () => {
  it('round-trips a versioned put then get on a fresh in-memory store', async () => {
    const store = new ProductSqliteStore(':memory:')
    const snapshot = baseSnapshot()
    await expect(store.put(42, 'octocat', snapshot, snapshot.updatedAt, null)).resolves.toBe(true)
    const fetched = await store.get(42, 'octocat')
    expect(fetched).toEqual(snapshot)
  })

  it('returns null for an identity that has never synced', async () => {
    const store = new ProductSqliteStore(':memory:')
    const fetched = await store.get(404, 'nobody')
    expect(fetched).toBeNull()
  })

  it('rejects a stale writer and forgets an identity', async () => {
    const store = new ProductSqliteStore(':memory:')
    const snapshot = baseSnapshot()
    await store.put(42, 'octocat', snapshot, snapshot.updatedAt, null)
    expect(await store.put(42, 'octocat', snapshot, '2026-09-12T01:00:00.000Z', 'stale')).toBe(false)
    expect(await store.put(42, 'octocat', snapshot, snapshot.updatedAt, snapshot.updatedAt)).toBe(false)
    await store.remove(42)
    expect(await store.get(42, 'octocat')).toBeNull()
  })

  it('removes a legacy handle row during account deletion', async () => {
    const store = new ProductSqliteStore(':memory:')
    const database = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => unknown } } }).db
    const snapshot = baseSnapshot()
    database.prepare('INSERT INTO product_snapshots (handle, snapshot_json, updated_at) VALUES (?, ?, ?)').run(
      'octocat',
      JSON.stringify(snapshot),
      snapshot.updatedAt,
    )

    await store.remove(42, 'Octocat')

    expect(database.prepare('SELECT handle FROM product_snapshots WHERE handle = ?').get('octocat')).toBeUndefined()
  })
})
