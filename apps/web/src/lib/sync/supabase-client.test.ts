import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSupabaseAdminClient,
  isSupabaseConfigured,
  resetSupabaseClientForTests,
  shouldUseSupabase,
} from './supabase-client'

describe('supabase storage configuration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    resetSupabaseClientForTests()
  })

  it('uses sqlite unless the hosted store is explicitly selected or configured', () => {
    expect(shouldUseSupabase()).toBe(false)

    vi.stubEnv('SYNC_STORE', 'supabase')
    expect(shouldUseSupabase()).toBe(true)

    vi.stubEnv('SYNC_STORE', 'sqlite')
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SECRET_KEY', 'secret')
    expect(shouldUseSupabase()).toBe(false)
  })

  it('accepts the newer secret key name and creates a non-persisting client', () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SECRET_KEY', 'secret')

    expect(isSupabaseConfigured()).toBe(true)
    expect(getSupabaseAdminClient()).toBe(getSupabaseAdminClient())
  })

  it('supports the legacy service-role key name when the newer key is absent', () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role')

    expect(isSupabaseConfigured()).toBe(true)
    expect(getSupabaseAdminClient()).toBe(getSupabaseAdminClient())
  })

  it('fails clearly when hosted storage is selected without credentials', () => {
    vi.stubEnv('SYNC_STORE', 'supabase')
    expect(() => getSupabaseAdminClient()).toThrow(/SUPABASE_URL/)
  })
})
