/** Supabase implementation of the public-profile visibility store. */

import { parseVisibility, type ProfileVisibilityRecord } from './profile-visibility'
import type { ProfileVisibilityStore } from './profile-visibility-store'
import { getSupabaseAdminClient } from './supabase-client'

interface VisibilityRow {
  github_id: number
  handle: string
  visibility: string
  updated_at: string
}

function throwDatabaseError(operation: string, error: { message: string }): never {
  throw new Error(`Supabase ${operation} failed: ${error.message}`)
}

function toRecord(row: VisibilityRow): ProfileVisibilityRecord {
  return {
    handle: row.handle,
    visibility: parseVisibility(row.visibility),
    updatedAt: row.updated_at,
  }
}

export class SupabaseProfileVisibilityStore implements ProfileVisibilityStore {
  async get(githubId: number): Promise<ProfileVisibilityRecord | null> {
    const client = getSupabaseAdminClient()
    const { data, error } = await client
      .from('profile_visibility')
      .select('github_id, handle, visibility, updated_at')
      .eq('github_id', githubId)
      .maybeSingle()
    if (error) throwDatabaseError('profile_visibility.get', error)
    return data ? toRecord(data as VisibilityRow) : null
  }

  async getMany(githubIds: readonly number[]): Promise<ProfileVisibilityRecord[]> {
    const unique = [...new Set(githubIds.filter((id) => Number.isFinite(id)))]
    if (unique.length === 0) return []
    const client = getSupabaseAdminClient()
    const { data, error } = await client
      .from('profile_visibility')
      .select('github_id, handle, visibility, updated_at')
      .in('github_id', unique)
    if (error) throwDatabaseError('profile_visibility.getMany', error)
    return ((data ?? []) as VisibilityRow[]).map(toRecord)
  }

  async getPublicIds(githubIds: readonly number[]): Promise<Set<number>> {
    const unique = [...new Set(githubIds.filter((id) => Number.isFinite(id)))]
    if (unique.length === 0) return new Set()
    const client = getSupabaseAdminClient()
    const { data, error } = await client
      .from('profile_visibility')
      .select('github_id')
      .eq('visibility', 'public')
      .in('github_id', unique)
    if (error) throwDatabaseError('profile_visibility.getPublicIds', error)
    return new Set(((data ?? []) as Array<{ github_id: number }>).map((row) => Number(row.github_id)))
  }

  async put(
    githubId: number,
    handle: string,
    visibility: string,
    updatedAt: string,
  ): Promise<void> {
    const client = getSupabaseAdminClient()
    const { error } = await client.from('profile_visibility').upsert(
      {
        github_id: githubId,
        handle: handle.toLowerCase(),
        visibility: parseVisibility(visibility),
        updated_at: updatedAt,
      },
      { onConflict: 'github_id' },
    )
    if (error) throwDatabaseError('profile_visibility.put', error)
  }

  async remove(githubId: number): Promise<void> {
    const client = getSupabaseAdminClient()
    const { error } = await client.from('profile_visibility').delete().eq('github_id', githubId)
    if (error) throwDatabaseError('profile_visibility.remove', error)
  }
}

let singleton: SupabaseProfileVisibilityStore | null = null

export function getSupabaseProfileVisibilityStore(): SupabaseProfileVisibilityStore {
  if (!singleton) singleton = new SupabaseProfileVisibilityStore()
  return singleton
}

export function resetSupabaseProfileVisibilityStoreForTests(): void {
  singleton = null
}
