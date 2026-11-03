import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type NormalizedEvent } from '../events'
import {
  ITEM_INVENTORY_MAX,
  itemForCategory,
  planItemGrants,
  toyGrantFor,
} from './items'
import {
  createCareState,
  earliestStart,
  inventoryOf,
  mergeCareState,
  mintCareItems,
  spendItem,
  validateCareState,
  type CareState,
} from './state'

/**
 * The item economy is where a small bug becomes a permanent advantage: a mint
 * that fires twice hands out a second meal for the same merged pull request,
 * and nothing on screen ever shows that it happened. So these tests replay,
 * re-read and re-mint on purpose.
 */

const NOW = new Date('2026-11-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function event(
  category: NormalizedEvent['category'],
  occurredAt: string,
  id = `${category}:${occurredAt}`,
): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId('pikachu-family'),
    source: 'github',
    sourceId: 'repo-1',
    provenance: 'local',
    category,
    occurredAt,
  }
}

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString()
}

describe('what earns what', () => {
  it('maps each earning category to exactly one item', () => {
    expect(itemForCategory('qualifying-active-day')).toBe('food')
    expect(itemForCategory('merged-pull-request')).toBe('food')
    expect(itemForCategory('new-note')).toBe('food')
    expect(itemForCategory('published-release')).toBe('treat')
    expect(itemForCategory('successful-ci')).toBe('medicine')
    expect(itemForCategory('closed-linked-issue')).toBe('soap')
  })

  it('gives nothing for activity that is already paid for', () => {
    expect(itemForCategory('new-words')).toBeNull()
    expect(itemForCategory('resolved-wikilink')).toBeNull()
    expect(itemForCategory('work-session')).toBeNull()
    expect(itemForCategory('maturity-changed')).toBeNull()
  })
})

describe('planning grants', () => {
  it('plans every grant, leaving the cap to the mint step', () => {
    // The planner must NOT drop surplus grants: a dropped grant leaves no
    // record, and without a record a timezone change could re-plan it as a
    // fresh grant on another local day.
    const ledger = {
      events: Array.from({ length: 10 }, (_, index) =>
        event('merged-pull-request', `2026-11-03T0${index}:00:00.000Z`, `pr-${index}`),
      ),
    }
    const grants = planItemGrants(ledger)
    expect(grants.filter((grant) => grant.item === 'food')).toHaveLength(10)
  })

  it('orders grants by time, then id, so the earliest win the cap everywhere', () => {
    const ledger = {
      events: [
        event('merged-pull-request', '2026-11-03T09:00:00.000Z', 'pr-late'),
        event('merged-pull-request', '2026-11-03T01:00:00.000Z', 'pr-early'),
        event('merged-pull-request', '2026-11-03T02:00:00.000Z', 'pr-mid'),
      ],
    }
    expect(planItemGrants(ledger).map((grant) => grant.id)).toEqual([
      'pr-early',
      'pr-mid',
      'pr-late',
    ])
  })

  it('charges the cap to the viewer local day, not the UTC day', () => {
    // Two events that are on different UTC days but the same Jakarta day.
    const ledger = {
      events: [
        event('merged-pull-request', '2026-11-02T18:00:00.000Z', 'pr-a'),
        event('merged-pull-request', '2026-11-02T19:00:00.000Z', 'pr-b'),
      ],
    }
    const utc = planItemGrants(ledger, { utcOffsetMinutes: 0 })
    const jakarta = planItemGrants(ledger, { utcOffsetMinutes: 7 * 60 })
    expect(utc.map((grant) => grant.day)).toEqual(['2026-11-02', '2026-11-02'])
    expect(jakarta.map((grant) => grant.day)).toEqual(['2026-11-03', '2026-11-03'])
  })

  it('skips events with unusable timestamps instead of throwing', () => {
    const grants = planItemGrants({ events: [event('new-note', 'not-a-date')] })
    expect(grants).toEqual([])
  })

  it('survives a ledger record whose occurredAt is not a string', () => {
    // Reachable: `loadBrowserLedger` only checks that `events` is an array, and
    // this used to throw inside `localeCompare` during the House render.
    const broken = { category: 'new-note', eventId: 'x', occurredAt: 42 } as unknown as NormalizedEvent
    const good = event('merged-pull-request', '2026-11-03T10:00:00.000Z', 'pr-good')
    expect(() => planItemGrants({ events: [broken, good] })).not.toThrow()
    expect(planItemGrants({ events: [broken, good] }).map((grant) => grant.id)).toEqual([
      'pr-good',
    ])
  })
})

describe('minting', () => {
  it('mints once per event, no matter how often it is read', () => {
    const ledger = { events: [event('merged-pull-request', ago(1))] }
    const first = mintCareItems(createCareState(ago(2)), ledger, NOW)
    expect(inventoryOf(first).food).toBe(1)

    const second = mintCareItems(first, ledger, NOW)
    expect(inventoryOf(second).food).toBe(1)
    const third = mintCareItems(second, ledger, NOW)
    expect(inventoryOf(third).food).toBe(1)
  })

  it('mints the daily toy exactly once a day', () => {
    const state = mintCareItems(createCareState(ago(1)), { events: [] }, NOW)
    expect(inventoryOf(state).toy).toBe(1)
    const again = mintCareItems(state, { events: [] }, NOW)
    expect(inventoryOf(again).toy).toBe(1)
  })

  it('holds the inventory at its maximum', () => {
    // Ten merged pull requests on ten different days: more food than fits.
    const ledger = {
      events: Array.from({ length: 10 }, (_, index) =>
        event('merged-pull-request', ago(index + 1), `pr-${index}`),
      ),
    }
    const state = mintCareItems(createCareState(ago(30)), ledger, NOW)
    expect(inventoryOf(state).food).toBe(ITEM_INVENTORY_MAX.food)
  })

  it('does not keep a backlog of meals that did not fit', () => {
    const ledger = {
      events: Array.from({ length: 10 }, (_, index) =>
        event('merged-pull-request', ago(index + 1), `pr-${index}`),
      ),
    }
    const full = mintCareItems(createCareState(ago(30)), ledger, NOW)
    // Spend one. If the surplus were banked invisibly, the next read would
    // refill; it must not, because that is a month of hunger for free.
    const afterSpend = spendItem(full, 'food', NOW)
    const reread = mintCareItems(afterSpend, ledger, NOW)
    const rereadAgain = mintCareItems(reread, { events: [] }, NOW)
    expect(inventoryOf(rereadAgain).food).toBe(ITEM_INVENTORY_MAX.food - 1)
  })

  it('never lets a spend produce a negative balance', () => {
    const state = spendItem(createCareState(ago(1)), 'soap', NOW)
    expect(inventoryOf(state).soap).toBe(0)
  })

  it('mints nothing new on a replayed ledger', () => {
    const ledger = {
      events: [
        event('qualifying-active-day', ago(3)),
        event('successful-ci', ago(2)),
        event('published-release', ago(1)),
      ],
    }
    const state = mintCareItems(createCareState(ago(10)), ledger, NOW)
    const inventory = inventoryOf(state)
    const replay = mintCareItems(state, { events: [...ledger.events, ...ledger.events] }, NOW)
    expect(inventoryOf(replay)).toEqual(inventory)
  })
})

describe('inventory caps', () => {
  it('never exceeds the per-item maximum, whatever the counters say', () => {
    const state: CareState = {
      ...createCareState(ago(1)),
      granted: { food: 0, treat: 50, medicine: 0, toy: 0, soap: 0 },
    }
    expect(inventoryOf(state).treat).toBe(ITEM_INVENTORY_MAX.treat)
  })

  it('keeps the cupboard full even when the mint log has been pruned', () => {
    // Red-team finding: the log is bounded, so counting its records made a
    // long-playing user's pantry empty itself on the next read. The lifetime
    // counter is what the cupboard reads now.
    const state: CareState = {
      ...createCareState(ago(1)),
      granted: { food: 10, treat: 0, medicine: 0, toy: 0, soap: 0 },
      mints: [],
    }
    expect(inventoryOf(state).food).toBe(ITEM_INVENTORY_MAX.food)
  })
})

describe('merge', () => {
  it('keeps the newest timestamp per need from either device', () => {
    const laptop: CareState = { ...createCareState(ago(10)), lastFedAt: ago(3) }
    const phone: CareState = { ...createCareState(ago(20)), lastRestedAt: ago(1) }
    const merged = mergeCareState(laptop, phone)
    expect(merged.lastFedAt).toBe(laptop.lastFedAt)
    expect(merged.lastRestedAt).toBe(phone.lastRestedAt)
  })

  it('keeps the EARLIER start, so a merge cannot make the companion younger', () => {
    const older: CareState = createCareState(ago(30))
    const newer: CareState = createCareState(ago(1))
    expect(earliestStart(older, newer)).toBe(older.startedAt)
    expect(mergeCareState(older, newer).startedAt).toBe(older.startedAt)
    expect(mergeCareState(newer, older).startedAt).toBe(older.startedAt)
  })

  it('unions mint records without double counting the lifetime grant', () => {
    const laptop = mintCareItems(createCareState(ago(2)), {
      events: [event('merged-pull-request', ago(1), 'pr-laptop')],
    }, NOW)
    const phone = mintCareItems(createCareState(ago(2)), {
      events: [event('merged-pull-request', ago(1), 'pr-phone')],
    }, NOW)
    const merged = mergeCareState(laptop, phone)
    // Both records are kept, so the dedupe log knows both events...
    expect(merged.mints.filter((mint) => mint.item === 'food')).toHaveLength(2)
    // ...but the lifetime counter merges by max, never by sum: summing would
    // double-count every grant both snapshots already shared. A grant made on
    // each device is therefore counted once, which errs toward fewer items.
    expect(merged.granted.food).toBe(1)
    expect(inventoryOf(merged).food).toBe(1)
  })

  it('does not lose a full cupboard to the other device empty log', () => {
    // The red-team case: one side has real grants, the other has a long log of
    // dropped (already-full) records that sort later. Inventory must survive.
    const withItems: CareState = {
      ...createCareState(ago(2)),
      granted: { food: 8, treat: 0, medicine: 0, toy: 0, soap: 0 },
      mints: Array.from({ length: 8 }, (_, index) => ({
        id: `food-${index}`,
        item: 'food' as const,
        at: ago(3),
        granted: true,
      })),
    }
    const fullLog: CareState = {
      ...createCareState(ago(2)),
      mints: Array.from({ length: 400 }, (_, index) => ({
        id: `dropped-${index}`,
        item: 'food' as const,
        at: ago(1),
        granted: false,
      })),
    }
    expect(inventoryOf(mergeCareState(withItems, fullLog)).food).toBe(8)
    expect(inventoryOf(mergeCareState(fullLog, withItems)).food).toBe(8)
  })

  it('treats a grant recorded on either side as granted', () => {
    const granted: CareState = {
      ...createCareState(ago(2)),
      granted: { food: 1, treat: 0, medicine: 0, toy: 0, soap: 0 },
      mints: [{ id: 'pr-1', item: 'food', at: ago(1), granted: true }],
    }
    const dropped: CareState = {
      ...createCareState(ago(2)),
      mints: [{ id: 'pr-1', item: 'food', at: ago(1), granted: false }],
    }
    const merged = mergeCareState(dropped, granted)
    expect(merged.mints[0].granted).toBe(true)
    expect(inventoryOf(merged).food).toBe(1)
  })

  it('never moves the inventory past its maximum', () => {
    const left: CareState = {
      ...createCareState(ago(2)),
      granted: { food: 50, treat: 0, medicine: 0, toy: 0, soap: 0 },
    }
    const right: CareState = {
      ...createCareState(ago(2)),
      granted: { food: 50, treat: 0, medicine: 0, toy: 0, soap: 0 },
    }
    expect(inventoryOf(mergeCareState(left, right)).food).toBe(ITEM_INVENTORY_MAX.food)
  })
})

describe('validation', () => {
  it('accepts a state this module produced', () => {
    const state = mintCareItems(createCareState(ago(1)), {
      events: [event('merged-pull-request', ago(1))],
    }, NOW)
    expect(() => validateCareState(state)).not.toThrow()
  })

  it('rejects a negative spend, which would refill the cupboard forever', () => {
    const state = { ...createCareState(ago(1)), spent: { ...createCareState(ago(1)).spent, food: -5 } }
    expect(() => validateCareState(state)).toThrow()
  })

  it('rejects an unknown item', () => {
    const state = {
      ...createCareState(ago(1)),
      mints: [{ id: 'x', item: 'cake', at: ago(1), granted: true }],
    }
    expect(() => validateCareState(state)).toThrow()
  })

  it('rejects unknown fields, so a schema change cannot slip through silently', () => {
    expect(() => validateCareState({ ...createCareState(ago(1)), happiness: 5 })).toThrow()
  })

  it('rejects a duplicate mint id', () => {
    const state = {
      ...createCareState(ago(1)),
      mints: [
        { id: 'x', item: 'food', at: ago(1), granted: true },
        { id: 'x', item: 'food', at: ago(1), granted: true },
      ],
    }
    expect(() => validateCareState(state)).toThrow()
  })
})

describe('the toy is a grant like any other', () => {
  it('uses the local day as its id', () => {
    const grant = toyGrantFor('2026-11-03', NOW)
    expect(grant).toEqual({ id: 'toy:2026-11-03', item: 'toy', at: NOW.toISOString(), day: '2026-11-03' })
  })

  it('refuses a malformed day rather than minting garbage', () => {
    expect(toyGrantFor('3 November', NOW)).toBeNull()
  })
})
