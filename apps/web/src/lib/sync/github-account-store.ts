/**
 * Server-only GitHub credentials and source settings.
 *
 * The browser receives a signed identity cookie, never the OAuth token. This
 * store keeps the token encrypted at rest so the server can re-read the
 * repositories the user explicitly selected on a later sync. The account's
 * repository IDs and baselines live beside it because those are source state,
 * not browser session state.
 *
 * This is a small local/hosted-server adapter, matching the existing SQLite
 * stores. A durable hosted database and key-management service are still a
 * deployment concern before relying on this on a multi-instance platform.
 */

import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { getSessionSecret } from './session-cookie'
import type { GithubIdentity } from './github-oauth'
import { decryptGithubToken, encryptGithubToken } from './github-token-crypto'
import { getSupabaseGithubAccountStore } from './supabase-github-account-store'
import { shouldUseSupabase } from './supabase-client'

export interface GithubAccountSettings {
  readonly trackedRepositoryIds: readonly string[]
  readonly excludedRepositoryIds: readonly string[]
  readonly autoIncludePersonal: boolean
  readonly autoIncludeOrganizations: readonly string[]
  readonly baselineByRepositoryId: Readonly<Record<string, string>>
  readonly lastSyncedAt: string | null
}

export interface GithubAccountRecord {
  readonly githubId: number
  readonly handle: string
  readonly scopes: readonly string[]
  readonly settings: GithubAccountSettings
  /** A disconnected row cannot accept a delayed checkpoint commit. */
  readonly disconnectedAt: string | null
}

export interface GithubAccountStore {
  putCredential(
    identity: GithubIdentity,
    token: string,
    scopes: readonly string[],
  ): Promise<void>
  getToken(githubId: number): Promise<string | null>
  get(githubId: number): Promise<GithubAccountRecord | null>
  getSettings(githubId: number): Promise<GithubAccountSettings>
  saveSettings(githubId: number, settings: GithubAccountSettings): Promise<void>
  /** Advance a sync baseline only if it is still the expected checkpoint. */
  advanceBaseline(
    githubId: number,
    expectedBaselineByRepositoryId: Readonly<Record<string, string>>,
    nextBaselineByRepositoryId: Readonly<Record<string, string>>,
    lastSyncedAt: string | null,
  ): Promise<boolean>
  /**
   * Disconnect: drop the OAuth credential and every sync baseline, while
   * keeping the account row, its handle, and the user's repository choices.
   * The row survives because the choices in it are the user's, not the
   * token's: reconnecting must resume the same selections, but with a fresh
   * checkpoint so a disconnected window is never backfilled as new work.
   */
  clearCredential(githubId: number): Promise<void>
  remove(githubId: number): Promise<void>
}

interface Row {
  github_id: number
  handle: string
  token_iv: string
  token_tag: string
  token_ciphertext: string
  scopes_json: string
  tracked_repository_ids_json: string
  excluded_repository_ids_json: string
  auto_include_personal: number
  auto_include_organizations_json: string
  baseline_by_repository_id_json: string
  last_synced_at: string | null
  /** Set when the user disconnected; the token columns are empty then. */
  disconnected_at: string | null
}

function defaultDbPath(): string {
  if (process.env.SYNC_DB_PATH) return process.env.SYNC_DB_PATH
  if (process.env.VITEST) return ':memory:'
  return path.join(process.cwd(), '.data', 'sync.db')
}

function ensureDir(dbPath: string): void {
  if (dbPath === ':memory:') return
  mkdirSync(path.dirname(dbPath), { recursive: true })
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function uniqueOrganizations(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
}

function defaultSettings(): GithubAccountSettings {
  return {
    trackedRepositoryIds: [],
    excludedRepositoryIds: [],
    autoIncludePersonal: false,
    autoIncludeOrganizations: [],
    baselineByRepositoryId: {},
    lastSyncedAt: null,
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function rowSettings(row: Row): GithubAccountSettings {
  const baseline = parseJson<Record<string, string>>(row.baseline_by_repository_id_json, {})
  const baselineByRepositoryId: Record<string, string> = {}
  for (const [repositoryId, timestamp] of Object.entries(baseline)) {
    if (repositoryId.trim() && typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))) {
      baselineByRepositoryId[repositoryId] = timestamp
    }
  }
  return {
    trackedRepositoryIds: uniqueStrings(parseJson<string[]>(row.tracked_repository_ids_json, [])),
    excludedRepositoryIds: uniqueStrings(parseJson<string[]>(row.excluded_repository_ids_json, [])),
    autoIncludePersonal: row.auto_include_personal === 1,
    autoIncludeOrganizations: uniqueOrganizations(
      parseJson<string[]>(row.auto_include_organizations_json, []),
    ),
    baselineByRepositoryId,
    lastSyncedAt: row.last_synced_at,
  }
}

function rowToAccount(row: Row): GithubAccountRecord {
  return {
    githubId: Number(row.github_id),
    handle: row.handle,
    scopes: uniqueStrings(parseJson<string[]>(row.scopes_json, [])),
    settings: rowSettings(row),
    disconnectedAt: row.disconnected_at,
  }
}

function cleanSettings(settings: GithubAccountSettings): GithubAccountSettings {
  const baselineByRepositoryId: Record<string, string> = {}
  for (const [repositoryId, timestamp] of Object.entries(settings.baselineByRepositoryId)) {
    if (repositoryId.trim() && !Number.isNaN(Date.parse(timestamp))) {
      baselineByRepositoryId[repositoryId.trim()] = timestamp
    }
  }
  return {
    trackedRepositoryIds: uniqueStrings(settings.trackedRepositoryIds),
    excludedRepositoryIds: uniqueStrings(settings.excludedRepositoryIds),
    autoIncludePersonal: settings.autoIncludePersonal === true,
    autoIncludeOrganizations: uniqueOrganizations(settings.autoIncludeOrganizations),
    baselineByRepositoryId,
    lastSyncedAt: settings.lastSyncedAt && !Number.isNaN(Date.parse(settings.lastSyncedAt))
      ? settings.lastSyncedAt
      : null,
  }
}

function sameBaselineMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && left[key] === right[key],
  )
}

/** Never let a replayed or delayed checkpoint move the successful time back. */
function latestTimestamp(current: string | null, next: string | null): string | null {
  if (!current || Number.isNaN(Date.parse(current))) return next && !Number.isNaN(Date.parse(next)) ? next : null
  if (!next || Number.isNaN(Date.parse(next))) return current
  return Date.parse(next) > Date.parse(current) ? next : current
}

export class GithubAccountSqliteStore implements GithubAccountStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string = defaultDbPath()) {
    ensureDir(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS github_accounts (
        github_id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        token_tag TEXT NOT NULL,
        token_ciphertext TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        tracked_repository_ids_json TEXT NOT NULL,
        excluded_repository_ids_json TEXT NOT NULL DEFAULT '[]',
        auto_include_personal INTEGER NOT NULL,
        auto_include_organizations_json TEXT NOT NULL,
        baseline_by_repository_id_json TEXT NOT NULL,
        last_synced_at TEXT,
        disconnected_at TEXT
      )
    `)
    // Development databases created before manual auto-inclusion exclusions
    // existed need a tiny additive migration; no data is rewritten.
    try {
      this.db.exec("ALTER TABLE github_accounts ADD COLUMN excluded_repository_ids_json TEXT NOT NULL DEFAULT '[]'")
    } catch {
      // The column already exists.
    }
    // Disconnect keeps the account row (and the user's repository choices) and
    // only clears the credential, so the row needs a way to say "no token".
    try {
      this.db.exec('ALTER TABLE github_accounts ADD COLUMN disconnected_at TEXT')
    } catch {
      // The column already exists.
    }
  }

  private row(githubId: number): Row | undefined {
    return this.db
      .prepare('SELECT * FROM github_accounts WHERE github_id = ?')
      .get(githubId) as Row | undefined
  }

  async putCredential(
    identity: GithubIdentity,
    token: string,
    scopes: readonly string[],
  ): Promise<void> {
    const secret = getSessionSecret()
    if (!secret) throw new Error('SESSION_SECRET is required to store GitHub credentials')
    const normalizedToken = token.trim()
    if (!normalizedToken) throw new TypeError('GitHub token must not be empty')
    const current = this.row(identity.githubId)
    const settings = current ? rowSettings(current) : defaultSettings()
    const encrypted = encryptGithubToken(normalizedToken, secret)
    this.db
      .prepare(
        `INSERT INTO github_accounts (
           github_id, handle, token_iv, token_tag, token_ciphertext, scopes_json,
           tracked_repository_ids_json, excluded_repository_ids_json, auto_include_personal,
           auto_include_organizations_json, baseline_by_repository_id_json, last_synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           handle = excluded.handle,
           token_iv = excluded.token_iv,
           token_tag = excluded.token_tag,
           token_ciphertext = excluded.token_ciphertext,
           scopes_json = excluded.scopes_json,
           disconnected_at = NULL`,
      )
      .run(
        identity.githubId,
        identity.handle.toLowerCase(),
        encrypted.iv,
        encrypted.tag,
        encrypted.ciphertext,
        JSON.stringify(uniqueStrings(scopes)),
        JSON.stringify(settings.trackedRepositoryIds),
        JSON.stringify(settings.excludedRepositoryIds),
        settings.autoIncludePersonal ? 1 : 0,
        JSON.stringify(settings.autoIncludeOrganizations),
        JSON.stringify(settings.baselineByRepositoryId),
        settings.lastSyncedAt,
      )
  }

  async getToken(githubId: number): Promise<string | null> {
    const secret = getSessionSecret()
    if (!secret) return null
    const row = this.row(githubId)
    // A disconnected row keeps its handle and repository choices but has no
    // credential; the explicit marker is checked before any decryption so a
    // future change to the encrypted-column defaults cannot resurrect it.
    if (!row || row.disconnected_at) return null
    if (!row.token_iv || !row.token_tag || !row.token_ciphertext) return null
    return decryptGithubToken(
      { iv: row.token_iv, tag: row.token_tag, ciphertext: row.token_ciphertext },
      secret,
    )
  }

  async get(githubId: number): Promise<GithubAccountRecord | null> {
    const row = this.row(githubId)
    return row ? rowToAccount(row) : null
  }

  async getSettings(githubId: number): Promise<GithubAccountSettings> {
    const account = await this.get(githubId)
    return account?.settings ?? defaultSettings()
  }

  async saveSettings(githubId: number, settings: GithubAccountSettings): Promise<void> {
    const row = this.row(githubId)
    if (!row) throw new Error('GitHub account credential not found')
    const clean = cleanSettings(settings)
    this.db
      .prepare(
        `UPDATE github_accounts SET
           tracked_repository_ids_json = ?,
           excluded_repository_ids_json = ?,
           auto_include_personal = ?,
           auto_include_organizations_json = ?,
           baseline_by_repository_id_json = ?,
           last_synced_at = ?
         WHERE github_id = ?`,
      )
      .run(
        JSON.stringify(clean.trackedRepositoryIds),
        JSON.stringify(clean.excludedRepositoryIds),
        clean.autoIncludePersonal ? 1 : 0,
        JSON.stringify(clean.autoIncludeOrganizations),
        JSON.stringify(clean.baselineByRepositoryId),
        clean.lastSyncedAt,
        githubId,
      )
  }

  async advanceBaseline(
    githubId: number,
    expectedBaselineByRepositoryId: Readonly<Record<string, string>>,
    nextBaselineByRepositoryId: Readonly<Record<string, string>>,
    lastSyncedAt: string | null,
  ): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.row(githubId)
      if (!row) throw new Error('GitHub account credential not found')
      if (row.disconnected_at) {
        this.db.exec('COMMIT')
        return false
      }
      const current = rowSettings(row)
      const nextSuccessfulAt = latestTimestamp(current.lastSyncedAt, lastSyncedAt)
      const sameNextBaseline = sameBaselineMap(current.baselineByRepositoryId, nextBaselineByRepositoryId)
      if (!sameNextBaseline && !sameBaselineMap(current.baselineByRepositoryId, expectedBaselineByRepositoryId)) {
        this.db.exec('COMMIT')
        return false
      }
      // A product retry can legitimately carry the same baseline map after a
      // prior product write failed or an old deployment left lastSyncedAt null.
      // Record the newer successful checkpoint even when no repository key
      // changed, while keeping timestamp updates monotonic.
      const clean = cleanSettings({
        ...current,
        baselineByRepositoryId: sameNextBaseline
          ? current.baselineByRepositoryId
          : nextBaselineByRepositoryId,
        lastSyncedAt: nextSuccessfulAt,
      })
      if (
        sameNextBaseline &&
        clean.lastSyncedAt === current.lastSyncedAt
      ) {
        this.db.exec('COMMIT')
        return true
      }
      this.db
        .prepare(
          `UPDATE github_accounts SET
             baseline_by_repository_id_json = ?,
             last_synced_at = ?
           WHERE github_id = ?`,
        )
        .run(JSON.stringify(clean.baselineByRepositoryId), clean.lastSyncedAt, githubId)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* transaction already ended */ }
      throw error
    }
  }

  async clearCredential(githubId: number): Promise<void> {
    // The token columns are NOT NULL, so they are emptied rather than nulled.
    // `disconnected_at` is what actually marks the row as disconnected: the
    // empty ciphertext is a storage detail, not the contract.
    this.db
      .prepare(
        `UPDATE github_accounts SET
           token_iv = '',
           token_tag = '',
           token_ciphertext = '',
           scopes_json = '[]',
           baseline_by_repository_id_json = '{}',
           last_synced_at = NULL,
           disconnected_at = ?
         WHERE github_id = ?`,
      )
      .run(new Date().toISOString(), githubId)
  }

  async remove(githubId: number): Promise<void> {
    this.db.prepare('DELETE FROM github_accounts WHERE github_id = ?').run(githubId)
  }
}

let singleton: GithubAccountSqliteStore | null = null

export function getGithubAccountStore(): GithubAccountStore {
  if (shouldUseSupabase()) return getSupabaseGithubAccountStore()
  if (!singleton) singleton = new GithubAccountSqliteStore()
  return singleton
}

/** Test-only reset; production callers should use the singleton. */
export function resetGithubAccountStoreForTests(
  dbPath: string = ':memory:',
): GithubAccountSqliteStore {
  singleton = new GithubAccountSqliteStore(dbPath)
  return singleton
}
