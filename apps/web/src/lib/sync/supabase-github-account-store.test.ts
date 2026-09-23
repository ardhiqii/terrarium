import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseAdminClient } from './supabase-client'
import { SupabaseGithubAccountStore } from './supabase-github-account-store'

vi.mock('./supabase-client', () => ({
  getSupabaseAdminClient: vi.fn(),
}))

const mockedGetClient = vi.mocked(getSupabaseAdminClient)

const identity = {
  handle: 'Torvalds',
  githubId: 42,
  avatarUrl: null,
}

describe('SupabaseGithubAccountStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32))
  })

  it('encrypts credentials and can decrypt them without storing plaintext', async () => {
    const maybeSingle = vi.fn().mockResolvedValueOnce({ data: null, error: null })
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
      upsert,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)
    const store = new SupabaseGithubAccountStore()

    await store.putCredential(identity, 'ghu_secret_token', ['repo'])
    const stored = upsert.mock.calls[0]?.[0]

    expect(stored).toEqual(expect.objectContaining({ github_id: 42, handle: 'torvalds' }))
    expect(stored.token_ciphertext).not.toBe('ghu_secret_token')
    expect(stored.token_iv).toEqual(expect.any(String))
    maybeSingle.mockResolvedValueOnce({
      data: {
        token_iv: stored.token_iv,
        token_tag: stored.token_tag,
        token_ciphertext: stored.token_ciphertext,
      },
      error: null,
    })
    expect(await store.getToken(42)).toBe('ghu_secret_token')
  })

  it('returns a normalized account and uses empty settings for an unknown account', async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({
        data: {
          github_id: 42,
          handle: 'torvalds',
          token_iv: 'iv',
          token_tag: 'tag',
          token_ciphertext: 'ciphertext',
          scopes_json: JSON.stringify(['repo', 'repo', 7]),
          tracked_repository_ids_json: JSON.stringify(['repo-1', 'repo-1']),
          excluded_repository_ids_json: ['repo-2', 7],
          auto_include_personal: 1,
          auto_include_organizations_json: ['Acme', 'acme'],
          baseline_by_repository_id_json: {
            'repo-1': '2024-01-01T00:00:00.000Z',
            invalid: 'not-a-date',
          },
          last_synced_at: '2024-01-02T00:00:00.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)
    const store = new SupabaseGithubAccountStore()

    await expect(store.get(42)).resolves.toMatchObject({
      githubId: 42,
      scopes: ['repo'],
      settings: {
        trackedRepositoryIds: ['repo-1'],
        excludedRepositoryIds: ['repo-2'],
        autoIncludePersonal: true,
        autoIncludeOrganizations: ['acme'],
        baselineByRepositoryId: { 'repo-1': '2024-01-01T00:00:00.000Z' },
      },
    })
    await expect(store.getSettings(42)).resolves.toEqual({
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    })
  })

  it('returns null for missing credentials and never queries without a session secret', async () => {
    vi.stubEnv('SESSION_SECRET', '')
    mockedGetClient.mockImplementation(() => { throw new Error('must not query') })
    await expect(new SupabaseGithubAccountStore().getToken(42)).resolves.toBeNull()

    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32))
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)
    await expect(new SupabaseGithubAccountStore().getToken(42)).resolves.toBeNull()
  })

  it('normalizes settings before sending them to Supabase', async () => {
    const update = vi.fn().mockReturnThis()
    const maybeSingle = vi.fn().mockResolvedValue({ data: { github_id: 42 }, error: null })
    const select = vi.fn().mockReturnValue({ maybeSingle })
    const eq = vi.fn().mockReturnValue({ select })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ update, eq }),
    } as never)

    await new SupabaseGithubAccountStore().saveSettings(42, {
      trackedRepositoryIds: ['repo-1', 'repo-1'],
      excludedRepositoryIds: ['repo-2'],
      autoIncludePersonal: true,
      autoIncludeOrganizations: ['Acme'],
      baselineByRepositoryId: { 'repo-1': '2024-01-01T00:00:00.000Z' },
      lastSyncedAt: '2024-01-02T00:00:00.000Z',
    })

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      tracked_repository_ids_json: ['repo-1'],
      auto_include_organizations_json: ['acme'],
    }))
    expect(eq).toHaveBeenCalledWith('github_id', 42)
  })

  it('rejects settings for a missing account and surfaces update errors', async () => {
    const missingMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const missingQuery = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnValue({ maybeSingle: missingMaybeSingle }),
      maybeSingle: missingMaybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(missingQuery) } as never)
    const settings = {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }
    await expect(new SupabaseGithubAccountStore().saveSettings(42, settings)).rejects.toThrow(
      'GitHub account credential not found',
    )

    const update = vi.fn().mockReturnThis()
    const eq = vi.fn().mockReturnThis()
    const select = vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'offline' } }),
    })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ update, eq, select }),
    } as never)
    await expect(new SupabaseGithubAccountStore().saveSettings(42, settings)).rejects.toThrow(
      'Supabase github_accounts.saveSettings failed: offline',
    )
  })

  it('clears the credential and baselines on disconnect while keeping choices', async () => {
    const update = vi.fn().mockReturnThis()
    const eq = vi.fn().mockReturnThis()
    const maybeSingle = vi.fn().mockResolvedValue({ data: { github_id: 42 }, error: null })
    const select = vi.fn().mockReturnValue({ maybeSingle })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ update, eq, select }),
    } as never)

    await new SupabaseGithubAccountStore().clearCredential(42)

    expect(eq).toHaveBeenCalledWith('github_id', 42)
    const sent = update.mock.calls[0]?.[0] as Record<string, unknown>
    expect(sent).toMatchObject({
      token_iv: '',
      token_tag: '',
      token_ciphertext: '',
      scopes_json: [],
      baseline_by_repository_id_json: {},
      last_synced_at: null,
      disconnected_at: expect.any(String),
    })
    // The row survives, so the user's repository choices are untouched.
    expect(sent).not.toHaveProperty('tracked_repository_ids_json')
    expect(sent).not.toHaveProperty('excluded_repository_ids_json')
    expect(sent).not.toHaveProperty('auto_include_personal')
  })

  it('treats a missing account row as already disconnected and still reports database failures', async () => {
    // A session whose account row is gone is disconnected already. Rejecting
    // the call would leave the panel answering 500 forever on a no-op.
    const update = vi.fn().mockReturnThis()
    const eq = vi.fn().mockReturnThis()
    const select = vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ update, eq, select }),
    } as never)
    await expect(new SupabaseGithubAccountStore().clearCredential(42)).resolves.toBeUndefined()

    const errorSelect = vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'denied' } }),
    })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ update, eq, select: errorSelect }),
    } as never)
    await expect(new SupabaseGithubAccountStore().clearCredential(42)).rejects.toThrow(
      'Supabase github_accounts.clearCredential failed: denied',
    )
  })

  it('removes accounts and reports database failures', async () => {
    const removeEq = vi.fn().mockResolvedValue({ error: null })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue({ eq: removeEq }) }),
    } as never)
    await new SupabaseGithubAccountStore().remove(42)
    expect(removeEq).toHaveBeenCalledWith('github_id', 42)

    const errorEq = vi.fn().mockResolvedValue({ error: { message: 'denied' } })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue({ eq: errorEq }) }),
    } as never)
    await expect(new SupabaseGithubAccountStore().remove(42)).rejects.toThrow(
      'Supabase github_accounts.remove failed: denied',
    )
  })

  it('sends the baseline concurrency guard as JSON text, not a raw object', async () => {
    // REGRESSION: `baseline_by_repository_id_json` is a jsonb column, and
    // supabase-js turns a filter value that is not a string into
    // `String(value)`. Passing the object therefore sent `[object Object]`,
    // Postgres rejected the statement with "invalid input syntax for type
    // json", the update threw, and the route answered a bodyless 500. The
    // baseline was never committed, so every sync re-baselined and the account
    // could never earn XP.
    const baseline = { 'repo-1': '2024-01-01T00:00:00.000Z' }
    const next = { 'repo-1': '2024-02-01T00:00:00.000Z' }
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({
        data: {
          github_id: 42,
          handle: 'torvalds',
          token_iv: 'iv',
          token_tag: 'tag',
          token_ciphertext: 'ciphertext',
          scopes_json: [],
          tracked_repository_ids_json: [],
          excluded_repository_ids_json: [],
          auto_include_personal: false,
          auto_include_organizations_json: [],
          baseline_by_repository_id_json: baseline,
          last_synced_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { github_id: 42 }, error: null })
    const eq = vi.fn().mockReturnThis()
    const query = {
      select: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq,
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)

    const advanced = await new SupabaseGithubAccountStore()
      .advanceBaseline(42, baseline, next, '2024-02-01T00:00:00.000Z')

    expect(advanced).toBe(true)
    const guard = eq.mock.calls.find((call) => call[0] === 'baseline_by_repository_id_json')
    expect(guard).toBeDefined()
    // A raw object here is the bug: PostgREST receives `[object Object]`.
    expect(typeof guard?.[1]).toBe('string')
    expect(JSON.parse(String(guard?.[1]))).toEqual(baseline)
  })
})
