import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetRepoBadgeStoreForTests, RepoBadgeSqliteStore } from '@/lib/sync/repo-badge-store'
import { cacheClearAll } from '@/lib/game/api-cache'

/**
 * The dressed-repo badge opt-in (docs-plan/PLAN-dressed-repo-creature.md §3.2).
 * Default off; the caller can only ever change their own row.
 */

let session: { handle: string; githubId: number; avatarUrl: null } | null = null

vi.mock('@/lib/sync/session', () => ({
  getSessionProvider: () => ({ current: async () => session }),
}))

function put(body: unknown) {
  return new NextRequest('http://localhost/api/profile/repo-badges', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let store: RepoBadgeSqliteStore

beforeEach(() => {
  cacheClearAll()
  store = resetRepoBadgeStoreForTests(':memory:')
  session = { handle: 'Octo', githubId: 9001, avatarUrl: null }
})

describe('/api/profile/repo-badges', () => {
  it('requires a session for both reading and writing', async () => {
    session = null
    const { GET, PUT } = await import('./route')
    expect((await GET()).status).toBe(401)
    expect((await PUT(put({ enabled: true }))).status).toBe(401)
  })

  it('is off by default', async () => {
    const { GET } = await import('./route')
    expect(await (await GET()).json()).toMatchObject({ enabled: false, updatedAt: null })
  })

  it('turns on and off for the caller, keyed by the session id', async () => {
    const { GET, PUT } = await import('./route')
    expect((await PUT(put({ enabled: true }))).status).toBe(200)
    expect(await store.get(9001)).toMatchObject({ handle: 'octo' })
    expect((await (await GET()).json()).enabled).toBe(true)

    expect((await PUT(put({ enabled: false }))).status).toBe(200)
    expect(await store.get(9001)).toBeNull()
  })

  it('ignores any account named in the body', async () => {
    const { PUT } = await import('./route')
    await PUT(put({ enabled: true, githubId: 1, handle: 'someone-else' }))
    expect(await store.get(1)).toBeNull()
    expect(await store.get(9001)).not.toBeNull()
  })

  it('rejects anything but a literal boolean', async () => {
    const { PUT } = await import('./route')
    for (const body of [{ enabled: 'true' }, { enabled: 1 }, {}, [], 'not json', null]) {
      expect((await PUT(put(body))).status).toBe(400)
    }
    expect(await store.get(9001)).toBeNull()
  })
})

describe('repo_badge_display migration', () => {
  it('defines every column the stores read and write, with RLS on', () => {
    const dir = path.join(process.cwd(), 'supabase/migrations')
    const sql = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(path.join(dir, name), 'utf8'))
      .join('\n')
    expect(sql).toMatch(/create table if not exists public\.repo_badge_display/)
    for (const column of ['github_id bigint primary key', 'handle text', 'updated_at timestamptz']) {
      expect(sql).toContain(column)
    }
    expect(sql).toContain('alter table public.repo_badge_display enable row level security')
  })
})
