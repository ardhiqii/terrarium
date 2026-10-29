import { describe, expect, it } from 'vitest'
import {
  EMPTY_EVENT_LEDGER,
  GLOBAL_DAILY_XP_BUDGET,
  XP_BY_EVENT_CATEGORY,
  addEvents,
  asCompanionId,
  asEventId,
  budgetDayOf,
  dayOf,
  explainLedgerAcceptance,
  isIsoTimestamp,
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
 * The ledger is the one module every displayed number passes through, so its behaviour on
 * input it did not produce is part of its contract, not an edge case. Each case here was
 * reachable: a hand-edited local profile, a stale snapshot, or a crafted upload.
 */
describe('hostile ledger input', () => {
  const bucket = 'github:acct:2026-10-01:new-note'

  it('takes the SMALLEST conflicting limit in a bucket, so a later event cannot widen it', () => {
    const wide: EventCap = { key: bucket, limit: 5 }
    const narrow: EventCap = { key: bucket, limit: 1 }
    const built = ledger(
      event({ eventId: asEventId('a'), occurredAt: '2026-10-01T09:00:00.000Z', cap: wide }),
      event({ eventId: asEventId('b'), occurredAt: '2026-10-01T10:00:00.000Z', cap: narrow }),
      event({ eventId: asEventId('c'), occurredAt: '2026-10-01T11:00:00.000Z', cap: wide }),
    )

    const { accepted, rejected } = explainLedgerAcceptance(built)

    // One accepted: the narrow limit wins, and the earliest event in the bucket keeps it.
    expect(accepted.map((item) => item.eventId)).toEqual(['a'])
    expect([...rejected.entries()]).toEqual([
      ['b', 'source-cap'],
      ['c', 'source-cap'],
    ])
  })

  it('still counts a cap key that carries no date, and charges it to the event day', () => {
    // Reachable from a stored snapshot written before the key carried a day. It must not
    // throw, and it must not invent a bucket of its own.
    const undated: EventCap = { key: 'cap-aaaaaaaa-bbbbbbbb', limit: 2 }
    const built = ledger(
      event({ eventId: asEventId('x1'), occurredAt: '2026-10-01T09:00:00.000Z', cap: undated }),
      event({ eventId: asEventId('x2'), occurredAt: '2026-10-01T10:00:00.000Z', cap: undated }),
      event({ eventId: asEventId('x3'), occurredAt: '2026-10-01T11:00:00.000Z', cap: undated }),
    )

    const { accepted, rejected } = explainLedgerAcceptance(built)
    expect(accepted).toHaveLength(2)
    expect(rejected.size).toBe(1)
    expect(budgetDayOf(accepted[0])).toBe('2026-10-01')
  })

  it('reads the day from an @day annotation on an otherwise opaque key', () => {
    // This is the shape the sync contract produces: hash for privacy, day appended so the
    // budget keeps working after a round trip.
    const annotated: EventCap = { key: 'cap-aaaaaaaa-bbbbbbbb@2026-10-01', limit: 1 }
    const one = event({ eventId: asEventId('y1'), occurredAt: '2019-03-04T09:00:00.000Z', cap: annotated })

    expect(budgetDayOf(one)).toBe('2026-10-01')
    expect(dayOf(one.occurredAt)).toBe('2019-03-04')
  })

  it('groups an annotated key and its bare hash as ONE bucket, so a migration cannot double it', () => {
    // A stored event from before the annotation and a fresh one for the same day must share
    // the bucket, or the day's allowance silently doubles on the deploy that added it.
    const bare: EventCap = { key: 'cap-aaaaaaaa-bbbbbbbb', limit: 1 }
    const annotated: EventCap = { key: 'cap-aaaaaaaa-bbbbbbbb@2026-10-01', limit: 1 }
    const built = ledger(
      event({ eventId: asEventId('z1'), occurredAt: '2026-10-01T09:00:00.000Z', cap: bare }),
      event({ eventId: asEventId('z2'), occurredAt: '2026-10-01T10:00:00.000Z', cap: annotated }),
    )

    const { accepted, rejected } = explainLedgerAcceptance(built)
    expect(accepted).toHaveLength(1)
    expect(rejected.size).toBe(1)
  })

  it('never lets an unknown category poison a companion total with NaN', () => {
    // A missing rate used to make this sum NaN, which travelled into the wire snapshot and
    // turned a clean 400 into a 500.
    const unknown = { ...event({ eventId: asEventId('n1') }), category: 'not-a-category' as never }
    const totals = sumXpPerCompanion(ledger(unknown))

    expect(Number.isFinite(totals[companionA] as number)).toBe(true)
    expect(totals[companionA]).toBe(0)
  })

  it('does not treat a leniently parseable string as a timestamp', () => {
    // `Date.parse('garbage-0')` is 2000-01-01 in V8: reading trailing digits as a year.
    // Accepting that gave every invented string its own budget day.
    expect(isIsoTimestamp('garbage-0')).toBe(false)
    expect(dayOf('garbage-0')).toBe('0000-00-00')
    expect(isIsoTimestamp('2026-10-01T00:30:00.000Z')).toBe(true)
    // A date-time with no zone is read in the SERVER's local time, which makes the budget day
    // depend on where the process runs. Only explicit zones count; a bare date is UTC.
    expect(isIsoTimestamp('2026-10-01T10:00:00')).toBe(false)
    expect(isIsoTimestamp('2026-10-01T10:00:00+07:00')).toBe(true)
    expect(dayOf('2026-10-01')).toBe('2026-10-01')
  })

  it('keeps a malformed-timestamp ledger inside one budget', () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      event({ eventId: asEventId(`m${i}`), occurredAt: `garbage-${i}` }),
    )
    const { accepted } = explainLedgerAcceptance(ledger(...events))

    expect(totalXpOf(accepted)).toBeLessThanOrEqual(GLOBAL_DAILY_XP_BUDGET)
  })
})
