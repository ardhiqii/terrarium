/**
 * Contracts for the sync layer: accounts, stored snapshots, and sessions.
 *
 * THIS FILE IS THE INTERFACE BOUNDARY between the store (T28) and the
 * surfaces that read it (T29). Both build against it. Do not change a shape
 * here without updating every consumer, and do not create module-local
 * duplicates.
 *
 * THE RULE THAT DEFINES THIS WHOLE LAYER: note text never leaves the user's
 * device. Only derived state syncs. A Terrarium is half-diary, and
 * uploading it by default would create a privacy problem, an unbounded
 * storage cost, and a moderation burden. See docs/archive/tasks/PHASE3.md.
 *
 * `SyncedSnapshot` below is deliberately a closed shape with no free-form
 * string fields, so a future change cannot quietly start collecting note
 * content without someone editing this file and noticing.
 */

import type { StageId } from '../game/types'

/** Schema version, bumped when `SyncedSnapshot` changes shape. */
export const SNAPSHOT_SCHEMA_VERSION = 1

/**
 * What a client is allowed to upload. Numbers and enums only.
 *
 * Note titles, bodies, tag names, and repo descriptions are all absent on
 * purpose. Tag names in particular are tempting (they would make a prettier
 * companion list) and are still user-authored content, so they stay local.
 */
export interface SyncedSnapshot {
  schemaVersion: number
  /** Total XP across garden and commit sources. */
  totalXp: number
  stage: StageId
  /** 1-indexed, mirrors `Stage.index`. */
  stageIndex: number
  /** Counts only, never the notes themselves. */
  noteCount: number
  projectCount: number
  totalWords: number
  tagCount: number
  /** How many companions exist, and their stages. No tags, no repo names. */
  companions: { stage: StageId; stageIndex: number }[]
  /** Unlocked item ids. These are fixed enum values, not user content. */
  unlockedItemIds: string[]
  /** ISO timestamp the client generated this. */
  generatedAt: string
}

/** A synced user. Identity comes from GitHub, so the handle is the key. */
export interface SyncedUser {
  /** GitHub login, lowercased. Primary key. */
  handle: string
  /** GitHub numeric id, stable across renames. */
  githubId: number
  /** Avatar URL, for profiles and the leaderboard. */
  avatarUrl: string | null
  snapshot: SyncedSnapshot
  /** ISO timestamp of the last successful sync. */
  updatedAt: string
}

/**
 * Persistence. Implemented over SQLite today; a Postgres or Turso adapter can
 * satisfy the same interface later without touching a single caller, which is
 * the point of stating it here rather than importing a driver everywhere.
 *
 * Every method rejects rather than throwing synchronously.
 */
export interface SyncStore {
  /** Creates or replaces a user's snapshot. */
  put(user: SyncedUser): Promise<void>

  /** Null when the handle has never synced. */
  get(handle: string): Promise<SyncedUser | null>

  /**
   * Snapshots for the given handles, skipping any that have never synced.
   * Used by the leaderboard, which asks about everyone a user follows and
   * expects most of them to be absent.
   */
  getMany(handles: string[]): Promise<SyncedUser[]>

  /** Forgets a user entirely. Sync is opt-in, so opting out must be possible. */
  remove(handle: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Who is making a request. Null when signed out. */
export interface Session {
  handle: string
  githubId: number
  avatarUrl: string | null
}

/**
 * Authentication, behind an interface so the real GitHub OAuth flow and the
 * development stub are interchangeable.
 *
 * The stub exists so the sync layer, profiles, and leaderboard are all
 * testable before an OAuth app is registered. Swapping in the real
 * implementation must not require touching any caller.
 */
export interface SessionProvider {
  readonly id: 'stub' | 'github'
  /** Null when signed out. Never throws. */
  current(): Promise<Session | null>
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * One row. Scoped to people the viewer follows on GitHub, never global: a
 * global board on public commit data would be farmed by bots within a week,
 * and friend scope removes the incentive rather than trying to police it.
 */
export interface LeaderboardEntry {
  handle: string
  avatarUrl: string | null
  totalXp: number
  stage: StageId
  stageIndex: number
  companionCount: number
  /** True for the viewer's own row. */
  isViewer: boolean
}
