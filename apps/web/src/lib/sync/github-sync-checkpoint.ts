import { createHmac, timingSafeEqual } from 'node:crypto'
import { getSessionSecret } from './session-cookie'

const CHECKPOINT_VERSION = 1
const CHECKPOINT_TTL_MS = 10 * 60 * 1000
const PRODUCT_EVENT_ID = /^event-[0-9a-f]{8}-[0-9a-f]{8}$/u

export interface GithubSyncCheckpoint {
  readonly version: 1
  readonly githubId: number
  readonly issuedAt: string
  readonly previousBaselineByRepositoryId: Readonly<Record<string, string>>
  readonly nextBaselineByRepositoryId: Readonly<Record<string, string>>
  readonly nextLastSyncedAt: string | null
  readonly eventIds: readonly string[]
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function sameSignature(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function encode(payload: GithubSyncCheckpoint): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function validBaselineMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.entries(value).length <= 100 &&
    Object.entries(value).every(([key, timestamp]) =>
      /^\d{1,20}$/u.test(key) && typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp)),
    )
}

function validPayload(value: unknown): value is GithubSyncCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (
    payload.version !== CHECKPOINT_VERSION ||
    typeof payload.githubId !== 'number' ||
    !Number.isSafeInteger(payload.githubId) ||
    typeof payload.issuedAt !== 'string' ||
    Number.isNaN(Date.parse(payload.issuedAt)) ||
    !validBaselineMap(payload.previousBaselineByRepositoryId) ||
    !validBaselineMap(payload.nextBaselineByRepositoryId) ||
    (payload.nextLastSyncedAt !== null &&
      (typeof payload.nextLastSyncedAt !== 'string' || Number.isNaN(Date.parse(payload.nextLastSyncedAt)))) ||
    !Array.isArray(payload.eventIds) ||
    payload.eventIds.length > 500 ||
    !payload.eventIds.every((eventId) => typeof eventId === 'string' && PRODUCT_EVENT_ID.test(eventId))
  ) return false
  const eventIds = payload.eventIds as string[]
  return new Set(eventIds).size === eventIds.length
}

/** Issue a short-lived signed checkpoint that commits only after product sync succeeds. */
export function issueGithubSyncCheckpoint(input: Omit<GithubSyncCheckpoint, 'version' | 'issuedAt'>): string {
  const secret = getSessionSecret()
  if (!secret) throw new Error('SESSION_SECRET is required to issue GitHub sync checkpoints')
  const payload: GithubSyncCheckpoint = {
    version: CHECKPOINT_VERSION,
    issuedAt: new Date().toISOString(),
    ...input,
  }
  if (!validPayload(payload)) throw new TypeError('Invalid GitHub sync checkpoint')
  const encoded = encode(payload)
  return `${encoded}.${sign(encoded, secret)}`
}

/** Verify account binding, integrity, shape, and freshness of a checkpoint. */
export function verifyGithubSyncCheckpoint(token: string, githubId: number): GithubSyncCheckpoint | null {
  const secret = getSessionSecret()
  if (!secret || typeof token !== 'string' || token.length > 64 * 1024) return null
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null
  const encoded = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (!sameSignature(sign(encoded, secret), signature)) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (!validPayload(payload) || payload.githubId !== githubId) return null
    const age = Date.now() - Date.parse(payload.issuedAt)
    if (age < -CHECKPOINT_TTL_MS || age > CHECKPOINT_TTL_MS) return null
    return payload
  } catch {
    return null
  }
}
