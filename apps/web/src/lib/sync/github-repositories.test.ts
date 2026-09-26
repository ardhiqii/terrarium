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
    expect(result).toEqual({ status: 'unauthorized', repositories: [], truncated: false })
  })

  it('discards the pages already read when a later page fails instead of returning a partial listing', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `repo-${index}`,
      full_name: `octo/repo-${index}`,
      owner: { login: 'octo', type: 'User' },
    }))
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      return page === 1
        ? response(fullPage)
        : response({ message: 'Server Error' }, 500)
    })

    const result = await fetchGithubRepositories({ token: 'secret', fetch: fetchMock })

    expect(result.status).toBe('unavailable')
    expect(result.repositories).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('flags a listing that fills the last page as truncated', async () => {
    // The paged walk stops at five pages. A full fifth page means GitHub may
    // still hold a sixth, so the listing must not be treated as complete: the
    // sync prune would delete the baseline of every repository past page 5.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      const body = Array.from({ length: 100 }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        name: `repo-${page}-${index}`,
        full_name: `octo/repo-${page}-${index}`,
        owner: { login: 'octo', type: 'User' },
      }))
      return response(body)
    })

    const result = await fetchGithubRepositories({ token: 'secret', fetch: fetchMock })

    expect(result.status).toBe('ok')
    expect(result.truncated).toBe(true)
    expect(result.repositories).toHaveLength(500)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('keeps walking while the response advertises a next page instead of trusting a short page', async () => {
    // `sort=updated` pagination is unstable: a page can come back short while
    // GitHub still holds later pages. Ending the walk there would report the
    // listing as COMPLETE, and the sync prune would delete the baseline of a
    // repository the walk never reached. GitHub's own `Link: rel="next"` is
    // the completeness signal, not the page length.
    const nextLink = (page: number) =>
      `<https://api.github.com/user/repos?per_page=100&page=${page}>; rel="next"`
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      const length = page === 1 ? 100 : page === 2 ? 100 : page === 3 ? 40 : 5
      const body = Array.from({ length }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        name: `repo-${page}-${index}`,
        full_name: `octo/repo-${page}-${index}`,
        owner: { login: 'octo', type: 'User' },
      }))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: page < 4 ? { Link: nextLink(page + 1) } : {},
      })
    })

    const result = await fetchGithubRepositories({ token: 'secret', fetch: fetchMock })

    expect(result.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result.repositories).toHaveLength(245)
    expect(result.truncated).toBe(false)
  })

  it('flags a short page at the ceiling truncated when GitHub still advertises a next page', async () => {
    const nextLink = (page: number) =>
      `<https://api.github.com/user/repos?per_page=100&page=${page}>; rel="next"`
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      const length = page === 5 ? 40 : 100
      const body = Array.from({ length }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        name: `repo-${page}-${index}`,
        full_name: `octo/repo-${page}-${index}`,
        owner: { login: 'octo', type: 'User' },
      }))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { Link: nextLink(page + 1) },
      })
    })

    const result = await fetchGithubRepositories({ token: 'secret', fetch: fetchMock })

    expect(result.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(result.repositories).toHaveLength(440)
    expect(result.truncated).toBe(true)
  })

  it('reports a listing that ends before the page ceiling as complete', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      const length = page === 1 ? 100 : 7
      const body = Array.from({ length }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        name: `repo-${page}-${index}`,
        full_name: `octo/repo-${page}-${index}`,
        owner: { login: 'octo', type: 'User' },
      }))
      return response(body)
    })

    const result = await fetchGithubRepositories({ token: 'secret', fetch: fetchMock })

    expect(result.status).toBe('ok')
    expect(result.truncated).toBe(false)
    expect(result.repositories).toHaveLength(107)
  })
})
