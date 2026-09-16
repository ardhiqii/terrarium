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
import { getSupabaseProductStore } from './supabase-product-store'
import { shouldUseSupabase } from './supabase-client'

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
  github_id: number | null
  handle: string
  snapshot_json: string
  updated_at: string
}

export interface ProductSnapshotRecord {
  readonly githubId: number
  readonly handle: string
  readonly snapshot: ProductSnapshot
  readonly updatedAt: string
}

export interface ProductStore {
  put(
    githubId: number,
    handle: string,
    snapshot: ProductSnapshot,
    updatedAt: string,
    expectedUpdatedAt: string | null,
  ): Promise<boolean>
  get(githubId: number, handle?: string): Promise<ProductSnapshot | null>
  getRecord(githubId: number, handle?: string): Promise<ProductSnapshotRecord | null>
  remove(githubId: number, handle?: string): Promise<void>
}

export class ProductSqliteStore implements ProductStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string = defaultProductDbPath()) {
    ensureDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_snapshots (
        github_id INTEGER UNIQUE,
        handle TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    try {
      this.db.exec('ALTER TABLE product_snapshots ADD COLUMN github_id INTEGER')
    } catch {
      // The column already exists on new or previously migrated databases.
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS product_snapshots_github_id_idx ON product_snapshots (github_id) WHERE github_id IS NOT NULL')
  }

  private row(githubId: number, handle?: string): Row | undefined {
    const byId = this.db
      .prepare('SELECT github_id, handle, snapshot_json, updated_at FROM product_snapshots WHERE github_id = ?')
      .get(githubId) as Row | undefined
    if (byId || !handle) return byId
    return this.db
      .prepare('SELECT github_id, handle, snapshot_json, updated_at FROM product_snapshots WHERE handle = ? AND github_id IS NULL')
      .get(handle.toLowerCase()) as Row | undefined
  }

  private migrateLegacyHandle(row: Row, githubId: number): Row {
    if (row.github_id === null) {
      this.db
        .prepare('UPDATE product_snapshots SET github_id = ? WHERE handle = ? AND github_id IS NULL')
        .run(githubId, row.handle)
      return { ...row, github_id: githubId }
    }
    return row
  }

  /** Persist only if the row is still at the version the caller read. */
  async put(
    githubId: number,
    handle: string,
    snapshot: ProductSnapshot,
    updatedAt: string,
    expectedUpdatedAt: string | null,
  ): Promise<boolean> {
    const normalizedHandle = handle.toLowerCase()
    const json = serializeProductSnapshot(snapshot)
    if (expectedUpdatedAt === null) {
      const existing = this.db
        .prepare('SELECT github_id FROM product_snapshots WHERE github_id = ?')
        .get(githubId) as Pick<Row, 'github_id'> | undefined
      if (existing) return false
      try {
        const result = this.db
          .prepare('INSERT INTO product_snapshots (github_id, handle, snapshot_json, updated_at) VALUES (?, ?, ?, ?)')
          .run(githubId, normalizedHandle, json, updatedAt) as { changes?: number }
        return Number(result.changes ?? 0) === 1
      } catch (error) {
        if (error instanceof Error && /unique|constraint/i.test(error.message)) return false
        throw error
      }
    }
    // An unchanged timestamp is not a successful optimistic write. Without
    // this guard two writers that happen to share a millisecond version could
    // both pass the WHERE clause and silently overwrite one another.
    if (updatedAt === expectedUpdatedAt) return false
    const result = this.db
      .prepare('UPDATE product_snapshots SET handle = ?, snapshot_json = ?, updated_at = ? WHERE github_id = ? AND updated_at = ?')
      .run(normalizedHandle, json, updatedAt, githubId, expectedUpdatedAt) as { changes?: number }
    return Number(result.changes ?? 0) === 1
  }

  async getRecord(githubId: number, handle?: string): Promise<ProductSnapshotRecord | null> {
    const found = this.row(githubId, handle)
    if (!found) return null
    const row = this.migrateLegacyHandle(found, githubId)
    const snapshot = deserializeProductSnapshot(row.snapshot_json)
    return snapshot
      ? { githubId, handle: row.handle, snapshot, updatedAt: row.updated_at }
      : null
  }

  /** The stored snapshot for an immutable GitHub identity, or null when absent. */
  async get(githubId: number, handle?: string): Promise<ProductSnapshot | null> {
    return (await this.getRecord(githubId, handle))?.snapshot ?? null
  }

  /** Forget a GitHub identity's product snapshot entirely (opt-out). */
  async remove(githubId: number, handle?: string): Promise<void> {
    this.db
      .prepare('DELETE FROM product_snapshots WHERE github_id = ?')
      .run(githubId)
    if (handle) {
      this.db
        .prepare('DELETE FROM product_snapshots WHERE github_id IS NULL AND handle = ?')
        .run(handle.toLowerCase())
    }
  }
}

let singleton: ProductSqliteStore | null = null

/** Lazily constructed once per process; reset per test via `resetProductStoreForTests`. */
export function getProductStore(): ProductStore {
  if (shouldUseSupabase()) return getSupabaseProductStore()
  if (!singleton) singleton = new ProductSqliteStore()
  return singleton
}

/** Test-only: force a fresh product store. Never call outside a test. */
export function resetProductStoreForTests(dbPath: string = ':memory:'): ProductSqliteStore {
  singleton = new ProductSqliteStore(dbPath)
  return singleton
}
