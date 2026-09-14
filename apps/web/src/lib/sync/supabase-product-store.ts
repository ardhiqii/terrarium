/** Supabase implementation of the derived product snapshot store. */

import {
  deserializeProductSnapshot,
  serializeProductSnapshot,
  type ProductSnapshot,
} from './product-snapshot'
import type { ProductSnapshotRecord, ProductStore } from './product-store'
import { getSupabaseAdminClient } from './supabase-client'

interface ProductSnapshotRow {
  github_id: number | null
  handle: string
  snapshot_json: unknown
  updated_at: string
}

function normalizeHandle(handle: string): string {
  return handle.toLowerCase()
}

function throwDatabaseError(operation: string, error: { message: string }): never {
  throw new Error(`Supabase ${operation} failed: ${error.message}`)
}

export class SupabaseProductStore implements ProductStore {
  async put(
    githubId: number,
    handle: string,
    snapshot: ProductSnapshot,
    updatedAt: string,
    expectedUpdatedAt: string | null,
  ): Promise<boolean> {
    const client = getSupabaseAdminClient()
    const row = {
      github_id: githubId,
      handle: normalizeHandle(handle),
      snapshot_json: JSON.parse(serializeProductSnapshot(snapshot)),
      updated_at: updatedAt,
    }
    if (expectedUpdatedAt === null) {
      const { error } = await client.from('product_snapshots').insert(row)
      if (!error) return true
      if (error.code === '23505') return false
      throwDatabaseError('product_snapshots.put', error)
    }
    if (updatedAt === expectedUpdatedAt) return false
    const { data, error } = await client
      .from('product_snapshots')
      .update(row)
      .eq('github_id', githubId)
      .eq('updated_at', expectedUpdatedAt)
      .select('github_id')
      .maybeSingle()
    if (error) throwDatabaseError('product_snapshots.put', error)
    return Boolean(data)
  }

  async getRecord(githubId: number, handle?: string): Promise<ProductSnapshotRecord | null> {
    const client = getSupabaseAdminClient()
    const byId = await client
      .from('product_snapshots')
      .select('github_id, handle, snapshot_json, updated_at')
      .eq('github_id', githubId)
      .maybeSingle()
    if (byId.error) throwDatabaseError('product_snapshots.get', byId.error)
    let data = byId.data as ProductSnapshotRow | null
    if (!data && handle) {
      const legacy = await client
        .from('product_snapshots')
        .select('github_id, handle, snapshot_json, updated_at')
        .eq('handle', normalizeHandle(handle))
        .is('github_id', null)
        .maybeSingle()
      if (legacy.error) throwDatabaseError('product_snapshots.get', legacy.error)
      data = legacy.data as ProductSnapshotRow | null
      if (data && data.github_id === null) {
        const migrated = await client
          .from('product_snapshots')
          .update({ github_id: githubId })
          .eq('handle', normalizeHandle(handle))
          .is('github_id', null)
          .select('github_id, handle, snapshot_json, updated_at')
          .maybeSingle()
        if (migrated.error) throwDatabaseError('product_snapshots.migrate', migrated.error)
        if (migrated.data) {
          // The conditional update returned a row only when this caller won
          // the legacy-row claim. If another account won the race, re-read by
          // immutable ID instead of returning data that belongs to it.
          data = migrated.data as ProductSnapshotRow
        } else {
          const claimed = await client
            .from('product_snapshots')
            .select('github_id, handle, snapshot_json, updated_at')
            .eq('github_id', githubId)
            .maybeSingle()
          if (claimed.error) throwDatabaseError('product_snapshots.get', claimed.error)
          data = claimed.data as ProductSnapshotRow | null
        }
      }
    }
    if (!data) return null
    const snapshot = deserializeProductSnapshot(
      typeof data.snapshot_json === 'string'
        ? data.snapshot_json
        : JSON.stringify(data.snapshot_json),
    )
    return snapshot
      ? {
          githubId: Number(data.github_id ?? githubId),
          handle: data.handle,
          snapshot,
          updatedAt: data.updated_at,
        }
      : null
  }

  async get(githubId: number, handle?: string): Promise<ProductSnapshot | null> {
    return (await this.getRecord(githubId, handle))?.snapshot ?? null
  }

  async remove(githubId: number, handle?: string): Promise<void> {
    const client = getSupabaseAdminClient()
    const { error } = await client
      .from('product_snapshots')
      .delete()
      .eq('github_id', githubId)
    if (error) throwDatabaseError('product_snapshots.remove', error)
    if (handle) {
      const legacy = await client
        .from('product_snapshots')
        .delete()
        .eq('handle', normalizeHandle(handle))
        .is('github_id', null)
      if (legacy.error) throwDatabaseError('product_snapshots.remove', legacy.error)
    }
  }
}

let singleton: SupabaseProductStore | null = null

export function getSupabaseProductStore(): SupabaseProductStore {
  if (!singleton) singleton = new SupabaseProductStore()
  return singleton
}

export function resetSupabaseProductStoreForTests(): void {
  singleton = null
}
