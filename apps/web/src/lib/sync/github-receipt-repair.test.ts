import { describe, expect, it } from 'vitest'
import {
  MAX_RECEIPT_REPAIR_EVENT_IDS,
  mergeRepairedProofs,
  parseReceiptFailures,
  parseReceiptRepairResponse,
} from './github-receipt-repair'

const event = {
  eventId: 'event-12345678-abcdef12',
  companionId: 'pikachu-family',
  source: 'github' as const,
  provenance: 'verified' as const,
  category: 'work-session' as const,
  occurredAt: '2026-09-23T10:00:00.000Z',
}

describe('GitHub receipt repair contracts', () => {
  it('bounds and deduplicates product-route failure diagnostics', () => {
    const failures = parseReceiptFailures({
      receiptFailures: Array.from({ length: MAX_RECEIPT_REPAIR_EVENT_IDS + 2 }, (_, index) => ({
        eventId: `event-${index.toString(16).padStart(8, '0')}-abcdef12`,
        reason: 'receipt-mismatch',
        payloadDigest: '0123456789abcdef',
      })),
    })
    expect(failures).toHaveLength(MAX_RECEIPT_REPAIR_EVENT_IDS)
  })

  it('accepts only bounded repair items and preserves unrelated proofs', () => {
    const repaired = parseReceiptRepairResponse({
      repaired: [{
        eventId: event.eventId,
        proof: 'fresh-proof',
        payloadDigest: '0123456789abcdef',
        event,
      }],
      blocked: [{ eventId: 'event-12345678-deadbeef', reason: 'activity-not-found' }],
      requestsDone: 7,
      repositoryCount: 16,
      skippedRepositoryCount: 4,
      syncStatus: 'ok',
      truncated: false,
    })
    expect(repaired?.repaired[0]?.eventId).toBe(event.eventId)
    expect(repaired?.blocked[0]?.reason).toBe('activity-not-found')
    expect(mergeRepairedProofs({ [event.eventId]: 'old', 'event-12345678-deadbeef': 'other' }, repaired?.repaired ?? []))
      .toEqual({ [event.eventId]: 'fresh-proof', 'event-12345678-deadbeef': 'other' })
  })
})
