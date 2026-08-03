/**
 * Contract tests for `/api/sync`. Mirrors the pattern in
 * `src/app/api/creature/route.test.ts`: every test imports the route module
 * (and its collaborators) fresh via `vi.resetModules()` + dynamic `import()`
 * so module-level env reads and the sqlite singleton never leak state
 * between tests. `SYNC_DB_PATH` is left unset so `sqlite-store.ts` falls
 * back to an in-memory database under Vitest (`process.env.VITEST`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

function fakeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/sync', {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  })
}

function validSnapshotBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    totalXp: 1234,
    stage: 'mossling',
    stageIndex: 2,
    noteCount: 10,
    projectCount: 2,
    totalWords: 3000,
    tagCount: 4,
    companions: [{ stage: 'sporeling', stageIndex: 1 }],
    unlockedItemIds: ['spore-jar'],
    generatedAt: '2024-06-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('POST/GET/DELETE /api/sync', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('STUB_SESSION_HANDLE', '')
    vi.stubEnv('SYNC_DB_PATH', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('1. POST is 401 when signed out', async () => {
    const { POST } = await import('./route')
    const res = await POST(fakeRequest('POST', validSnapshotBody()))
    expect(res.status).toBe(401)
  })

  it('2. with the stub session set, a valid snapshot round-trips through POST then GET', async () => {
    process.env.STUB_SESSION_HANDLE = 'octocat'
    const { POST, GET } = await import('./route')

    const postRes = await POST(fakeRequest('POST', validSnapshotBody()))
    expect(postRes.status).toBe(200)
    const posted = await postRes.json()
    expect(posted.handle).toBe('octocat')
    expect(posted.snapshot.totalXp).toBe(1234)

    const getRes = await GET()
    expect(getRes.status).toBe(200)
    const fetched = await getRes.json()
    expect(fetched.snapshot).toEqual(posted.snapshot)
  })

  it('3. a body with an extra unknown field is a 400, not a silent drop', async () => {
    process.env.STUB_SESSION_HANDLE = 'octocat'
    const { POST, GET } = await import('./route')

    const res = await POST(
      fakeRequest('POST', validSnapshotBody({ noteTitles: ['My private note'] }))
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/noteTitles/)

    // And nothing was stored as a side effect of the rejected request.
    const getRes = await GET()
    expect(getRes.status).toBe(404)
  })

  it('4. a body claiming to be a different handle does not overwrite that user', async () => {
    const { POST, GET } = await import('./route')

    // Victim syncs first, signed in as "victim".
    process.env.STUB_SESSION_HANDLE = 'victim'
    const victimPost = await POST(fakeRequest('POST', validSnapshotBody({ totalXp: 1 })))
    expect(victimPost.status).toBe(200)

    // Attacker is signed in as "attacker" but tries to smuggle a "handle"
    // field naming the victim. SyncedSnapshot has no handle field at all,
    // so this is rejected by the closed-shape validator (still a 400, same
    // mechanism as the unknown-field test above) rather than silently
    // accepted and attributed to the attacker's own session.
    process.env.STUB_SESSION_HANDLE = 'attacker'
    const attackerPost = await POST(
      fakeRequest('POST', validSnapshotBody({ totalXp: 999999, handle: 'victim' }))
    )
    expect(attackerPost.status).toBe(400)

    // The victim's row is untouched.
    process.env.STUB_SESSION_HANDLE = 'victim'
    const getRes = await GET()
    const fetched = await getRes.json()
    expect(fetched.snapshot.totalXp).toBe(1)

    // And even a well-formed attacker upload only ever writes the
    // attacker's own row: the handle used to store it comes from the
    // session, never the body.
    process.env.STUB_SESSION_HANDLE = 'attacker'
    const wellFormedAttackerPost = await POST(
      fakeRequest('POST', validSnapshotBody({ totalXp: 42 }))
    )
    expect(wellFormedAttackerPost.status).toBe(200)
    const attackerGet = await GET()
    const attackerFetched = await attackerGet.json()
    expect(attackerFetched.handle).toBe('attacker')
    expect(attackerFetched.snapshot.totalXp).toBe(42)

    process.env.STUB_SESSION_HANDLE = 'victim'
    const victimGetAgain = await GET()
    const victimFetchedAgain = await victimGetAgain.json()
    expect(victimFetchedAgain.snapshot.totalXp).toBe(1)
  })

  it('5. DELETE removes the row, and GET then 404s', async () => {
    process.env.STUB_SESSION_HANDLE = 'octocat'
    const { POST, GET, DELETE } = await import('./route')

    await POST(fakeRequest('POST', validSnapshotBody()))
    expect((await GET()).status).toBe(200)

    const delRes = await DELETE()
    expect(delRes.status).toBe(204)

    expect((await GET()).status).toBe(404)
  })

  it('rejects a schemaVersion newer than SNAPSHOT_SCHEMA_VERSION', async () => {
    process.env.STUB_SESSION_HANDLE = 'octocat'
    const { POST } = await import('./route')
    const res = await POST(fakeRequest('POST', validSnapshotBody({ schemaVersion: 999 })))
    expect(res.status).toBe(400)
  })

  it('GET is 401 when signed out', async () => {
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('DELETE is 401 when signed out', async () => {
    const { DELETE } = await import('./route')
    const res = await DELETE()
    expect(res.status).toBe(401)
  })

  it('GET 404s for a signed-in user who has never synced', async () => {
    process.env.STUB_SESSION_HANDLE = 'never-synced-user'
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(404)
  })
})
