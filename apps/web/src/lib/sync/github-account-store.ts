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

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { getSessionSecret } from './session-cookie'
import type { GithubIdentity } from './github-oauth'

const CIPHER = 'aes-256-gcm'
const IV_BYTES = 12

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

function keyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(`terrarium:github-token:${secret}`).digest()
}

function encryptToken(token: string, secret: string): {
  iv: string
  tag: string
  ciphertext: string
} {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER, keyFromSecret(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

function decryptToken(row: Row, secret: string): string | null {
  try {
    const decipher = createDecipheriv(
      CIPHER,
      keyFromSecret(secret),
      Buffer.from(row.token_iv, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(row.token_tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(row.token_ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
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
    autoIncludeOrganizations: uniqueStrings(
      parseJson<string[]>(row.auto_include_organizations_json, []),
    ).map((value) => value.toLowerCase()),
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
    autoIncludeOrganizations: uniqueStrings(settings.autoIncludeOrganizations).map((value) =>
      value.toLowerCase(),
    ),
    baselineByRepositoryId,
    lastSyncedAt: settings.lastSyncedAt && !Number.isNaN(Date.parse(settings.lastSyncedAt))
      ? settings.lastSyncedAt
      : null,
  }
}

export class GithubAccountSqliteStore {
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
        last_synced_at TEXT
      )
    `)
    // Development databases created before manual auto-inclusion exclusions
    // existed need a tiny additive migration; no data is rewritten.
    try {
      this.db.exec("ALTER TABLE github_accounts ADD COLUMN excluded_repository_ids_json TEXT NOT NULL DEFAULT '[]'")
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
    const encrypted = encryptToken(normalizedToken, secret)
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
           scopes_json = excluded.scopes_json`,
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
    return row ? decryptToken(row, secret) : null
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

  async remove(githubId: number): Promise<void> {
    this.db.prepare('DELETE FROM github_accounts WHERE github_id = ?').run(githubId)
  }
}

let singleton: GithubAccountSqliteStore | null = null

export function getGithubAccountStore(): GithubAccountSqliteStore {
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
