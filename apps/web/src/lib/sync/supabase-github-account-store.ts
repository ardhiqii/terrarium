/** Supabase implementation of the server-only GitHub account store. */

import { getSessionSecret } from './session-cookie'
import type { GithubIdentity } from './github-oauth'
import type {
  GithubAccountRecord,
  GithubAccountSettings,
  GithubAccountStore,
} from './github-account-store'
import { decryptGithubToken, encryptGithubToken } from './github-token-crypto'
import { getSupabaseAdminClient } from './supabase-client'

interface AccountRow {
  github_id: number
  handle: string
  token_iv: string
  token_tag: string
  token_ciphertext: string
  scopes_json: unknown
  tracked_repository_ids_json: unknown
  excluded_repository_ids_json: unknown
  auto_include_personal: boolean | number
  auto_include_organizations_json: unknown
  baseline_by_repository_id_json: unknown
  last_synced_at: string | null
  disconnected_at?: string | null
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function uniqueOrganizations(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') {
    try {
      return jsonArray(JSON.parse(value))
    } catch {
      return []
    }
  }
  return []
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      return jsonRecord(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return {}
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

function rowSettings(row: AccountRow): GithubAccountSettings {
  const baselineByRepositoryId: Record<string, string> = {}
  for (const [repositoryId, timestamp] of Object.entries(jsonRecord(row.baseline_by_repository_id_json))) {
    if (repositoryId.trim() && typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))) {
      baselineByRepositoryId[repositoryId] = timestamp
    }
  }
  return {
    trackedRepositoryIds: uniqueStrings(jsonArray(row.tracked_repository_ids_json)),
    excludedRepositoryIds: uniqueStrings(jsonArray(row.excluded_repository_ids_json)),
    autoIncludePersonal: row.auto_include_personal === true || row.auto_include_personal === 1,
    autoIncludeOrganizations: uniqueOrganizations(jsonArray(row.auto_include_organizations_json)),
    baselineByRepositoryId,
    lastSyncedAt: row.last_synced_at,
  }
}

function rowToAccount(row: AccountRow): GithubAccountRecord {
  return {
    githubId: Number(row.github_id),
    handle: row.handle,
    scopes: uniqueStrings(jsonArray(row.scopes_json)),
    settings: rowSettings(row),
    disconnectedAt: row.disconnected_at ?? null,
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

function throwDatabaseError(operation: string, error: { message: string }): never {
  throw new Error(`Supabase ${operation} failed: ${error.message}`)
}

const ACCOUNT_COLUMNS = [
  'github_id',
  'handle',
  'token_iv',
  'token_tag',
  'token_ciphertext',
  'scopes_json',
  'tracked_repository_ids_json',
  'excluded_repository_ids_json',
  'auto_include_personal',
  'auto_include_organizations_json',
  'baseline_by_repository_id_json',
  'last_synced_at',
  'disconnected_at',
].join(', ')

export class SupabaseGithubAccountStore implements GithubAccountStore {
  async putCredential(
    identity: GithubIdentity,
    token: string,
    scopes: readonly string[],
  ): Promise<void> {
    const secret = getSessionSecret()
    if (!secret) throw new Error('SESSION_SECRET is required to store GitHub credentials')
    const normalizedToken = token.trim()
    if (!normalizedToken) throw new TypeError('GitHub token must not be empty')
    const current = await this.get(identity.githubId)
    const settings = current?.settings ?? defaultSettings()
    const encrypted = encryptGithubToken(normalizedToken, secret)
    const { error } = await getSupabaseAdminClient()
      .from('github_accounts')
      .upsert(
        {
          github_id: identity.githubId,
          handle: identity.handle.toLowerCase(),
          token_iv: encrypted.iv,
          token_tag: encrypted.tag,
          token_ciphertext: encrypted.ciphertext,
          scopes_json: uniqueStrings(scopes),
          tracked_repository_ids_json: settings.trackedRepositoryIds,
          excluded_repository_ids_json: settings.excludedRepositoryIds,
          auto_include_personal: settings.autoIncludePersonal,
          auto_include_organizations_json: settings.autoIncludeOrganizations,
          baseline_by_repository_id_json: settings.baselineByRepositoryId,
          last_synced_at: settings.lastSyncedAt,
          // Reconnecting clears the disconnect marker; the row's repository
          // choices and handle are preserved on purpose.
          disconnected_at: null,
        },
        { onConflict: 'github_id' },
      )
    if (error) throwDatabaseError('github_accounts.putCredential', error)
  }

  async getToken(githubId: number): Promise<string | null> {
    const secret = getSessionSecret()
    if (!secret) return null
    const { data, error } = await getSupabaseAdminClient()
      .from('github_accounts')
      .select('token_iv, token_tag, token_ciphertext, disconnected_at')
      .eq('github_id', githubId)
      .maybeSingle()
    if (error) throwDatabaseError('github_accounts.getToken', error)
    if (!data) return null
    const row = data as Pick<AccountRow, 'token_iv' | 'token_tag' | 'token_ciphertext' | 'disconnected_at'>
    if (row.disconnected_at) return null
    if (!row.token_iv || !row.token_tag || !row.token_ciphertext) return null
    return decryptGithubToken(
      { iv: row.token_iv, tag: row.token_tag, ciphertext: row.token_ciphertext },
      secret,
    )
  }

  async get(githubId: number): Promise<GithubAccountRecord | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from('github_accounts')
      .select(ACCOUNT_COLUMNS)
      .eq('github_id', githubId)
      .maybeSingle()
    if (error) throwDatabaseError('github_accounts.get', error)
    return data ? rowToAccount(data as unknown as AccountRow) : null
  }

  async getSettings(githubId: number): Promise<GithubAccountSettings> {
    const account = await this.get(githubId)
    return account?.settings ?? defaultSettings()
  }

  async saveSettings(githubId: number, settings: GithubAccountSettings): Promise<void> {
    const clean = cleanSettings(settings)
    const { data, error } = await getSupabaseAdminClient()
      .from('github_accounts')
      .update({
        tracked_repository_ids_json: clean.trackedRepositoryIds,
        excluded_repository_ids_json: clean.excludedRepositoryIds,
        auto_include_personal: clean.autoIncludePersonal,
        auto_include_organizations_json: clean.autoIncludeOrganizations,
        baseline_by_repository_id_json: clean.baselineByRepositoryId,
        last_synced_at: clean.lastSyncedAt,
      })
      .eq('github_id', githubId)
      .select('github_id')
      .maybeSingle()
    if (error) throwDatabaseError('github_accounts.saveSettings', error)
    if (!data) throw new Error('GitHub account credential not found')
  }

  async advanceBaseline(
    githubId: number,
    expectedBaselineByRepositoryId: Readonly<Record<string, string>>,
    nextBaselineByRepositoryId: Readonly<Record<string, string>>,
    lastSyncedAt: string | null,
  ): Promise<boolean> {
    const current = await this.get(githubId)
    if (!current) throw new Error('GitHub account credential not found')
    if (current.disconnectedAt) return false
    const sameNextBaseline = sameBaselineMap(current.settings.baselineByRepositoryId, nextBaselineByRepositoryId)
    if (!sameNextBaseline && !sameBaselineMap(current.settings.baselineByRepositoryId, expectedBaselineByRepositoryId)) return false

    const cleanNext = cleanSettings({
      ...current.settings,
      baselineByRepositoryId: sameNextBaseline
        ? current.settings.baselineByRepositoryId
        : nextBaselineByRepositoryId,
      lastSyncedAt: latestTimestamp(current.settings.lastSyncedAt, lastSyncedAt),
    })
    if (sameNextBaseline && cleanNext.lastSyncedAt === current.settings.lastSyncedAt) return true

    const { data, error } = await getSupabaseAdminClient()
      .from('github_accounts')
      .update({
        baseline_by_repository_id_json: cleanNext.baselineByRepositoryId,
        last_synced_at: cleanNext.lastSyncedAt,
      })
      .eq('github_id', githubId)
      // THE GUARD MUST BE SENT AS JSON TEXT. `baseline_by_repository_id_json`
      // is a jsonb column, and supabase-js turns a filter value that is not a
      // string into `String(value)` — so passing the object itself produced
      // `[object Object]` and Postgres rejected the whole statement with
      // "invalid input syntax for type json". The update threw, the route
      // answered a bodyless 500, and the baseline was never committed, which is
      // why every sync re-baselined and no XP was ever awarded.
      .eq('baseline_by_repository_id_json', JSON.stringify(current.settings.baselineByRepositoryId))
      .select('github_id')
      .maybeSingle()
    if (error) throwDatabaseError('github_accounts.advanceBaseline', error)
    if (data) return true
    const latest = await this.get(githubId)
    return Boolean(latest && sameBaselineMap(latest.settings.baselineByRepositoryId, nextBaselineByRepositoryId))
  }

  async clearCredential(githubId: number): Promise<void> {
    // The token columns are NOT NULL, so they are emptied rather than nulled.
    // `disconnected_at` is what actually marks the row as disconnected. The
    // repository choices and handle are deliberately left untouched.
    const { error } = await getSupabaseAdminClient()
      .from('github_accounts')
      .update({
        token_iv: '',
        token_tag: '',
        token_ciphertext: '',
        scopes_json: [],
        baseline_by_repository_id_json: {},
        last_synced_at: null,
        disconnected_at: new Date().toISOString(),
      })
      .eq('github_id', githubId)
      .select('github_id')
      .maybeSingle()
    if (error) throwDatabaseError('github_accounts.clearCredential', error)
    // No row means the account is already gone, which is disconnected by
    // definition. The SQLite adapter's `UPDATE ... WHERE` is a no-op there,
    // and rejecting made the panel answer 500 forever for a session that has
    // nothing left to disconnect.
  }

  async remove(githubId: number): Promise<void> {
    const { error } = await getSupabaseAdminClient()
      .from('github_accounts')
      .delete()
      .eq('github_id', githubId)
    if (error) throwDatabaseError('github_accounts.remove', error)
  }
}

let singleton: SupabaseGithubAccountStore | null = null

export function getSupabaseGithubAccountStore(): SupabaseGithubAccountStore {
  if (!singleton) singleton = new SupabaseGithubAccountStore()
  return singleton
}

export function resetSupabaseGithubAccountStoreForTests(): void {
  singleton = null
}
