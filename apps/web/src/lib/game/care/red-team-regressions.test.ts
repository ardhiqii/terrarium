import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type NormalizedEvent } from '../events'
import {
  ITEM_DAILY_CAP,
  ITEM_INVENTORY_MAX,
  MAX_MINT_RECORDS,
} from './items'
import {
  createCareState,
  inventoryOf,
  mergeCareState,
  mintCareItems,
  validateCareState,
  type CareState,
} from './state'
import { deriveNeeds, deriveCareSignals, isDormant } from './needs'
import { deriveMood } from './mood'

/**
 * Regressions from the red-team pass over the first care-layer cut.
 *
 * These are kept in the repo rather than in the review notes because every one of
 * them is a bug whose symptom is invisible: a cupboard that empties itself, a
 * save loop that only appears after ~400 grants, two extra meals after a flight.
 * None of them throws, so only a test that asserts the number can catch them.
 */

const NOW = new Date('2026-11-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString()
}

function pr(id: string, occurredAt: string): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId('pikachu-family'),
    source: 'github',
    sourceId: 'repo-1',
    provenance: 'local',
    category: 'merged-pull-request',
    occurredAt,
  }
}

/** A ledger worth more grants than the mint log can hold. */
function floodLedger(): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  for (let day = 1; day <= 110; day += 1) {
    for (let slot = 0; slot < 4; slot += 1) {
      const at = new Date(NOW.getTime() - day * DAY - slot * 60_000).toISOString()
      events.push(pr(`flood-${day}-${slot}`, at))
    }
  }
  return events
}

describe('a full mint log must not empty the cupboard', () => {
  it('keeps the inventory after hundreds of grants', () => {
    const ledger = { events: floodLedger() }
    expect(ledger.events.length).toBeGreaterThan(MAX_MINT_RECORDS)

    const state = mintCareItems(createCareState(ago(120)), ledger, NOW)
    // Before the fix this was 0: granted records sorted first and were the ones
    // truncated away, so the pantry counted only the "already full" records.
    expect(inventoryOf(state).food).toBe(ITEM_INVENTORY_MAX.food)
    expect(state.mints.length).toBeLessThanOrEqual(MAX_MINT_RECORDS)
  })

  it('is idempotent on a full log: the same read returns the same object', () => {
    // The House persists whenever the minted state changes identity, so a mint
    // that reports a change on every read is a save/render loop.
    const ledger = { events: floodLedger() }
    const first = mintCareItems(createCareState(ago(120)), ledger, NOW)
    const second = mintCareItems(first, ledger, NOW)
    expect(second).toBe(first)

    const third = mintCareItems(second, ledger, new Date(NOW.getTime() + 3_600_000))
    // A different minute is not a different grant, but the daily toy is a new
    // mint only when the local day changes; an hour later it is still the same
    // day, so identity must hold here too.
    expect(third).toBe(second)
  })

  it('does not hand out a phantom grant from a record that was not retained', () => {
    const ledger = { events: floodLedger() }
    const state = mintCareItems(createCareState(ago(120)), ledger, NOW)
    // Exactly the cupboard maximum was ever granted, never one per event.
    expect(state.granted.food).toBe(ITEM_INVENTORY_MAX.food)
  })
})

describe('the daily cap survives a timezone change', () => {
  it('cannot mint a second helping of the same day after the offset moves', () => {
    const day = '2026-10-20'
    const events = [
      pr('e1', `${day}T10:00:00.000Z`),
      pr('e2', `${day}T11:00:00.000Z`),
      pr('e3', `${day}T12:00:00.000Z`),
      pr('e4', `${day}T13:00:00.000Z`),
      pr('e5', `${day}T23:00:00.000Z`),
      pr('e6', `${day}T23:30:00.000Z`),
    ]
    const state = mintCareItems(createCareState(ago(30)), { events }, NOW, {
      utcOffsetMinutes: 0,
    })
    expect(inventoryOf(state).food).toBe(ITEM_DAILY_CAP.food)

    // Two hours east, e5/e6 fall on the next local day. They were recorded as
    // seen (not granted) at offset 0, so they must not pay out again.
    const shifted = mintCareItems(state, { events }, NOW, { utcOffsetMinutes: 120 })
    expect(inventoryOf(shifted).food).toBe(ITEM_DAILY_CAP.food)
    expect(shifted.mints.filter((mint) => mint.item === 'food')).toHaveLength(6)
    expect(shifted.granted.food).toBe(ITEM_DAILY_CAP.food)
  })
})

describe('a device with a broken clock must not pin every device', () => {
  it('ignores a feed timestamp a year in the future', () => {
    const ahead: CareState = {
      ...createCareState(ago(30)),
      lastFedAt: new Date(NOW.getTime() + 365 * DAY).toISOString(),
      lastRewardAt: new Date(NOW.getTime() + 365 * DAY).toISOString(),
    }
    const behind: CareState = { ...createCareState(ago(30)), lastFedAt: ago(20) }
    const merged = mergeCareState(ahead, behind)
    const signals = deriveCareSignals({ events: [] }, NOW)

    // The future record is still stored (it is not ours to delete), but it is
    // not believed: hunger decays from the real feed, not from 2027.
    expect(merged.lastFedAt).toBe(ahead.lastFedAt)
    expect(deriveNeeds(merged, signals, NOW).hunger).toBe(0)
    expect(deriveMood({ needs: deriveNeeds(merged, signals, NOW), dormant: false, now: NOW })).not.toBe(
      'excited',
    )
    expect(isDormant(deriveNeeds(merged, signals, NOW), merged, NOW)).toBe(false)
  })
})

describe('validation', () => {
  it('rejects an unknown key on a mint record', () => {
    const state = {
      ...createCareState(ago(1)),
      mints: [{ id: 'x', item: 'food', at: ago(1), granted: true, bonus: 999 }],
    }
    expect(() => validateCareState(state)).toThrow()
  })

  it('rejects a state that predates the lifetime counters', () => {
    const { granted: _granted, ...withoutGranted } = createCareState(ago(1))
    expect(() => validateCareState(withoutGranted)).toThrow()
  })
})
