import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_EVENT_LEDGER,
  GLOBAL_DAILY_XP_BUDGET,
  XP_BY_EVENT_CATEGORY,
  addEvents,
  asCompanionId,
  asEventId,
  explainLedgerAcceptance,
  isCapDisabled,
  makeEventId,
  mergeEventLedgers,
  sumXpPerCompanion,
  totalXpOf,
  xpAwardedForEvent,
  type EventCap,
  type EventLedger,
  type NormalizedEvent,
} from './events'

const companionA = asCompanionId('companion-a')
const companionB = asCompanionId('companion-b')

function event(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    eventId: asEventId('event-1'),
    companionId: companionA,
    source: 'mounted-markdown',
    sourceId: 'vault-1',
    provenance: 'local',
    category: 'new-note',
    occurredAt: '2026-08-28T09:00:00.000Z',
    ...overrides,
  }
}

function ledger(...events: NormalizedEvent[]): EventLedger {
  return addEvents(EMPTY_EVENT_LEDGER, events)
}

describe('event IDs and normalized events', () => {
  it('creates a stable, source-scoped event ID', () => {
    expect(makeEventId('github', 'repo:42', 'pull/7')).toBe(
      'github:repo%3A42:pull%2F7',
    )
    expect(makeEventId('github', 'repo:42', 'pull/7')).toBe(
      makeEventId('github', 'repo:42', 'pull/7'),
    )
  })

  it('rejects empty IDs and empty ID parts', () => {
    expect(() => asEventId('   ')).toThrow()
    expect(() => makeEventId('github', 'repo', ' ')).toThrow()
  })
})
describe('event ledger', () => {
  it('deduplicates duplicate IDs and does not mutate the existing ledger', () => {
    const first = event()
    const original = ledger(first)
    const duplicate = event({
      category: 'published-release',
      provenance: 'verified',
    })

    const result = addEvents(original, [duplicate, event({ eventId: asEventId('event-2') })])

    expect(original.events).toEqual([first])
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toEqual(first)
    expect(sumXpPerCompanion(result)[companionA]).toBe(
      XP_BY_EVENT_CATEGORY['new-note'] + XP_BY_EVENT_CATEGORY['new-note'],
    )
  })

  it('merges snapshots idempotently and preserves independent companion totals', () => {
    const left = ledger(event({ eventId: asEventId('shared'), category: 'new-note' }))
    const right = ledger(
      event({
        eventId: asEventId('shared'),
        category: 'published-release',
      }),
      event({
        eventId: asEventId('other'),
        companionId: companionB,
        category: 'merged-pull-request',
      }),
    )

    const merged = mergeEventLedgers(left, right, left)
    expect(merged.events).toHaveLength(2)
    expect(sumXpPerCompanion(merged)).toEqual({
      [companionA]: XP_BY_EVENT_CATEGORY['new-note'],
      [companionB]: XP_BY_EVENT_CATEGORY['merged-pull-request'],
    })
  })

  it('applies cap metadata deterministically across duplicate deliveries', () => {
    const cap: EventCap = {
      key: 'mounted-markdown:vault-1:2026-08-28:work-session',
      limit: 2,
    }
    const events = [
      event({ eventId: asEventId('session-3'), occurredAt: '2026-08-28T11:00:00.000Z', cap }),
      event({ eventId: asEventId('session-1'), occurredAt: '2026-08-28T09:00:00.000Z', cap }),
      event({ eventId: asEventId('session-2'), occurredAt: '2026-08-28T10:00:00.000Z', cap }),
      event({ eventId: asEventId('session-2'), occurredAt: '2026-08-28T10:00:00.000Z', cap }),
    ]

    const totals = sumXpPerCompanion(ledger(...events))
    expect(totals[companionA]).toBe(2 * XP_BY_EVENT_CATEGORY['new-note'])
    expect(xpAwardedForEvent(ledger(...events), 'session-1')).toBe(XP_BY_EVENT_CATEGORY['new-note'])
    expect(xpAwardedForEvent(ledger(...events), 'session-2')).toBe(XP_BY_EVENT_CATEGORY['new-note'])
    expect(xpAwardedForEvent(ledger(...events), 'session-3')).toBe(0)
  })

  it('supports the active-day cap of one event per source day', () => {
    const cap: EventCap = {
      key: 'github:account-1:2026-08-28:qualifying-active-day',
      limit: 1,
    }
    const totals = sumXpPerCompanion(
      ledger(
        event({ eventId: asEventId('day-a'), category: 'qualifying-active-day', cap }),
        event({
          eventId: asEventId('day-b'),
          category: 'qualifying-active-day',
          occurredAt: '2026-08-28T18:00:00.000Z',
          cap,
        }),
      ),
    )

    expect(totals[companionA]).toBe(XP_BY_EVENT_CATEGORY['qualifying-active-day'])
  })

  it('counts local and verified provenance equally while retaining the distinction', () => {
    const local = event({ eventId: asEventId('local-note'), provenance: 'local' })
    const verified = event({
      eventId: asEventId('verified-pr'),
      source: 'github',
      sourceId: 'account-1',
      provenance: 'verified',
      category: 'merged-pull-request',
    })
    const result = addEvents(EMPTY_EVENT_LEDGER, [local, verified])

    expect(result.events.map((item) => item.provenance)).toEqual(['local', 'verified'])
    expect(sumXpPerCompanion(result)[companionA]).toBe(
      XP_BY_EVENT_CATEGORY['new-note'] +
        XP_BY_EVENT_CATEGORY['merged-pull-request'],
    )
  })
})

/**
 * `DISABLE_CAP` is a debug switch: it exists so the XP pipeline can be watched end to end,
 * with nothing clipped, while the caps are being tuned. These tests pin both directions — that
 * it really does stop clipping, and that its absence restores the caps exactly.
 *
 * Forty notes at 25 XP is 1,000 XP against a 300 budget, so a fixture small enough to pass the
 * budget would prove nothing.
 */
describe('DISABLE_CAP (debug switch)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function fortyNotes(): NormalizedEvent[] {
    return Array.from({ length: 40 }, (_, i) =>
      event({ eventId: asEventId(`debug-${i}`) }),
    )
  }

  it('skips every cap and the daily budget when true', () => {
    vi.stubEnv('DISABLE_CAP', 'true')

    const { accepted, rejected } = explainLedgerAcceptance(ledger(...fortyNotes()))

    expect(rejected.size).toBe(0)
    expect(accepted).toHaveLength(40)
    expect(totalXpOf(accepted)).toBe(40 * XP_BY_EVENT_CATEGORY['new-note'])
    // And it is visible as a single number the UI reads too, not just in this function.
    expect(sumXpPerCompanion(ledger(...fortyNotes()))[companionA]).toBe(1_000)
  })

  it('still applies the caps when unset', () => {
    vi.stubEnv('DISABLE_CAP', '')

    const { accepted, rejected } = explainLedgerAcceptance(ledger(...fortyNotes()))

    expect(isCapDisabled()).toBe(false)
    expect(totalXpOf(accepted)).toBe(GLOBAL_DAILY_XP_BUDGET)
    expect(rejected.size).toBe(40 - GLOBAL_DAILY_XP_BUDGET / XP_BY_EVENT_CATEGORY['new-note'])
  })

  it('treats anything other than true/1 as off, so a typo cannot disable it by accident', () => {
    for (const value of ['false', '0', 'yes', 'FALSE', 'True', ' ']) {
      vi.stubEnv('DISABLE_CAP', value)
      expect(isCapDisabled(), `DISABLE_CAP=${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('accepts 1 as well as true, and the lowercase spelling from a hand-written .env', () => {
    vi.stubEnv('DISABLE_CAP', '1')
    expect(isCapDisabled()).toBe(true)

    vi.unstubAllEnvs()
    vi.stubEnv('disable_cap', 'true')
    expect(isCapDisabled()).toBe(true)
  })

  it('is not shadowed by an empty DISABLE_CAP set beside it', () => {
    // The compose file passes `${DISABLE_CAP:-false}`, and an emptied line in .env produces
    // '' rather than an unset variable. An empty string must not win over a set alias.
    vi.stubEnv('DISABLE_CAP', '')
    vi.stubEnv('disable_cap', 'true')

    expect(isCapDisabled()).toBe(true)
  })

  it('does not change provenance or receipts, only which events count', () => {
    vi.stubEnv('DISABLE_CAP', 'true')
    const verified = event({
      eventId: asEventId('verified-1'),
      source: 'github',
      sourceId: 'account-1',
      provenance: 'verified',
      category: 'merged-pull-request',
    })

    const { accepted } = explainLedgerAcceptance(ledger(verified))

    // The flag is about caps. Whether an event is trusted is a separate question, answered by
    // the receipt check at the route, and this must not appear to change it.
    expect(accepted[0].provenance).toBe('verified')
  })
})
