import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueVerifiedEventProof, verifyVerifiedEventProof } from './verified-event-proof'
import type { ProductSnapshotEvent } from './product-snapshot'

const event: ProductSnapshotEvent = {
  eventId: 'event-12345678-abcdef01',
  companionId: 'pikachu-family',
  source: 'github',
  provenance: 'verified',
  category: 'work-session',
  occurredAt: '2026-09-14T00:00:00.000Z',
}

describe('verified event proofs', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('issues an account-bound proof and rejects tampering', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const proof = issueVerifiedEventProof(event, 42)

    expect(verifyVerifiedEventProof(event, 42, proof)).toBe(true)
    expect(verifyVerifiedEventProof({ ...event, category: 'published-release' }, 42, proof)).toBe(false)
    expect(verifyVerifiedEventProof(event, 43, proof)).toBe(false)
  })

  it('refuses to issue a receipt without a strong session secret', () => {
    vi.stubEnv('SESSION_SECRET', 'short')

    expect(() => issueVerifiedEventProof(event, 42)).toThrow(/SESSION_SECRET/i)
  })
})
