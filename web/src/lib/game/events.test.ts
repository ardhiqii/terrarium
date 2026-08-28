import { describe, expect, it } from 'vitest'
import {
  EMPTY_EVENT_LEDGER,
  XP_BY_EVENT_CATEGORY,
  addEvents,
  asCompanionId,
  asEventId,
  makeEventId,
  mergeEventLedgers,
  sumXpPerCompanion,
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
