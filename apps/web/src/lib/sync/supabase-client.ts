/**
 * Server-only Supabase client for durable sync storage.
 *
 * Terrarium owns the GitHub OAuth/session flow, so this client is used as a
 * database client only. The secret/service key must never reach a client
 * bundle; all callers live behind server route or server-component imports.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let singleton: SupabaseClient | null = null

function envValue(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}
export function isSupabaseConfigured(): boolean {
  return Boolean(envValue('SUPABASE_URL') && (envValue('SUPABASE_SECRET_KEY') || envValue('SUPABASE_SERVICE_ROLE_KEY')))
}

/** Explicit sqlite keeps local development and tests deterministic. */
export function shouldUseSupabase(): boolean {
  const requested = envValue('SYNC_STORE')?.toLowerCase()
  if (requested === 'sqlite') return false
  if (requested === 'supabase') return true
  return isSupabaseConfigured()
}

export function getSupabaseAdminClient(): SupabaseClient {
  if (singleton) return singleton

  const url = envValue('SUPABASE_URL')
  const key = envValue('SUPABASE_SECRET_KEY') || envValue('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) {
    throw new Error(
      'Supabase storage requires SUPABASE_URL and SUPABASE_SECRET_KEY ' +
        '(or SUPABASE_SERVICE_ROLE_KEY).',
    )
  }

  singleton = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  })
  return singleton
}

/** Test-only reset; production code should reuse the singleton. */
export function resetSupabaseClientForTests(): void {
  singleton = null
}
