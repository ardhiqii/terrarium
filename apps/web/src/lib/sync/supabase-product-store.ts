/** Supabase implementation of the derived product snapshot store. */

import { randomUUID } from 'node:crypto'
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
  row_version: string | null
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
      row_version: randomUUID(),
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

  async getRecord(githubId: number, _handle?: string): Promise<ProductSnapshotRecord | null> {
    const client = getSupabaseAdminClient()
    const byId = await client
      .from('product_snapshots')
      .select('github_id, handle, snapshot_json, updated_at, row_version')
      .eq('github_id', githubId)
      .maybeSingle()
    if (byId.error) throwDatabaseError('product_snapshots.get', byId.error)
    const data = byId.data as ProductSnapshotRow | null
    // A row with only a mutable handle cannot be safely attributed to this
    // immutable GitHub identity. Do not adopt legacy rows on a name match.
    if (!data || !data.row_version) return null
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
          version: data.row_version,
        }
      : null
  }

  async get(githubId: number, handle?: string): Promise<ProductSnapshot | null> {
    return (await this.getRecord(githubId, handle))?.snapshot ?? null
  }

  async remove(githubId: number, _handle?: string): Promise<void> {
    const client = getSupabaseAdminClient()
    const { error } = await client
      .from('product_snapshots')
      .delete()
      .eq('github_id', githubId)
    if (error) throwDatabaseError('product_snapshots.remove', error)
  }

  async removeIfVersion(githubId: number, expectedVersion: string): Promise<boolean> {
    const client = getSupabaseAdminClient()
    const { data, error } = await client
      .from('product_snapshots')
      .delete()
      .eq('github_id', githubId)
      .eq('row_version', expectedVersion)
      .select('github_id')
      .maybeSingle()
    if (error) throwDatabaseError('product_snapshots.removeIfVersion', error)
    return Boolean(data)
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
