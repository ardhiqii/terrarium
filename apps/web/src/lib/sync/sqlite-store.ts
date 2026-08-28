/**
 * `SyncStore` (see `./types.ts`, frozen) implemented over `node:sqlite`,
 * built into Node 22.14 with no flag and no dependency. Per T28: do not
 * install `better-sqlite3` or any other driver.
 *
 * One table, one row per user, the snapshot stored as JSON text. The schema
 * is created on first use so there is no separate migration step to forget
 * in dev.
 *
 * Handles are always lowercased before touching the database. GitHub logins
 * are case-insensitive, so `Torvalds` and `torvalds` must resolve to the
 * same row rather than silently becoming two accounts.
 *
 * This module is server-only (it imports `node:sqlite`, `node:fs`,
 * `node:path`). Nothing under `src/components` or any `'use client'` file
 * may import it; `client-bundle-safety.test.ts` walks the import graph and
 * fails the build if that ever happens.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { SyncStore, SyncedUser } from './types'

/**
 * Where the on-disk database lives. Gitignored (`/.data/` in `.gitignore`)
 * since it is local dev/runtime state, not something to commit.
 *
 * Overridable via `SYNC_DB_PATH` for anyone who wants a specific file.
 * Under Vitest (`process.env.VITEST` is set by the test runner itself) the
 * default is an in-memory database instead, so the test suite never reads or
 * writes the real dev database and tests get a clean, isolated store simply
 * by resetting modules between cases.
 */
function defaultDbPath(): string {
  if (process.env.SYNC_DB_PATH) return process.env.SYNC_DB_PATH
  if (process.env.VITEST) return ':memory:'
  return path.join(process.cwd(), '.data', 'sync.db')
}

function ensureDir(dbPath: string): void {
  if (dbPath === ':memory:') return
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true })
  } catch {
    // Best-effort, same tradeoff as creature-route-shared.ts's disk cache:
    // a read-only filesystem should not crash the module, though a write
    // will then fail loudly when it actually happens.
  }
}

interface Row {
  handle: string
  github_id: number
  avatar_url: string | null
  snapshot_json: string
  updated_at: string
}

function rowToUser(row: Row): SyncedUser {
  return {
    handle: row.handle,
    githubId: Number(row.github_id),
    avatarUrl: row.avatar_url,
    snapshot: JSON.parse(row.snapshot_json),
    updatedAt: row.updated_at,
  }
}

export class SqliteSyncStore implements SyncStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string = defaultDbPath()) {
    ensureDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synced_users (
        handle TEXT PRIMARY KEY,
        github_id INTEGER NOT NULL,
        avatar_url TEXT,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  // Every method below is declared `async`. `node:sqlite`'s API is fully
  // synchronous, so a throw inside these bodies (a locked file, a corrupt
  // row) becomes a rejected promise via normal `async function` semantics,
  // never a synchronous throw at the call site. That is the "every method
  // rejects rather than throwing synchronously" rule from `types.ts`.

  async put(user: SyncedUser): Promise<void> {
    const handle = user.handle.toLowerCase()
    this.db
      .prepare(
        `INSERT INTO synced_users (handle, github_id, avatar_url, snapshot_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           github_id = excluded.github_id,
           avatar_url = excluded.avatar_url,
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`
      )
      .run(
        handle,
        user.githubId,
        user.avatarUrl,
        JSON.stringify(user.snapshot),
        user.updatedAt
      )
  }

  async get(handle: string): Promise<SyncedUser | null> {
    const row = this.db
      .prepare('SELECT * FROM synced_users WHERE handle = ?')
      .get(handle.toLowerCase()) as Row | undefined
    return row ? rowToUser(row) : null
  }

  async getMany(handles: string[]): Promise<SyncedUser[]> {
    if (handles.length === 0) return []
    const placeholders = handles.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM synced_users WHERE handle IN (${placeholders})`)
      .all(...handles.map((h) => h.toLowerCase())) as Row[]
    return rows.map(rowToUser)
  }

  async remove(handle: string): Promise<void> {
    this.db.prepare('DELETE FROM synced_users WHERE handle = ?').run(handle.toLowerCase())
  }
}

let singleton: SqliteSyncStore | null = null

/** The store every route handler should use. Lazily constructed once per
 * process (or per test module, since Vitest resets modules between test
 * files that call `vi.resetModules()`). */
export function getSyncStore(): SyncStore {
  if (!singleton) singleton = new SqliteSyncStore()
  return singleton
}

/** Test-only: force a fresh store, optionally at a specific path (defaults
 * to a brand new in-memory database). Never call this outside a test. */
export function resetSyncStoreForTests(dbPath: string = ':memory:'): SyncStore {
  singleton = new SqliteSyncStore(dbPath)
  return singleton
}
