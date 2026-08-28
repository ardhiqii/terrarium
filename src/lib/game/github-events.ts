import {
  asCompanionId,
  makeEventId,
  type CompanionId,
  type EventCap,
  type NormalizedEvent,
} from './events'

/**
 * The deliberately small, provider-facing records needed by the game.
 *
 * These are not GitHub API response types. An adapter at the GitHub boundary
 * can map REST, GraphQL, webhook, or fixture data into these records without
 * making the game depend on GitHub's response shape.
 */
export interface GitHubCommitRecord {
  readonly id: string
  readonly repositoryId: string
  readonly occurredAt: string
  readonly additions?: number
  readonly deletions?: number
  readonly changedFiles?: number
  readonly changedPaths?: readonly string[]
  readonly isEmpty?: boolean
  readonly generatedOnly?: boolean
  readonly unchangedMetadata?: boolean
  readonly metadataOnly?: boolean
  readonly contentChanged?: boolean
}

export interface GitHubMergedPullRequestRecord {
  readonly id: string
  readonly repositoryId: string
  readonly number?: number
  readonly mergedAt: string
  readonly headSha?: string
  readonly mergeCommitSha?: string
}

export interface GitHubReleaseRecord {
  readonly id: string
  readonly repositoryId: string
  readonly tagName?: string
  readonly publishedAt: string
  readonly draft?: boolean
  readonly published?: boolean
}

export interface GitHubLinkedIssueRecord {
  readonly id: string
  readonly repositoryId: string
  readonly number?: number
  readonly closedAt: string
  readonly linkedPullRequestId?: string
  readonly linkedPullRequestIds?: readonly string[]
  readonly linkedProjectId?: string
  readonly linkedRepositoryId?: string
  readonly linkedToProject?: boolean
}

export interface GitHubCiCheckRecord {
  readonly id: string
  readonly repositoryId: string
  readonly completedAt: string
  readonly conclusion?: string
  readonly status?: string
  readonly pullRequestId?: string
  readonly pullRequestNumber?: number
  readonly commitSha?: string
  readonly name?: string
}

export interface GitHubEventNormalizationInput {
  /** Stable identity of the connected GitHub account, not a scan timestamp. */
  readonly sourceId: string
  readonly companionId: CompanionId | string
  readonly commits?: readonly GitHubCommitRecord[]
  readonly mergedPullRequests?: readonly GitHubMergedPullRequestRecord[]
  readonly releases?: readonly GitHubReleaseRecord[]
  readonly linkedIssues?: readonly GitHubLinkedIssueRecord[]
  readonly ciChecks?: readonly GitHubCiCheckRecord[]
}

const SESSION_MINUTES = 120

const CATEGORY_ORDER: Readonly<Record<NormalizedEvent['category'], number>> = {
  'qualifying-active-day': 0,
  'work-session': 1,
  'new-note': 2,
  'new-words': 3,
  'resolved-wikilink': 4,
  'merged-pull-request': 5,
  'published-release': 6,
  'closed-linked-issue': 7,
  'successful-ci': 8,
}

interface ActivityFact {
  readonly id: string
  readonly occurredAt: string
}

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`)
  return normalized
}

function isoTimestamp(value: string, field: string): string {
  const normalized = assertNonEmpty(value, field)
  const timestamp = new Date(normalized)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`)
  }
  return timestamp.toISOString()
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function recordKey(record: { repositoryId: string; id: string }): string {
  return `${record.repositoryId}\u0000${record.id}`
}

/** Deduplicate source deliveries without making output depend on input order. */
function uniqueRecords<T extends { repositoryId: string; id: string }>(
  records: readonly T[],
): T[] {
  const ordered = [...records].sort((left, right) =>
    stableSerialize(left).localeCompare(stableSerialize(right)),
  )
  const unique = new Map<string, T>()

  for (const record of ordered) {
    const repositoryId = assertNonEmpty(record.repositoryId, 'repositoryId')
    const id = assertNonEmpty(record.id, 'id')
    const normalizedRecord = {
      ...record,
      repositoryId,
      id,
    } as T
    const key = recordKey(normalizedRecord)
    if (!unique.has(key)) unique.set(key, normalizedRecord)
  }

  return [...unique.values()].sort((left, right) =>
    recordKey(left).localeCompare(recordKey(right)),
  )
}

function isGeneratedPath(path: string): boolean {
  const normalized = path.trim().toLowerCase()
  return (
    normalized.endsWith('.map') ||
    normalized.endsWith('.min.js') ||
    normalized.endsWith('.min.css') ||
    normalized.startsWith('dist/') ||
    normalized.includes('/dist/') ||
    normalized.startsWith('build/') ||
    normalized.includes('/build/') ||
    normalized.startsWith('coverage/') ||
    normalized.includes('/coverage/') ||
    normalized.endsWith('/package-lock.json') ||
    normalized.endsWith('/yarn.lock') ||
    normalized.endsWith('/pnpm-lock.yaml') ||
    normalized === 'package-lock.json' ||
    normalized === 'yarn.lock' ||
    normalized === 'pnpm-lock.yaml'
  )
}

function isIgnoredCommit(commit: GitHubCommitRecord): boolean {
  if (commit.isEmpty === true) return true
  if (commit.generatedOnly === true) return true
  if (commit.unchangedMetadata === true || commit.metadataOnly === true) return true
  if (commit.contentChanged === false) return true

  const hasZeroStats =
    commit.changedFiles === 0 &&
    (commit.additions === undefined || commit.additions === 0) &&
    (commit.deletions === undefined || commit.deletions === 0)
  if (hasZeroStats) return true

  const paths = commit.changedPaths?.filter((path) => path.trim().length > 0) ?? []
  return paths.length > 0 && paths.every(isGeneratedPath)
}

function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10)
}

function sessionBucket(timestamp: string): string {
  const date = new Date(timestamp)
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  const bucket = Math.floor(minutes / SESSION_MINUTES)
  return `${dayOf(timestamp)}-${String(bucket).padStart(2, '0')}`
}

function cap(sourceId: string, day: string, name: string): EventCap {
  return {
    key: `github:${sourceId}:${day}:${name}`,
    limit: name === 'work-session' ? 2 : 1,
  }
}

function eventBase(
  input: GitHubEventNormalizationInput,
  nativeEventId: string,
  category: NormalizedEvent['category'],
  occurredAt: string,
  metadata?: Readonly<Record<string, string | number | boolean>>,
  eventCap?: EventCap,
): NormalizedEvent {
  return {
    eventId: makeEventId('github', input.sourceId, nativeEventId),
    companionId: asCompanionId(input.companionId),
    source: 'github',
    sourceId: input.sourceId,
    provenance: 'verified',
    category,
    occurredAt,
    ...(eventCap ? { cap: eventCap } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function pullRequestKeys(
  pullRequest: GitHubMergedPullRequestRecord,
): readonly string[] {
  const keys = [recordKey(pullRequest)]
  if (pullRequest.number !== undefined) {
    keys.push(`${pullRequest.repositoryId}\u0000${pullRequest.number}`)
  }
  return keys
}

function pullRequestMatches(
  value: string | undefined,
  pullRequest: GitHubMergedPullRequestRecord,
): boolean {
  if (!value) return false
  return pullRequestKeys(pullRequest).includes(
    `${pullRequest.repositoryId}\u0000${value.trim()}`,
  )
}

function checkMatchesPullRequest(
  check: GitHubCiCheckRecord,
  pullRequest: GitHubMergedPullRequestRecord,
): boolean {
  if (check.repositoryId !== pullRequest.repositoryId) return false
  if (pullRequestMatches(check.pullRequestId, pullRequest)) return true
  if (
    check.pullRequestNumber !== undefined &&
    pullRequest.number === check.pullRequestNumber
  ) {
    return true
  }
  return Boolean(
    check.commitSha &&
      (check.commitSha === pullRequest.headSha ||
        check.commitSha === pullRequest.mergeCommitSha),
  )
}

function uniqueEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  const byId = new Map<string, NormalizedEvent>()
  const ordered = [...events].sort((left, right) => {
    const leftKey = stableSerialize(left)
    const rightKey = stableSerialize(right)
    return leftKey.localeCompare(rightKey)
  })

  for (const event of ordered) {
    if (!byId.has(event.eventId)) byId.set(event.eventId, event)
  }

  return [...byId.values()].sort((left, right) => {
    const timestamp = left.occurredAt.localeCompare(right.occurredAt)
    if (timestamp !== 0) return timestamp
    const category = CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
    if (category !== 0) return category
    return left.eventId.localeCompare(right.eventId)
  })
}

/**
 * Normalize already-fetched GitHub activity into verified ledger events.
 *
 * Commits are evidence used to create one active-day event and deterministic
 * two-hour work-session candidates; they do not award XP directly. The event
 * ledger applies the attached caps across all deliveries and companions.
 */
export function normalizeGitHubEvents(
  input: GitHubEventNormalizationInput,
): readonly NormalizedEvent[] {
  const sourceId = assertNonEmpty(input.sourceId, 'sourceId')
  const companionId = asCompanionId(input.companionId)
  const normalizedInput = { ...input, sourceId, companionId }

  const commits = uniqueRecords(input.commits ?? []).map((commit) => ({
    ...commit,
    occurredAt: isoTimestamp(commit.occurredAt, 'commit.occurredAt'),
  }))
  const pullRequests = uniqueRecords(input.mergedPullRequests ?? []).map((pullRequest) => ({
    ...pullRequest,
    mergedAt: isoTimestamp(pullRequest.mergedAt, 'pullRequest.mergedAt'),
  }))
  const releases = uniqueRecords(input.releases ?? []).map((release) => ({
    ...release,
    publishedAt: isoTimestamp(release.publishedAt, 'release.publishedAt'),
  }))
  const issues = uniqueRecords(input.linkedIssues ?? []).map((issue) => ({
    ...issue,
    closedAt: isoTimestamp(issue.closedAt, 'issue.closedAt'),
  }))
  const checks = uniqueRecords(input.ciChecks ?? []).map((check) => ({
    ...check,
    completedAt: isoTimestamp(check.completedAt, 'check.completedAt'),
  }))

  const events: NormalizedEvent[] = []
  const activity: ActivityFact[] = []
  const meaningfulCommits = commits.filter((commit) => !isIgnoredCommit(commit))

  for (const commit of meaningfulCommits) {
    activity.push({
      id: `commit:${recordKey(commit)}`,
      occurredAt: commit.occurredAt,
    })
  }

  for (const pullRequest of pullRequests) {
    events.push(
      eventBase(
        normalizedInput,
        `pull-request:${recordKey(pullRequest)}`,
        'merged-pull-request',
        pullRequest.mergedAt,
        {
          repositoryId: pullRequest.repositoryId,
          ...(pullRequest.number === undefined ? {} : { number: pullRequest.number }),
        },
      ),
    )
    activity.push({
      id: `pull-request:${recordKey(pullRequest)}`,
      occurredAt: pullRequest.mergedAt,
    })
  }

  for (const release of releases) {
    if (release.draft === true || release.published === false) continue
    events.push(
      eventBase(
        normalizedInput,
        `release:${recordKey(release)}`,
        'published-release',
        release.publishedAt,
        {
          repositoryId: release.repositoryId,
          ...(release.tagName ? { tagName: release.tagName } : {}),
        },
      ),
    )
    activity.push({
      id: `release:${recordKey(release)}`,
      occurredAt: release.publishedAt,
    })
  }

  const mergedPullRequestByKey = new Map<string, GitHubMergedPullRequestRecord>()
  for (const pullRequest of pullRequests) {
    for (const key of pullRequestKeys(pullRequest)) {
      mergedPullRequestByKey.set(key, pullRequest)
    }
  }

  for (const issue of issues) {
    const linkedIds = [
      ...(issue.linkedPullRequestIds ?? []),
      ...(issue.linkedPullRequestId ? [issue.linkedPullRequestId] : []),
    ].map((id) => id.trim()).filter(Boolean)
    const linkedPullRequest = linkedIds
      .map((id) => mergedPullRequestByKey.get(`${issue.repositoryId}\u0000${id}`))
      .find((value): value is GitHubMergedPullRequestRecord => value !== undefined)
    const linkedToProject =
      issue.linkedToProject === true ||
      issue.linkedProjectId === issue.repositoryId ||
      issue.linkedRepositoryId === issue.repositoryId

    if (!linkedPullRequest && !linkedToProject) continue

    events.push(
      eventBase(
        normalizedInput,
        `issue:${recordKey(issue)}`,
        'closed-linked-issue',
        issue.closedAt,
        {
          repositoryId: issue.repositoryId,
          ...(issue.number === undefined ? {} : { number: issue.number }),
          ...(linkedPullRequest ? { linkedPullRequestId: linkedPullRequest.id } : {}),
        },
      ),
    )
    activity.push({
      id: `issue:${recordKey(issue)}`,
      occurredAt: issue.closedAt,
    })
  }

  const successfulCiByPullRequest = new Map<string, GitHubCiCheckRecord>()
  for (const check of checks) {
    if (check.conclusion?.toLowerCase() !== 'success') continue
    if (check.status && check.status.toLowerCase() !== 'completed') continue

    const pullRequest = pullRequests.find((candidate) =>
      checkMatchesPullRequest(check, candidate),
    )
    if (!pullRequest) continue

    const key = recordKey(pullRequest)
    const previous = successfulCiByPullRequest.get(key)
    if (
      !previous ||
      `${check.completedAt}:${check.id}` < `${previous.completedAt}:${previous.id}`
    ) {
      successfulCiByPullRequest.set(key, check)
    }
  }

  for (const [pullRequestKey, check] of successfulCiByPullRequest) {
    const pullRequest = pullRequests.find((candidate) => recordKey(candidate) === pullRequestKey)
    if (!pullRequest) continue
    events.push(
      eventBase(
        normalizedInput,
        `ci-success:${pullRequestKey}`,
        'successful-ci',
        check.completedAt,
        {
          repositoryId: check.repositoryId,
          pullRequestId: pullRequest.id,
          ...(check.name ? { checkName: check.name } : {}),
        },
      ),
    )
    activity.push({
      id: `ci-success:${pullRequestKey}`,
      occurredAt: check.completedAt,
    })
  }

  const activityByDay = new Map<string, ActivityFact[]>()
  for (const fact of activity) {
    const day = dayOf(fact.occurredAt)
    const facts = activityByDay.get(day) ?? []
    facts.push(fact)
    activityByDay.set(day, facts)
  }

  for (const [day, facts] of activityByDay) {
    const orderedFacts = [...facts].sort((left, right) => {
      const timestamp = left.occurredAt.localeCompare(right.occurredAt)
      return timestamp !== 0 ? timestamp : left.id.localeCompare(right.id)
    })
    events.push(
      eventBase(
        normalizedInput,
        `active-day:${day}`,
        'qualifying-active-day',
        orderedFacts[0].occurredAt,
        { activityCount: facts.length },
        cap(sourceId, day, 'qualifying-active-day'),
      ),
    )
  }

  const commitsBySession = new Map<string, GitHubCommitRecord[]>()
  for (const commit of meaningfulCommits) {
    const bucket = sessionBucket(commit.occurredAt)
    const session = commitsBySession.get(bucket) ?? []
    session.push(commit)
    commitsBySession.set(bucket, session)
  }

  for (const [bucket, session] of commitsBySession) {
    const orderedCommits = [...session].sort((left, right) => {
      const timestamp = left.occurredAt.localeCompare(right.occurredAt)
      return timestamp !== 0 ? timestamp : left.id.localeCompare(right.id)
    })
    const day = bucket.slice(0, 10)
    events.push(
      eventBase(
        normalizedInput,
        `work-session:${bucket}`,
        'work-session',
        orderedCommits[0].occurredAt,
        { activityCount: session.length, sessionBucket: bucket },
        cap(sourceId, day, 'work-session'),
      ),
    )
  }

  return uniqueEvents(events)
}

/** Common spelling alias for callers that use GitHub's lowercase h. */
export const normalizeGithubEvents = normalizeGitHubEvents
