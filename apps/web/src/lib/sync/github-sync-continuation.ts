import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getSessionSecret } from './session-cookie'
import type { GithubEventsContinuation } from '@/lib/game/github-events-fetch'

const CONTINUATION_VERSION = 1
const CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CONTINUATION_REPOSITORIES = 500
// The sync route accepts a 16 KiB request body. Keep headroom for JSON
// framing and the active companion ID; a continuation must never be issued
// that its next request would reject before verification.
const MAX_CONTINUATION_TOKEN_LENGTH = 12 * 1024

export interface GithubSyncContinuation {
  readonly version: 1
  readonly githubId: number
  readonly issuedAt: string
  /** Digest of the server baseline map; the map itself never crosses the wire. */
  readonly baselineDigest: string
  /** Reattached by verify when the caller supplies the current server map. */
  readonly baselineByRepositoryId?: Readonly<Record<string, string>>
  readonly cursors: GithubEventsContinuation
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function sameSignature(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function validBaselineMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.entries(value).length <= MAX_CONTINUATION_REPOSITORIES &&
    Object.entries(value).every(([key, timestamp]) => (
      /^\d{1,20}$/u.test(key) && typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))
    ))
}

function baselineDigest(baselineByRepositoryId: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(Object.entries(baselineByRepositoryId).sort(([left], [right]) => left.localeCompare(right)))
  return createHash('sha256').update(canonical).digest('base64url')
}

function validPage(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000
}

function validPageMap(value: unknown, keyPattern = /^\d{1,20}$/u): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.entries(value).length <= MAX_CONTINUATION_REPOSITORIES &&
    Object.entries(value).every(([key, page]) => keyPattern.test(key) && validPage(page))
}

function validCursor(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const cursor = value as Record<string, unknown>
  const pageFields = ['page', 'pullRequestsPage', 'releasesPage', 'issuesPage']
  if (pageFields.some((field) => cursor[field] !== undefined && !validPage(cursor[field]))) return false
  if (cursor.commitsPageByAttribution !== undefined &&
    !validPageMap(cursor.commitsPageByAttribution, /^(author|committer)$/u)) return false
  if (cursor.issueTimelinePages !== undefined && !validPageMap(cursor.issueTimelinePages)) return false
  if (cursor.checkRunsPageBySha !== undefined && !validPageMap(cursor.checkRunsPageBySha, /^[A-Za-z0-9._-]{1,200}$/u)) return false
  if (cursor.pendingCheckShas !== undefined && (
    !Array.isArray(cursor.pendingCheckShas) ||
    cursor.pendingCheckShas.length > MAX_CONTINUATION_REPOSITORIES ||
    !cursor.pendingCheckShas.every((sha) => typeof sha === 'string' && /^[A-Za-z0-9._-]{1,200}$/u.test(sha))
  )) return false
  return pageFields.some((field) => cursor[field] !== undefined) ||
    cursor.commitsPageByAttribution !== undefined ||
    cursor.issueTimelinePages !== undefined ||
    cursor.checkRunsPageBySha !== undefined ||
    cursor.pendingCheckShas !== undefined
}

function validCursors(value: unknown): value is GithubEventsContinuation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length <= MAX_CONTINUATION_REPOSITORIES && entries.every(([repositoryId, cursor]) => (
    /^\d{1,20}$/u.test(repositoryId) && validCursor(cursor)
  ))
}

function validPayload(value: unknown): value is GithubSyncContinuation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return payload.version === CONTINUATION_VERSION &&
    typeof payload.githubId === 'number' && Number.isSafeInteger(payload.githubId) && payload.githubId > 0 &&
    typeof payload.issuedAt === 'string' && !Number.isNaN(Date.parse(payload.issuedAt)) &&
    typeof payload.baselineDigest === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(payload.baselineDigest) &&
    validCursors(payload.cursors)
}

function encode(payload: GithubSyncContinuation): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function issueGithubSyncContinuation(
  input: Omit<GithubSyncContinuation, 'version' | 'issuedAt' | 'baselineDigest' | 'baselineByRepositoryId'> & {
    baselineByRepositoryId: Readonly<Record<string, string>>
  },
): string {
  const secret = getSessionSecret()
  if (!secret) throw new Error('SESSION_SECRET is required to issue GitHub sync continuations')
  if (!validBaselineMap(input.baselineByRepositoryId)) throw new TypeError('Invalid GitHub sync continuation baseline')
  const payload: GithubSyncContinuation = {
    version: CONTINUATION_VERSION,
    issuedAt: new Date().toISOString(),
    githubId: input.githubId,
    baselineDigest: baselineDigest(input.baselineByRepositoryId),
    cursors: input.cursors,
  }
  if (!validPayload(payload)) throw new TypeError('Invalid GitHub sync continuation')
  const encoded = encode(payload)
  const token = `${encoded}.${sign(encoded, secret)}`
  if (token.length > MAX_CONTINUATION_TOKEN_LENGTH) throw new TypeError('GitHub sync continuation is too large')
  return token
}

export function githubSyncContinuationMatchesBaseline(
  continuation: GithubSyncContinuation,
  baselineByRepositoryId: Readonly<Record<string, string>>,
): boolean {
  return continuation.baselineDigest === baselineDigest(baselineByRepositoryId)
}

export function verifyGithubSyncContinuation(
  token: string,
  githubId: number,
): GithubSyncContinuation | null {
  const secret = getSessionSecret()
  if (!secret || typeof token !== 'string' || token.length === 0 || token.length > MAX_CONTINUATION_TOKEN_LENGTH) return null
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null
  const encoded = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (!sameSignature(sign(encoded, secret), signature)) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (!validPayload(payload) || payload.githubId !== githubId) return null
    const age = Date.now() - Date.parse(payload.issuedAt)
    if (age < -CONTINUATION_TTL_MS || age > CONTINUATION_TTL_MS) return null
    return payload
  } catch {
    return null
  }
}
