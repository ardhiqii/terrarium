/** Supabase implementation of the dressed-repo badge opt-in store. */

import type { RepoBadgeRecord, RepoBadgeStore } from './repo-badge-store'
import { getSupabaseAdminClient } from './supabase-client'

interface Row {
  github_id: number
  handle: string
  updated_at: string
}

function throwDatabaseError(operation: string, error: { message: string }): never {
  throw new Error(`Supabase ${operation} failed: ${error.message}`)
}

export class SupabaseRepoBadgeStore implements RepoBadgeStore {
  async get(githubId: number): Promise<RepoBadgeRecord | null> {
    if (!Number.isSafeInteger(githubId)) return null
    const { data, error } = await getSupabaseAdminClient()
      .from('repo_badge_display')
      .select('github_id, handle, updated_at')
      .eq('github_id', githubId)
      .maybeSingle()
    if (error) throwDatabaseError('repo_badge_display.get', error)
    const row = data as Row | null
    return row ? { handle: row.handle, updatedAt: row.updated_at } : null
  }

  async put(githubId: number, handle: string, updatedAt: string): Promise<void> {
    const { error } = await getSupabaseAdminClient()
      .from('repo_badge_display')
      .upsert(
        { github_id: githubId, handle: handle.toLowerCase(), updated_at: updatedAt },
        { onConflict: 'github_id' },
      )
    if (error) throwDatabaseError('repo_badge_display.put', error)
  }

  async remove(githubId: number): Promise<void> {
    const { error } = await getSupabaseAdminClient()
      .from('repo_badge_display')
      .delete()
      .eq('github_id', githubId)
    if (error) throwDatabaseError('repo_badge_display.remove', error)
  }
}

let singleton: SupabaseRepoBadgeStore | null = null

export function getSupabaseRepoBadgeStore(): SupabaseRepoBadgeStore {
  if (!singleton) singleton = new SupabaseRepoBadgeStore()
  return singleton
}
