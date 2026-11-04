/**
 * The owner's opt-in for showing dressed companions on their public repos.
 *
 * WHY A SEPARATE OPT-IN FROM `profile-visibility`: a public profile and a repo
 * badge publish different things to different places. Someone may want their
 * README to show the companion they dressed without having a browsable
 * profile, or the other way round. Folding both into one switch would force
 * one choice to publish the other. See `docs-plan/PLAN-dressed-repo-creature.md` §3.2.
 *
 * DEFAULT OFF, PRESENCE MEANS ON. A row exists only while the owner has opted
 * in; turning it off deletes the row, so no stale "on" value can survive a
 * later bug in a reader. Same shape and reasoning as `profile-visibility-store.ts`.
 *
 * KEYED BY IMMUTABLE GITHUB ID. A login can be renamed and reused, and the
 * creature routes resolve the owner from the repository's `owner.id`, never the
 * handle in the URL.
 *
 * Server-only (`node:sqlite`).
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { shouldUseSupabase } from './supabase-client'
import { getSupabaseRepoBadgeStore } from './supabase-repo-badge-store'

export interface RepoBadgeRecord {
  readonly handle: string
  readonly updatedAt: string
}

export interface RepoBadgeStore {
  /** The opt-in record, or null when the owner has not opted in. */
  get(githubId: number): Promise<RepoBadgeRecord | null>
  /** Opt in (or refresh the timestamp). */
  put(githubId: number, handle: string, updatedAt: string): Promise<void>
  /** Opt out: the row is removed and the default (off) applies. */
  remove(githubId: number): Promise<void>
}

export function defaultRepoBadgeDbPath(): string {
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
  updated_at: string
}

export class RepoBadgeSqliteStore implements RepoBadgeStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string = defaultRepoBadgeDbPath()) {
    ensureDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_badge_display (
        github_id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  async get(githubId: number): Promise<RepoBadgeRecord | null> {
    if (!Number.isSafeInteger(githubId)) return null
    const row = this.db
      .prepare('SELECT github_id, handle, updated_at FROM repo_badge_display WHERE github_id = ?')
      .get(githubId) as Row | undefined
    return row ? { handle: row.handle, updatedAt: row.updated_at } : null
  }

  async put(githubId: number, handle: string, updatedAt: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO repo_badge_display (github_id, handle, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           handle = excluded.handle,
           updated_at = excluded.updated_at`,
      )
      .run(githubId, handle.toLowerCase(), updatedAt)
  }

  async remove(githubId: number): Promise<void> {
    this.db.prepare('DELETE FROM repo_badge_display WHERE github_id = ?').run(githubId)
  }
}

let singleton: RepoBadgeSqliteStore | null = null

export function getRepoBadgeStore(): RepoBadgeStore {
  if (shouldUseSupabase()) return getSupabaseRepoBadgeStore()
  if (!singleton) singleton = new RepoBadgeSqliteStore()
  return singleton
}

/** Test-only reset; production callers use the singleton. */
export function resetRepoBadgeStoreForTests(dbPath: string = ':memory:'): RepoBadgeSqliteStore {
  singleton = new RepoBadgeSqliteStore(dbPath)
  return singleton
}
