import { describe, expect, it, vi } from 'vitest'
import { fetchGithubRepositories } from './github-repositories'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('fetchGithubRepositories', () => {
  it('maps stable IDs, visibility, owner type, and read permission', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response([
      {
        id: 101,
        name: 'garden',
        full_name: 'octo/garden',
        private: true,
        visibility: 'private',
        default_branch: 'main',
        archived: false,
        owner: { login: 'octo', type: 'User' },
        permissions: { pull: true, push: false },
      },
      {
        id: 202,
        name: 'team-tools',
        full_name: 'Acme/team-tools',
        private: false,
        visibility: 'public',
        default_branch: 'trunk',
        archived: true,
        owner: { login: 'Acme', type: 'Organization' },
        permissions: { pull: false, push: false, admin: false },
      },
    ]))

    const result = await fetchGithubRepositories({ token: 'secret', fetch: fetchMock })

    expect(result.status).toBe('ok')
    expect(result.repositories).toEqual([
      expect.objectContaining({
        id: '101',
        fullName: 'octo/garden',
        ownerType: 'User',
        private: true,
        canRead: true,
      }),
      expect.objectContaining({
        id: '202',
        ownerType: 'Organization',
        archived: true,
        canRead: false,
      }),
    ])
    expect(fetchMock.mock.calls[0][0]).toContain('/user/repos?')
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer secret' })
  })

  it('does not return repositories after a revoked token response', async () => {
    const result = await fetchGithubRepositories({
      token: 'revoked',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ message: 'Bad credentials' }, 401)),
    })
    expect(result).toEqual({ status: 'unauthorized', repositories: [] })
  })
})
