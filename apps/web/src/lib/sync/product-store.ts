/**
 * A store for the richer product companion snapshot (`ProductSnapshot`),
 * separate from the legacy `SyncedSnapshot` table.
 *
 * WHY SEPARATE FROM `SyncStore`: the legacy table (`./sqlite-store.ts`) holds
 * the old closed `SyncedSnapshot` shape. The product snapshot is a different,
 * richer derived-only contract with its own schema and validators (see
 * `product-snapshot.ts`). Mixing both into one table would force a wider
 * migration of frozen `types.ts`; instead this store uses a separate table in
 * the SAME database, so the two sync layers coexist and can each evolve
 * independently.
 *
 * Same rules as the legacy store: handles are lowercased, every failure is a
 * rejected promise rather than a synchronous throw, and the table is created
 * on first use so there is no separate migration step.
 *
 * This is server-only (`node:sqlite`). Nothing under `src/components` or any
 * `'use client'` file may import it — `client-bundle-safety.test.ts` enforces
 * that.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  deserializeProductSnapshot,
  serializeProductSnapshot,
  type ProductSnapshot,
} from './product-snapshot'

/** Same default-db resolution as `sqlite-store.ts`, including the Vitest in-memory override. */
export function defaultProductDbPath(): string {
  if (process.env.SYNC_DB_PATH) return process.env.SYNC_DB_PATH
  if (process.env.VITEST) return ':memory:'
  return path.join(process.cwd(), '.data', 'product-sync.db')
}

function ensureDir(dbPath: string): void {
  if (dbPath === ':memory:') return
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true })
  } catch {
    // Best-effort, same tradeoff as the legacy store.
  }
}

interface Row {
  handle: string
  snapshot_json: string
  updated_at: string
}

export class ProductSqliteStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string = defaultProductDbPath()) {
    ensureDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_snapshots (
        handle TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  /** Persist (or update) the product snapshot for a handle. */
  async put(handle: string, snapshot: ProductSnapshot, updatedAt: string): Promise<void> {
    const normalizedHandle = handle.toLowerCase()
    const json = serializeProductSnapshot(snapshot)
    this.db
      .prepare(
        `INSERT INTO product_snapshots (handle, snapshot_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`
      )
      .run(normalizedHandle, json, updatedAt)
  }

  /** The stored snapshot for a handle, or null when it has never synced. */
  async get(handle: string): Promise<ProductSnapshot | null> {
    const row = this.db
      .prepare('SELECT snapshot_json FROM product_snapshots WHERE handle = ?')
      .get(handle.toLowerCase()) as Pick<Row, 'snapshot_json'> | undefined
    if (!row) return null
    return deserializeProductSnapshot(row.snapshot_json)
  }

  /** Forget a handle's product snapshot entirely (opt-out). */
  async remove(handle: string): Promise<void> {
    this.db
      .prepare('DELETE FROM product_snapshots WHERE handle = ?')
      .run(handle.toLowerCase())
  }
}

let singleton: ProductSqliteStore | null = null

/** Lazily constructed once per process; reset per test via `resetProductStoreForTests`. */
export function getProductStore(): ProductSqliteStore {
  if (!singleton) singleton = new ProductSqliteStore()
  return singleton
}

/** Test-only: force a fresh product store. Never call outside a test. */
export function resetProductStoreForTests(dbPath: string = ':memory:'): ProductSqliteStore {
  singleton = new ProductSqliteStore(dbPath)
  return singleton
}
