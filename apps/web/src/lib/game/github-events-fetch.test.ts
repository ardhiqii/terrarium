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
          user: { login: 'octo' },
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
          author: { login: 'octo' },
          draft: false,
          published_at: now,
        },
      ],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'ISS_node1',
          id: 31,
          number: 10,
          user: { login: 'octo' },
          closed_at: now,
        },
        {
          // PRs appear in the issues list; must be skipped.
          node_id: 'PR_in_issue',
          id: 32,
          number: 7,
          user: { login: 'octo' },
          closed_at: now,
          pull_request: { url: 'x' },
        },
      ],
      [`https://api.github.com/repos/${repo}/issues/10/timeline?per_page=30`]: [
        {
          event: 'cross-referenced',
          source: {
            issue: {
              node_id: 'PR_node1',
              number: 7,
              pull_request: { url: 'https://api.github.com/repos/widgets/pulls/7' },
            },
          },
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

    // The second issues[] entry is a PR and must be excluded. The remaining
    // issue is included only after its timeline proves a merged-PR link.
    expect(result.input.linkedIssues ?? []).toHaveLength(1)
    expect(result.input.linkedIssues?.[0]).toMatchObject({
      id: 'ISS_node1',
      number: 10,
      linkedPullRequestId: 'PR_node1',
    })

    // Only the successful check survives.
    expect(result.input.ciChecks ?? []).toHaveLength(1)
    expect(result.input.ciChecks?.[0]).toMatchObject({ id: 'CHECK1', name: 'test' })
  })

  it('keeps its cursor on a timeline page that failed instead of claiming a complete read', async () => {
    // REGRESSION: a failed timeline page used to report `truncated: false`,
    // which is indistinguishable from a finished scan -- the retry could only
    // start over, and nothing recorded that the page was ever missed. A failed
    // page is truncation: the cursor stays on it so a retry resumes there.
    const repo = 'widgets'
    const now = '2026-09-12T12:00:00Z'
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'PR_node1',
          id: 11,
          number: 7,
          state: 'closed',
          user: { login: 'octo' },
          merged_at: now,
          merge_commit_sha: 'abc123',
          head: { sha: 'headsha1' },
        },
      ],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'ISS_node1',
          id: 31,
          number: 10,
          user: { login: 'octo' },
          closed_at: now,
        },
      ],
    }
    const fetchStub = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/timeline?')) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify(routes[url] ?? []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await fetchGitHubEvents({ ...opts, fetch: fetchStub })

    expect(result.status).toBe('partial')
    expect(result.truncated).toBe(true)
    expect(result.continuation).toMatchObject({ widgets: { issueTimelinePages: { '10': 1 } } })
  })

  it('marks a full bounded issue timeline as incomplete instead of skipping a late cross-reference', async () => {
    const now = '2026-09-12T12:00:00Z'
    const repo = 'widgets'
    const timelinePage = Array.from({ length: 30 }, () => ({
      event: 'cross-referenced',
      source: {
        issue: {
          node_id: 'PR_node1',
          number: 7,
          pull_request: { url: 'https://api.github.com/repos/widgets/pulls/7' },
        },
      },
    }))
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [{
        node_id: 'PR_node1',
        id: 11,
        number: 7,
        user: { login: 'octo' },
        merged_at: now,
      }],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [{
        node_id: 'ISS_node1',
        id: 31,
        number: 10,
        user: { login: 'octo' },
        closed_at: now,
      }],
      [`https://api.github.com/repos/${repo}/issues/10/timeline?per_page=30`]: timelinePage,
      [`https://api.github.com/repos/${repo}/issues/10/timeline?per_page=30&page=2`]: timelinePage,
      [`https://api.github.com/repos/${repo}/issues/10/timeline?per_page=30&page=3`]: timelinePage,
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=1`]: [],
    }

    const result = await fetchGitHubEvents({ ...opts, fetch: stubFetch(routes) })

    expect(result.truncated).toBe(true)
    expect(result.input.linkedIssues ?? []).toHaveLength(1)
  })

  it('does not treat missing actor metadata as proof of account attribution', async () => {
    const now = '2026-09-12T12:00:00Z'
    const repo = 'widgets'
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [
        { node_id: 'PR_unattributed', merged_at: now },
      ],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [
        { node_id: 'REL_unattributed', published_at: now, draft: false },
      ],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [
        { node_id: 'ISS_unattributed', closed_at: now },
      ],
    }

    const result = await fetchGitHubEvents({ ...opts, fetch: stubFetch(routes) })

    expect(result.input.mergedPullRequests).toEqual([])
    expect(result.input.releases).toEqual([])
    expect(result.input.linkedIssues).toEqual([])
  })

  it('accepts GitHub\'s wrapped check-runs response and keeps the scan healthy', async () => {
    const now = '2026-09-12T12:00:00Z'
    const repo = 'widgets'
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'PR_node1',
          id: 11,
          number: 7,
          state: 'closed',
          user: { login: 'octo' },
          merged_at: now,
          merge_commit_sha: 'merge1',
          head: { sha: 'headsha1' },
        },
      ],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits/headsha1/check-runs?per_page=30`]: {
        total_count: 1,
        check_runs: [{
          node_id: 'CHECK1',
          id: 1,
          conclusion: 'success',
          status: 'completed',
          completed_at: now,
          name: 'test',
        }],
      },
      [`https://api.github.com/repos/${repo}/commits/merge1/check-runs?per_page=30`]: [],
    }

    const result = await fetchGitHubEvents({ ...opts, fetch: stubFetch(routes) })

    expect(result.status).toBe('ok')
    expect(result.truncated).toBe(false)
    expect(result.input.ciChecks ?? []).toHaveLength(1)
    expect(result.input.ciChecks?.[0]).toMatchObject({ id: 'CHECK1', name: 'test' })
  })

  it('reports a truncated scan as ok and truncated, never as partial', async () => {
    // REGRESSION: a full page of check runs while GitHub reports a larger
    // total used to be counted as a FAILED request. `status` then became
    // `partial`, and the sync route only records a baseline when the status is
    // `ok` — so no baseline was ever written, `occurredAfterBaseline` stayed
    // false for every repository, and the account could never earn XP no
    // matter how many times the user pressed "Sync GitHub now".
    const now = '2026-09-12T12:00:00Z'
    const repo = 'widgets'
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'PR_node1',
          id: 11,
          number: 7,
          state: 'closed',
          user: { login: 'octo' },
          merged_at: now,
          merge_commit_sha: 'merge1',
          head: { sha: 'headsha1' },
        },
      ],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits/headsha1/check-runs?per_page=30`]: {
        total_count: 31,
        check_runs: Array.from({ length: 30 }, (_, index) => ({ id: index + 1 })),
      },
      [`https://api.github.com/repos/${repo}/commits/merge1/check-runs?per_page=30`]: [],
    }

    const result = await fetchGitHubEvents({ ...opts, fetch: stubFetch(routes) })

    // Every response was 200, so nothing failed and the baseline may be recorded.
    expect(result.status).toBe('ok')
    // The bounded scan still reports honestly that it may not have read everything.
    expect(result.truncated).toBe(true)
  })

  it('keeps status ok when a list fills its final page on a long history', async () => {
    // The ordinary state of any repository with a long history: three full
    // pages of merged PRs. Nothing failed, the scan is merely bounded, so the
    // sync must still be allowed to record a baseline.
    const now = '2026-09-12T12:00:00Z'
    const repo = 'widgets'
    const fullPage = Array.from({ length: 30 }, (_, index) => ({
      node_id: `PR_${index + 1}`,
      id: index + 1,
      state: 'closed',
      user: { login: 'octo' },
      merged_at: now,
    }))
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: fullPage,
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=2`]: fullPage,
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=3`]: fullPage,
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=1`]: [],
    }

    const result = await fetchGitHubEvents({ ...opts, fetch: stubFetch(routes) })

    expect(result.status).toBe('ok')
    expect(result.truncated).toBe(true)
    expect(result.continuation).toEqual({ widgets: { pullRequestsPage: 4 } })
    expect(result.input.mergedPullRequests ?? []).toHaveLength(90)
  })

  it('resumes each activity list from its own cursor instead of reusing one page number', async () => {
    const repo = 'widgets'
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=4`]: [{
        node_id: 'PR_page4',
        id: 44,
        number: 44,
        user: { login: 'octo' },
        merged_at: '2026-09-12T12:00:00Z',
        head: { sha: 'head-page4' },
      }],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [{
        node_id: 'release-page1',
        id: 55,
        author: { login: 'octo' },
        published_at: '2026-09-12T12:00:00Z',
        draft: false,
      }],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits/head-page4/check-runs?per_page=30`]: [],
    }
    const result = await fetchGitHubEvents({
      ...opts,
      continuation: { widgets: { pullRequestsPage: 4, releasesPage: 1, issuesPage: 1 } },
      fetch: stubFetch(routes),
    })

    expect(result.status).toBe('ok')
    expect(result.input.mergedPullRequests).toHaveLength(1)
    expect(result.input.releases).toHaveLength(1)
    expect(Object.keys(result.continuation ?? {})).toHaveLength(0)
  })

  it('treats GitHub\'s 409 for an empty repository as a successful empty read', async () => {
    // GitHub answers 409 "Git Repository is empty." for /commits on a repo with
    // no commits. Counting that as a failure withheld the baseline for every
    // brand-new repository, so a freshly tracked repo could never start.
    const repo = 'widgets'
    const empty409 = (async () => new Response('{"message":"Git Repository is empty."}', {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await fetchGitHubEvents({ ...opts, repos: [repo], fetch: empty409 })

    expect(result.status).toBe('ok')
    expect(result.truncated).toBe(false)
    expect(result.input.commits ?? []).toEqual([])
  })

  it('keeps a genuine failure as partial so the baseline is withheld, with the failure page as the retry cursor', async () => {
    // The counterpart to truncation: a real 500 must still withhold the
    // baseline, otherwise unread activity could be silently skipped forever.
    // It is also not a completed scan: the cursor stays on the failed pulls
    // page, so the retry resumes there instead of re-reading everything from
    // the start.
    const repo = 'widgets'
    const failing = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/pulls')) {
        return new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const result = await fetchGitHubEvents({ ...opts, repos: [repo], fetch: failing })

    expect(result.status).toBe('partial')
    expect(result.truncated).toBe(true)
    expect(result.continuation).toMatchObject({ widgets: { pullRequestsPage: 1 } })
  })

  it('reads CI checks from merged PR heads instead of walking default-branch commits', async () => {
    // The old walk cost up to 3 commit pages, then a check-run lookup for each
    // of up to 90 commits, per repository (~90-190 requests), and the
    // normalizer discarded every check that did not match a merged PR.
    const now = '2026-09-12T12:00:00Z'
    const repo = 'widgets'
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [
        {
          node_id: 'PR_node1',
          id: 11,
          number: 7,
          state: 'closed',
          user: { login: 'octo' },
          merged_at: now,
          merge_commit_sha: 'merge1',
          head: { sha: 'headsha1' },
        },
      ],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits/headsha1/check-runs?per_page=30`]: [
        { node_id: 'CHECK1', id: 1, conclusion: 'success', status: 'completed', completed_at: now, name: 'test' },
      ],
      [`https://api.github.com/repos/${repo}/commits/merge1/check-runs?per_page=30`]: [],
    }
    const urls: string[] = []
    const recordingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      return new Response(JSON.stringify(routes[url] ?? []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await fetchGitHubEvents({ ...opts, fetch: recordingFetch })

    expect(result.status).toBe('ok')
    // CI is discovered from the merged PR's head sha...
    expect(urls).toContain(`https://api.github.com/repos/${repo}/commits/headsha1/check-runs?per_page=30`)
    expect(result.input.ciChecks ?? []).toHaveLength(1)
    // ...and the default-branch commit walk is gone, because it was the single
    // biggest source of requests and every check it found was discarded anyway.
    expect(urls).not.toContain(`https://api.github.com/repos/${repo}/commits?per_page=30`)
    expect(urls).not.toContain(`https://api.github.com/repos/${repo}/commits?per_page=30&page=2`)
  })

  it('emits throttled progress as each repository is read', async () => {
    const repo = 'widgets'
    const routes: Record<string, unknown> = {}
    const progress: Array<{ repositoryIndex: number; repositoryCount: number; repository: string }> = []

    await fetchGitHubEvents({
      login: 'octo',
      repos: [repo, 'tools'],
      fetch: stubFetch(routes),
      onProgress: (event) => progress.push(event),
    })

    // Repository boundaries always emit, so the caller learns both the current
    // repository and the real total it can measure a percentage against.
    expect(progress.some((event) => event.repository === repo && event.repositoryCount === 2)).toBe(true)
    expect(progress.some((event) => event.repository === 'tools' && event.repositoryIndex === 2)).toBe(true)
  })

  it('stops reading remaining repositories once the caller aborts', async () => {
    // Cancelling used to abandon only the response while the server kept
    // walking every remaining repository against the account's hourly request
    // budget. A cancelled sync must actually stop requesting.
    const controller = new AbortController()
    const urls: string[] = []
    const abortingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/repos/first/')) controller.abort()
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    await fetchGitHubEvents({
      login: 'octo',
      repos: ['first', 'second', 'third'],
      fetch: abortingFetch,
      signal: controller.signal,
    })

    expect(urls.some((url) => url.includes('/repos/first/'))).toBe(true)
    expect(urls.some((url) => url.includes('/repos/second/'))).toBe(false)
    expect(urls.some((url) => url.includes('/repos/third/'))).toBe(false)
  })

  it('makes no requests at all when handed an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    let requests = 0
    const countingFetch = (async () => {
      requests += 1
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const result = await fetchGitHubEvents({
      login: 'octo',
      repos: ['first'],
      fetch: countingFetch,
      signal: controller.signal,
    })

    // The repository loop is never entered, so nothing is spent on a sync the
    // caller has already given up on.
    expect(requests).toBe(0)
    // Nothing was readable, so the caller must withhold the baseline.
    expect(result.status).toBe('unavailable')
  })

  it('caps commit-detail requests per repository so a 25-repo sync can finish', async () => {
    // GitHub returns `stats` only from the single-commit endpoint, so every
    // commit costs one request. An uncapped walk issued up to 180 detail calls
    // for one repository (2 attribution fields x 3 pages x 30), which let a
    // 25-repository sync spend roughly 7,000 requests against GitHub's
    // 5,000/hour budget and never converge.
    const repo = 'widgets'
    const page = Array.from({ length: 30 }, (_, index) => ({
      sha: `sha-${index + 1}`,
      author: { login: 'octo' },
    }))
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/releases?per_page=30`]: [],
      [`https://api.github.com/repos/${repo}/issues?state=closed&per_page=30&page=1`]: [],
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: page,
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=2`]: page,
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=3`]: page,
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=1`]: page,
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=2`]: page,
      [`https://api.github.com/repos/${repo}/commits?committer=octo&per_page=30&page=3`]: page,
    }
    const urls: string[] = []
    const recordingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      return new Response(JSON.stringify(routes[url] ?? []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await fetchGitHubEvents({ ...opts, repos: [repo], fetch: recordingFetch })

    // Each attribution field exposes 90 commits, so without the ceiling this
    // would be up to 180 detail requests for a single repository.
    const detailCalls = urls.filter((url) => /\/commits\/sha-\d+$/u.test(url)).length
    expect(detailCalls).toBeGreaterThan(0)
    expect(detailCalls).toBeLessThanOrEqual(30)
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

  it('fetches attributed commit details and preserves the stable repository ID', async () => {
    const occurredAt = '2026-09-12T12:00:00Z'
    const repo = 'acme/widgets'
    const routes: Record<string, unknown> = {
      [`https://api.github.com/repos/${repo}/commits?author=octo&per_page=30&page=1`]: [
        { sha: 'sha-1', author: { login: 'octo' } },
        { sha: 'sha-2', author: { login: 'someone-else' } },
      ],
      [`https://api.github.com/repos/${repo}/commits/sha-1`]: {
        sha: 'sha-1',
        commit: { author: { date: occurredAt } },
        stats: { additions: 4, deletions: 1, total: 1 },
        files: [{ filename: 'src/app.ts' }],
      },
    }
    const result = await fetchGitHubEvents({
      login: 'octo',
      repos: [{ fullName: repo, id: '777' }],
      fetch: stubFetch(routes),
    })

    expect(result.input.commits).toEqual([
      expect.objectContaining({
        id: 'sha-1',
        repositoryId: '777',
        occurredAt,
        additions: 4,
        deletions: 1,
        changedFiles: 1,
        changedPaths: ['src/app.ts'],
        contentChanged: true,
      }),
    ])
  })
})
