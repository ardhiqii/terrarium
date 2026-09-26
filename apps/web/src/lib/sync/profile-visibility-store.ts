/**
 * Persistence for the public-profile opt-in policy.
 *
 * WHY THIS EXISTS: `profile-visibility.ts` defines the rule (default private,
 * opt-in only) but nothing stored a user's choice, so `/u/[handle]` had no
 * policy to consult and rendered every synced profile. This store is the
 * missing piece that makes the rule enforceable.
 *
 * KEYED BY IMMUTABLE GITHUB ID, not the handle. A GitHub login can be renamed
 * and later reused by someone else; a visibility row keyed by handle would
 * silently transfer one person's opt-in to another. The immutable ID is the
 * only safe key, and it matches the pattern the product and account stores
 * already use.
 *
 * Default is PRIVATE: a missing row is not "unknown", it is "not public". The
 * store only ever answers what was explicitly written.
 *
 * Same rules as the sibling stores: every failure is a rejected promise, the
 * table is created on first use, and this module is server-only (`node:sqlite`).
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  parseVisibility,
  type ProfileVisibilityRecord,
} from './profile-visibility'
import { shouldUseSupabase } from './supabase-client'
import { getSupabaseProfileVisibilityStore } from './supabase-profile-visibility-store'

/** Same default-db resolution as the other stores, including the Vitest in-memory override. */
export function defaultVisibilityDbPath(): string {
  if (process.env.SYNC_DB_PATH) return process.env.SYNC_DB_PATH
  if (process.env.VITEST) return ':memory:'
  return path.join(process.cwd(), '.data', 'sync.db')
}

function ensureDir(dbPath: string): void {
  if (dbPath === ':memory:') return
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true })
  } catch {
    // Best-effort, same tradeoff as the sibling stores.
  }
}

interface Row {
  github_id: number
  handle: string
  visibility: string
  updated_at: string
}

export interface ProfileVisibilityStore {
  /** The stored record, or null when the account has never chosen. */
  get(githubId: number): Promise<ProfileVisibilityRecord | null>
  /** Records the choice and its timestamp. */
  put(githubId: number, handle: string, visibility: string, updatedAt: string): Promise<void>
  /** Removes the record entirely; the account reverts to the private default. */
  remove(githubId: number): Promise<void>
  /** Visibility for many accounts at once, skipping those with no record. */
  getMany(githubIds: readonly number[]): Promise<ProfileVisibilityRecord[]>
  /**
   * The subset of the given ids that have opted in to a public profile.
   * Returns a Set keyed by immutable id, which is what filtering surfaces
   * (leaderboard rows, public listings) actually need: they must not have to
   * align a sparse result array back to the input list by index.
   */
  getPublicIds(githubIds: readonly number[]): Promise<Set<number>>
}

export class ProfileVisibilitySqliteStore implements ProfileVisibilityStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string = defaultVisibilityDbPath()) {
    ensureDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profile_visibility (
        github_id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL,
        visibility TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  private row(githubId: number): Row | undefined {
    return this.db
      .prepare('SELECT github_id, handle, visibility, updated_at FROM profile_visibility WHERE github_id = ?')
      .get(githubId) as Row | undefined
  }

  async get(githubId: number): Promise<ProfileVisibilityRecord | null> {
    const row = this.row(githubId)
    if (!row) return null
    return {
      handle: row.handle,
      visibility: parseVisibility(row.visibility),
      updatedAt: row.updated_at,
    }
  }

  async getMany(githubIds: readonly number[]): Promise<ProfileVisibilityRecord[]> {
    const unique = [...new Set(githubIds.filter((id) => Number.isFinite(id)))]
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT github_id, handle, visibility, updated_at FROM profile_visibility WHERE github_id IN (${placeholders})`)
      .all(...unique) as Row[]
    return rows.map((row) => ({
      handle: row.handle,
      visibility: parseVisibility(row.visibility),
      updatedAt: row.updated_at,
    }))
  }

  async getPublicIds(githubIds: readonly number[]): Promise<Set<number>> {
    const unique = [...new Set(githubIds.filter((id) => Number.isFinite(id)))]
    if (unique.length === 0) return new Set()
    const placeholders = unique.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT github_id FROM profile_visibility WHERE visibility = 'public' AND github_id IN (${placeholders})`,
      )
      .all(...unique) as Array<{ github_id: number }>
    return new Set(rows.map((row) => Number(row.github_id)))
  }

  async put(githubId: number, handle: string, visibility: string, updatedAt: string): Promise<void> {
    // Anything that is not a literal 'public' is stored as private; a caller
    // cannot opt an account in by mistake with a typo'd value.
    const normalized = parseVisibility(visibility)
    this.db
      .prepare(
        `INSERT INTO profile_visibility (github_id, handle, visibility, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           handle = excluded.handle,
           visibility = excluded.visibility,
           updated_at = excluded.updated_at`,
      )
      .run(githubId, handle.toLowerCase(), normalized, updatedAt)
  }

  async remove(githubId: number): Promise<void> {
    this.db.prepare('DELETE FROM profile_visibility WHERE github_id = ?').run(githubId)
  }
}

let singleton: ProfileVisibilitySqliteStore | null = null

export function getProfileVisibilityStore(): ProfileVisibilityStore {
  if (shouldUseSupabase()) return getSupabaseProfileVisibilityStore()
  if (!singleton) singleton = new ProfileVisibilitySqliteStore()
  return singleton
}

/** Test-only reset; production callers should use the singleton. */
export function resetProfileVisibilityStoreForTests(
  dbPath: string = ':memory:',
): ProfileVisibilitySqliteStore {
  singleton = new ProfileVisibilitySqliteStore(dbPath)
  return singleton
}
