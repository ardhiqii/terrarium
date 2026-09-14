/** Supabase implementation of the public derived-state sync contract. */

import type { SyncedUser, SyncStore } from './types'
import { getSupabaseAdminClient } from './supabase-client'

interface SyncedUserRow {
  handle: string
  github_id: number
  avatar_url: string | null
  snapshot_json: unknown
  updated_at: string
}
function normalizeHandle(handle: string): string {
  return handle.toLowerCase()
}

function rowToUser(row: SyncedUserRow): SyncedUser {
  return {
    handle: row.handle,
    githubId: Number(row.github_id),
    avatarUrl: row.avatar_url,
    snapshot: typeof row.snapshot_json === 'string'
      ? JSON.parse(row.snapshot_json)
      : row.snapshot_json as SyncedUser['snapshot'],
    updatedAt: row.updated_at,
  }
}

function throwDatabaseError(operation: string, error: { message: string }): never {
  throw new Error(`Supabase ${operation} failed: ${error.message}`)
}

export class SupabaseSyncStore implements SyncStore {
  async put(user: SyncedUser): Promise<void> {
    const { error } = await getSupabaseAdminClient()
      .from('synced_users')
      .upsert(
        {
          handle: normalizeHandle(user.handle),
          github_id: user.githubId,
          avatar_url: user.avatarUrl,
          snapshot_json: user.snapshot,
          updated_at: user.updatedAt,
        },
        { onConflict: 'handle' },
      )
    if (error) throwDatabaseError('synced_users.put', error)
  }

  async get(handle: string): Promise<SyncedUser | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from('synced_users')
      .select('handle, github_id, avatar_url, snapshot_json, updated_at')
      .eq('handle', normalizeHandle(handle))
      .maybeSingle()
    if (error) throwDatabaseError('synced_users.get', error)
    return data ? rowToUser(data as SyncedUserRow) : null
  }

  async getMany(handles: string[]): Promise<SyncedUser[]> {
    const normalized = [...new Set(handles.map(normalizeHandle))]
    if (normalized.length === 0) return []
    const { data, error } = await getSupabaseAdminClient()
      .from('synced_users')
      .select('handle, github_id, avatar_url, snapshot_json, updated_at')
      .in('handle', normalized)
    if (error) throwDatabaseError('synced_users.getMany', error)
    return (data as SyncedUserRow[]).map(rowToUser)
  }

  async remove(handle: string): Promise<void> {
    const { error } = await getSupabaseAdminClient()
      .from('synced_users')
      .delete()
      .eq('handle', normalizeHandle(handle))
    if (error) throwDatabaseError('synced_users.remove', error)
  }
}

let singleton: SupabaseSyncStore | null = null

export function getSupabaseSyncStore(): SupabaseSyncStore {
  if (!singleton) singleton = new SupabaseSyncStore()
  return singleton
}

export function resetSupabaseSyncStoreForTests(): void {
  singleton = null
}
