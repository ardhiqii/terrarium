import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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

  it('deletes only when the immutable row version still matches', async () => {
    const store = new ProductSqliteStore(':memory:')
    const snapshot = baseSnapshot()
    await store.put(42, 'octocat', snapshot, snapshot.updatedAt, null)

    expect(await store.removeIfVersion(42, 'stale')).toBe(false)
    expect(await store.get(42)).not.toBeNull()
    const record = await store.getRecord(42)
    expect(record?.version).toMatch(/[0-9a-f-]{36}/u)
    expect(await store.removeIfVersion(42, record?.version ?? '')).toBe(true)
    expect(await store.get(42)).toBeNull()
  })

  it('rebuilds the old handle-primary-key table before accepting immutable rows', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'terrarium-product-store-'))
    const dbPath = path.join(directory, 'product.db')
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE product_snapshots (
        handle TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    const snapshot = baseSnapshot()
    legacy.prepare('INSERT INTO product_snapshots (handle, snapshot_json, updated_at) VALUES (?, ?, ?)')
      .run('octocat', JSON.stringify(snapshot), snapshot.updatedAt)
    legacy.close()

    const store = new ProductSqliteStore(dbPath)
    try {
      expect(await store.put(42, 'octocat', snapshot, snapshot.updatedAt, null)).toBe(true)
      expect(await store.get(42)).toEqual(snapshot)
      const database = (store as unknown as { db: { prepare: (sql: string) => { get: () => { count: number } } } }).db
      expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get().count).toBe(2)
    } finally {
      ;(store as unknown as { db: { close: () => void } }).db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not adopt an unbound legacy row by mutable handle', async () => {
    const store = new ProductSqliteStore(':memory:')
    const database = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => unknown } } }).db
    const snapshot = baseSnapshot()
    database.prepare('INSERT INTO product_snapshots (handle, snapshot_json, updated_at) VALUES (?, ?, ?)').run(
      'octocat',
      JSON.stringify(snapshot),
      snapshot.updatedAt,
    )

    expect(await store.get(42, 'Octocat')).toBeNull()
    expect(database.prepare('SELECT handle FROM product_snapshots WHERE handle = ?').get('octocat')).toMatchObject({ handle: 'octocat' })
  })
})
