import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ProductSnapshotEvent } from './product-snapshot'
import { productEventProofPayload } from './product-event-proof-payload'
import { getSessionSecret } from './session-cookie'

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function matches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Issue a receipt only from the server-side GitHub sync route. */
export function issueVerifiedEventProof(event: ProductSnapshotEvent, githubId: number): string {
  const secret = getSessionSecret()
  if (!secret) throw new Error('SESSION_SECRET is required to issue verified event receipts')
  return sign(productEventProofPayload(event, githubId), secret)
}

/** Verify that a product upload contains an event this account's server sync issued. */
export function verifyVerifiedEventProof(
  event: ProductSnapshotEvent,
  githubId: number,
  proof: string,
): boolean {
  const secret = getSessionSecret()
  if (!secret || !proof) return false
  return matches(sign(productEventProofPayload(event, githubId), secret), proof)
}
