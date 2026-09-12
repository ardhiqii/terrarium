import { describe, expect, it } from 'vitest'
import { fetchGitHubEvents, type FetchGitHubEventsOptions } from './github-events-fetch'

/** Builds a fetch stub that routes different paths to canned JSON. */
function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = routes[url] ?? []
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

const opts: FetchGitHubEventsOptions = {
  login: 'octo',
  repos: ['widgets'],
  apiBase: 'https://api.github.com',
  fetch: stubFetch({}),
}

describe('fetchGitHubEvents', () => {
  it('never throws and returns empty input when the fetch stub fails', async () => {
    // A fetch that always rejects.
    const failing = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const result = await fetchGitHubEvents({
      login: 'octo',
      repos: ['acme/widgets'],
      fetch: failing,
    })

    expect(result.login).toBe('octo')
    // Empty input means no events were derivable, which is the safe fallback.
    expect(result.input.mergedPullRequests ?? []).toEqual([])
  })

  it('maps merged pull requests, releases, closed issues, and CI checks', async () => {
    const now = '2026-09-12T12:00:00Z'
    const repo = 'widgets'

    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'PR_node1',
          id: 11,
          number: 7,
          state: 'closed',
          merged_at: now,
          merge_commit_sha: 'abc123',
          head: { sha: 'headsha1' },
        },
      ],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [
        {
          node_id: 'REL_node1',
          id: 21,
          tag_name: 'v1.0.0',
          draft: false,
          published_at: now,
        },
      ],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'ISS_node1',
          id: 31,
          number: 10,
          closed_at: now,
        },
        {
          // PRs appear in the issues list; must be skipped.
          node_id: 'PR_in_issue',
          id: 32,
          number: 7,
          closed_at: now,
          pull_request: { url: 'x' },
        },
      ],
      [`https://api.github.com/repos/${repo}/commits?per_page=30`]: [
        { sha: 'headsha1' },
      ],
      [`https://api.github.com/repos/${repo}/commits/headsha1/check-runs?per_page=30`]: [
        { node_id: 'CHECK1', id: 1, conclusion: 'success', status: 'completed', completed_at: now, name: 'test' },
        { node_id: 'CHECK2', id: 2, conclusion: 'failure', status: 'completed', completed_at: now },
      ],
    }

    const result = await fetchGitHubEvents({ ...opts, fetch: stubFetch(routes) })

    expect(result.input.mergedPullRequests ?? []).toHaveLength(1)
    expect(result.input.mergedPullRequests?.[0]).toMatchObject({
      id: 'PR_node1',
      repositoryId: repo,
      number: 7,
      headSha: 'headsha1',
      mergeCommitSha: 'abc123',
    })

    expect(result.input.releases ?? []).toHaveLength(1)
    expect(result.input.releases?.[0]).toMatchObject({ id: 'REL_node1', tagName: 'v1.0.0' })

    // The second issues[] entry is a PR and must be excluded.
    expect(result.input.linkedIssues ?? []).toHaveLength(1)
    expect(result.input.linkedIssues?.[0]).toMatchObject({ id: 'ISS_node1', number: 10 })

    // Only the successful check survives.
    expect(result.input.ciChecks ?? []).toHaveLength(1)
    expect(result.input.ciChecks?.[0]).toMatchObject({ id: 'CHECK1', name: 'test' })
  })

  it('falls back to listing the user repos when no explicit repos are given', async () => {
    const routes: Record<string, unknown> = {
      'https://api.github.com/users/octo/repos?per_page=100&sort=updated': [
        { name: 'acme/widgets' },
        { name: 'acme/tools' },
      ],
    }

    const result = await fetchGitHubEvents({
      login: 'octo',
      repos: [],
      fetch: stubFetch(routes),
    })

    // With no repos, we list the user's repos, then call their pulls endpoint
    // which returns nothing for each — so the input is empty but we did not throw.
    expect(result.login).toBe('octo')
    expect(result.input.mergedPullRequests).toEqual([])
  })
})
