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
import { randomUUID } from 'node:crypto'
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
  row_version: string | null
}

interface TableColumn {
  name: string
  pk: number
}

interface TableIndex {
  name: string
  unique: number
}

export interface ProductSnapshotRecord {
  readonly githubId: number
  readonly handle: string
  readonly snapshot: ProductSnapshot
  readonly updatedAt: string
  /** Opaque store version used for destructive conditional actions. */
  readonly version: string
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
  /** Delete only if the immutable account row still has this version. */
  removeIfVersion(githubId: number, expectedUpdatedAt: string): Promise<boolean>
}

export class ProductSqliteStore implements ProductStore {
  private readonly db: DatabaseSync

  private rebuildHandleKeyedTableIfNeeded(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(product_snapshots)')
      .all() as TableColumn[]
    const handleIsPrimaryKey = columns.some((column) => column.name === 'handle' && column.pk > 0)
    const indexes = this.db
      .prepare('PRAGMA index_list(product_snapshots)')
      .all() as TableIndex[]
    const hasUniqueHandleIndex = indexes.some((index) => {
      if (index.unique !== 1) return false
      const fields = this.db
        .prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
        .all() as Array<{ name: string | null }>
      return fields.length === 1 && fields[0]?.name === 'handle'
    })
    if (!handleIsPrimaryKey && !hasUniqueHandleIndex) return

    // The pre-identity SQLite table keyed rows by mutable handle. Rebuild it
    // so an unbound legacy row cannot block a new immutable-ID row with the
    // same login, while preserving the old row as inaccessible data.
    this.db.exec('BEGIN')
    try {
      this.db.exec(`
        CREATE TABLE product_snapshots_identity_migration (
          github_id INTEGER UNIQUE,
          handle TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          row_version TEXT
        )
      `)
      this.db.exec(`
        INSERT INTO product_snapshots_identity_migration
          (github_id, handle, snapshot_json, updated_at, row_version)
        SELECT github_id, handle, snapshot_json, updated_at, row_version
        FROM product_snapshots
      `)
      this.db.exec('DROP TABLE product_snapshots')
      this.db.exec('ALTER TABLE product_snapshots_identity_migration RENAME TO product_snapshots')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  constructor(dbPath: string = defaultProductDbPath()) {
    ensureDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_snapshots (
        github_id INTEGER UNIQUE,
        handle TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        row_version TEXT
      )
    `)
    try {
      this.db.exec('ALTER TABLE product_snapshots ADD COLUMN github_id INTEGER')
    } catch {
      // The column already exists on new or previously migrated databases.
    }
    try {
      this.db.exec('ALTER TABLE product_snapshots ADD COLUMN row_version TEXT')
    } catch {
      // The column already exists on new or previously migrated databases.
    }
    this.rebuildHandleKeyedTableIfNeeded()
    const legacyRows = this.db
      .prepare('SELECT rowid FROM product_snapshots WHERE row_version IS NULL')
      .all() as Array<{ rowid: number }>
    for (const row of legacyRows) {
      this.db
        .prepare('UPDATE product_snapshots SET row_version = ? WHERE rowid = ? AND row_version IS NULL')
        .run(randomUUID(), row.rowid)
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS product_snapshots_github_id_idx ON product_snapshots (github_id) WHERE github_id IS NOT NULL')
  }

  private row(githubId: number): Row | undefined {
    return this.db
      .prepare('SELECT github_id, handle, snapshot_json, updated_at, row_version FROM product_snapshots WHERE github_id = ?')
      .get(githubId) as Row | undefined
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
          .prepare('INSERT INTO product_snapshots (github_id, handle, snapshot_json, updated_at, row_version) VALUES (?, ?, ?, ?, ?)')
          .run(githubId, normalizedHandle, json, updatedAt, randomUUID()) as { changes?: number }
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
      .prepare('UPDATE product_snapshots SET handle = ?, snapshot_json = ?, updated_at = ?, row_version = ? WHERE github_id = ? AND updated_at = ?')
      .run(normalizedHandle, json, updatedAt, randomUUID(), githubId, expectedUpdatedAt) as { changes?: number }
    return Number(result.changes ?? 0) === 1
  }

  async getRecord(githubId: number, _handle?: string): Promise<ProductSnapshotRecord | null> {
    // Handles are mutable and can be reused. An unbound legacy row cannot be
    // safely attributed to the current immutable GitHub identity, so it is
    // intentionally not adopted here.
    const row = this.row(githubId)
    if (!row || !row.row_version) return null
    const snapshot = deserializeProductSnapshot(row.snapshot_json)
    return snapshot
      ? { githubId, handle: row.handle, snapshot, updatedAt: row.updated_at, version: row.row_version }
      : null
  }

  /** The stored snapshot for an immutable GitHub identity, or null when absent. */
  async get(githubId: number, handle?: string): Promise<ProductSnapshot | null> {
    return (await this.getRecord(githubId, handle))?.snapshot ?? null
  }

  /** Forget a GitHub identity's product snapshot entirely (opt-out). */
  async remove(githubId: number, _handle?: string): Promise<void> {
    this.db
      .prepare('DELETE FROM product_snapshots WHERE github_id = ?')
      .run(githubId)
  }

  async removeIfVersion(githubId: number, expectedVersion: string): Promise<boolean> {
    const result = this.db
      .prepare('DELETE FROM product_snapshots WHERE github_id = ? AND row_version = ?')
      .run(githubId, expectedVersion) as { changes?: number }
    return Number(result.changes ?? 0) === 1
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
