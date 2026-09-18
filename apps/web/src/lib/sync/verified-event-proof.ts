import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
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

/**
 * A short digest of the exact payload a receipt covers.
 *
 * The receipt itself must never be reproducible by a client: returning the
 * recomputed HMAC would hand out a valid receipt for any invented event. A
 * digest is safe to expose because it is a one-way hash of the payload the
 * client already owns, and it is what lets a mint-side payload and a
 * verify-side payload be compared when a receipt fails to verify.
 */
export function verifiedEventProofPayloadDigest(event: ProductSnapshotEvent, githubId: number): string {
  return createHash('sha256').update(productEventProofPayload(event, githubId)).digest('hex').slice(0, 16)
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
