/** Supabase implementation of the derived product snapshot store. */

import {
  deserializeProductSnapshot,
  serializeProductSnapshot,
  type ProductSnapshot,
} from './product-snapshot'
import type { ProductStore } from './product-store'
import { getSupabaseAdminClient } from './supabase-client'

interface ProductSnapshotRow {
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
  async put(handle: string, snapshot: ProductSnapshot, updatedAt: string): Promise<void> {
    const { error } = await getSupabaseAdminClient()
      .from('product_snapshots')
      .upsert(
        {
          handle: normalizeHandle(handle),
          snapshot_json: JSON.parse(serializeProductSnapshot(snapshot)),
          updated_at: updatedAt,
        },
        { onConflict: 'handle' },
      )
    if (error) throwDatabaseError('product_snapshots.put', error)
  }

  async get(handle: string): Promise<ProductSnapshot | null> {
    const { data, error } = await getSupabaseAdminClient()
      .from('product_snapshots')
      .select('handle, snapshot_json, updated_at')
      .eq('handle', normalizeHandle(handle))
      .maybeSingle()
    if (error) throwDatabaseError('product_snapshots.get', error)
    if (!data) return null
    const row = data as ProductSnapshotRow
    return deserializeProductSnapshot(
      typeof row.snapshot_json === 'string'
        ? row.snapshot_json
        : JSON.stringify(row.snapshot_json),
    )
  }

  async remove(handle: string): Promise<void> {
    const { error } = await getSupabaseAdminClient()
      .from('product_snapshots')
      .delete()
      .eq('handle', normalizeHandle(handle))
    if (error) throwDatabaseError('product_snapshots.remove', error)
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
