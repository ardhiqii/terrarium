import { describe, expect, it } from 'vitest'
import { ProfileVisibilitySqliteStore } from './profile-visibility-store'

describe('ProfileVisibilitySqliteStore', () => {
  it('is private by default: a missing row returns null, not a public record', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    expect(await store.get(12345)).toBeNull()
  })

  it('round-trips an explicit public choice', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    await store.put(12345, 'OctoCat', 'public', '2026-09-26T00:00:00.000Z')

    const record = await store.get(12345)
    expect(record?.visibility).toBe('public')
    expect(record?.handle).toBe('octocat') // lowercased
    expect(record?.updatedAt).toBe('2026-09-26T00:00:00.000Z')
  })

  it('coerces any non-public value to private (cannot opt in by typo)', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    await store.put(1, 'a', 'PUBLIC', 't') // wrong case
    await store.put(2, 'b', 'yes', 't')
    await store.put(3, 'c', '', 't')

    expect((await store.get(1))?.visibility).toBe('private')
    expect((await store.get(2))?.visibility).toBe('private')
    expect((await store.get(3))?.visibility).toBe('private')
  })

  it('upserts: a later write replaces the earlier choice', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    await store.put(7, 'seven', 'public', 't1')
    await store.put(7, 'seven', 'private', 't2')

    const record = await store.get(7)
    expect(record?.visibility).toBe('private')
    expect(record?.updatedAt).toBe('t2')
  })

  it('gets many records at once and skips ids with no row', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    await store.put(1, 'one', 'public', 't')
    await store.put(2, 'two', 'private', 't')

    const records = await store.getMany([1, 2, 999])
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.visibility).sort()).toEqual(['private', 'public'])
  })

  it('remove reverts the account to the private default', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    await store.put(9, 'nine', 'public', 't')
    await store.remove(9)
    expect(await store.get(9)).toBeNull()
  })

  it('getPublicIds returns only opted-in ids, never private or missing ones', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    await store.put(1, 'one', 'public', 't')
    await store.put(2, 'two', 'private', 't')
    // id 3 has no row at all (the default)

    const publicIds = await store.getPublicIds([1, 2, 3, 999])
    expect([...publicIds]).toEqual([1])
    expect(publicIds.has(2)).toBe(false)
    expect(publicIds.has(3)).toBe(false)
  })

  it('getPublicIds returns an empty set for empty input', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    expect((await store.getPublicIds([])).size).toBe(0)
  })

  it('is keyed by immutable id, not handle, so a reused login cannot inherit a choice', async () => {
    const store = new ProfileVisibilitySqliteStore(':memory:')
    // Account A (id 100) opts in under the login "ghost".
    await store.put(100, 'ghost', 'public', 't')
    // The login is later reused by a different account (id 200) with no choice.
    expect(await store.get(200)).toBeNull()
    // And account A's row is still keyed by its own id.
    expect((await store.get(100))?.visibility).toBe('public')
  })
})
