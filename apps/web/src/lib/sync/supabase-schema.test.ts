/**
 * Schema contract for the Supabase-backed GitHub account and product stores.
 *
 * Every unit test of these stores mocks `getSupabaseAdminClient`, so a column
 * an adapter reads or writes but no migration defines stays green in the suite
 * and fails only against a real database: PostgREST answers 42703, the adapter
 * throws, and OAuth sign-in collapses to `?signin=failed`. This test closes
 * that blind spot by recording the columns the adapter actually sends and
 * asserting each one exists in `supabase/migrations/`.
 *
 * The migration SQL is read from the repository root. These tests run under
 * Node and never touch the network.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseAdminClient } from './supabase-client'
import { PROTOTYPE_COMPANION_CATALOG } from '../game/companion-catalog'
import { createEncounterState } from '../game/encounters'
import { createGuestProfile } from '../game/guest-profile'
import { createProductState } from '../game/product-state'
import { buildProductSnapshot } from './product-snapshot'
import { SupabaseGithubAccountStore } from './supabase-github-account-store'
import { SupabaseProductStore } from './supabase-product-store'

vi.mock('./supabase-client', () => ({
  getSupabaseAdminClient: vi.fn(),
}))

const mockedGetClient = vi.mocked(getSupabaseAdminClient)

const identity = { handle: 'Octocat', githubId: 42, avatarUrl: null }
const settings = {
  trackedRepositoryIds: ['101'],
  excludedRepositoryIds: [],
  autoIncludePersonal: false,
  autoIncludeOrganizations: [],
  baselineByRepositoryId: { '101': '2026-01-01T00:00:00.000Z' },
  lastSyncedAt: '2026-01-01T00:00:00.000Z',
}

/** The row `maybeSingle` answers with, so every read path can run to completion. */
const accountRow = {
  github_id: 42,
  handle: 'octocat',
  token_iv: 'iv',
  token_tag: 'tag',
  token_ciphertext: 'ciphertext',
  scopes_json: [],
  tracked_repository_ids_json: ['101'],
  excluded_repository_ids_json: [],
  auto_include_personal: false,
  auto_include_organizations_json: [],
  baseline_by_repository_id_json: {},
  last_synced_at: null,
  disconnected_at: null,
}

/**
 * A chainable stand-in for the PostgREST builder that records every column
 * name the adapter selects, filters on, or writes.
 */
function recordingClient(responseRow: unknown = accountRow): {
  client: unknown
  columns: Set<string>
  payloadKeys: Set<string>
} {
  const columns = new Set<string>()
  const payloadKeys = new Set<string>()
  const recordPayload = (payload: unknown) => {
    for (const key of Object.keys(payload as Record<string, unknown>)) payloadKeys.add(key)
  }
  const chain: Record<string, unknown> = {}
  chain.select = (value?: unknown) => {
    if (typeof value === 'string') {
      for (const column of value.split(',')) {
        const trimmed = column.trim()
        if (trimmed) columns.add(trimmed)
      }
    }
    return chain
  }
  chain.eq = (column: unknown) => {
    if (typeof column === 'string') columns.add(column)
    return chain
  }
  chain.update = (payload: unknown) => {
    recordPayload(payload)
    return chain
  }
  chain.upsert = (payload: unknown) => {
    recordPayload(payload)
    return chain
  }
  chain.insert = (payload: unknown) => {
    recordPayload(payload)
    return chain
  }
  chain.delete = () => chain
  chain.maybeSingle = async () => ({ data: responseRow, error: null })
  return {
    client: { from: (_table: string) => chain },
    columns,
    payloadKeys,
  }
}

/** Column names declared for a public table across all migrations. */
function migratedTableColumns(tableName: string): Set<string> {
  const directory = path.join(process.cwd(), 'supabase', 'migrations')
  const columns = new Set<string>()
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(path.join(directory, file), 'utf8')
    const createBlock = sql.match(new RegExp(`create table if not exists public\\.${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`, 'iu'))
    if (createBlock) {
      for (const rawLine of createBlock[1].split('\n')) {
        const name = rawLine.trim().replace(/,$/u, '').split(/\s+/u)[0]
        if (/^[a-z_][a-z0-9_]*$/iu.test(name) && name.toLowerCase() !== 'constraint') {
          columns.add(name.toLowerCase())
        }
      }
    }
    const alter = new RegExp(
      `alter table public\\.${tableName}\\s+add column if not exists\\s+([a-z_][a-z0-9_]*)`,
      'giu',
    )
    for (const match of sql.matchAll(alter)) columns.add(match[1].toLowerCase())
  }
  return columns
}

describe('GitHub account schema contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32))
  })

  it('defines every column the Supabase adapter reads or writes', async () => {
    const { client, columns, payloadKeys } = recordingClient()
    mockedGetClient.mockReturnValue(client as never)
    const store = new SupabaseGithubAccountStore()

    // The decryption of the fake row fails; the select is recorded first.
    await store.putCredential(identity, 'ghu_secret', ['repo']).catch(() => undefined)
    await store.getToken(42).catch(() => undefined)
    await store.get(42).catch(() => undefined)
    await store.saveSettings(42, settings).catch(() => undefined)
    await store.advanceBaseline(42, settings.baselineByRepositoryId, settings.baselineByRepositoryId, null)
      .catch(() => undefined)
    await store.clearCredential(42).catch(() => undefined)
    await store.remove(42).catch(() => undefined)

    const migrated = migratedTableColumns('github_accounts')
    // Sanity: a broken migration parser must fail loudly instead of passing
    // vacuously.
    expect(migrated.has('github_id')).toBe(true)
    expect(migrated.has('disconnected_at')).toBe(true)

    const referenced = [...columns, ...payloadKeys]
    const missing = referenced.filter((column) => !migrated.has(column.toLowerCase()))
    expect(missing).toEqual([])
  })

  it('defines every column the Supabase product snapshot adapter reads or writes', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now })
    const snapshot = buildProductSnapshot(
      createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
      now,
    )
    const productRow = {
      github_id: 42,
      handle: 'octocat',
      snapshot_json: snapshot,
      updated_at: now,
      row_version: 'row-version-1',
    }
    const { client, columns, payloadKeys } = recordingClient(productRow)
    mockedGetClient.mockReturnValue(client as never)
    const store = new SupabaseProductStore()

    await store.put(42, 'Octocat', snapshot, now, null).catch(() => undefined)
    await store.put(42, 'Octocat', snapshot, '2026-01-02T00:00:00.000Z', now).catch(() => undefined)
    await store.getRecord(42).catch(() => undefined)
    await store.remove(42).catch(() => undefined)
    await store.removeIfVersion(42, 'row-version-1').catch(() => undefined)

    const migrated = migratedTableColumns('product_snapshots')
    // Sanity: a broken migration parser must fail loudly instead of passing
    // vacuously, especially for columns added by repair migrations.
    expect(migrated.has('github_id')).toBe(true)
    expect(migrated.has('snapshot_json')).toBe(true)
    expect(migrated.has('row_version')).toBe(true)

    const referenced = [...new Set([...columns, ...payloadKeys])]
    const missing = referenced.filter((column) => !migrated.has(column.toLowerCase()))
    expect(missing).toEqual([])
  })
})
