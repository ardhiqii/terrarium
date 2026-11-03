import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type NormalizedEvent } from '../events'
import {
  deriveCareSignals,
  deriveNeeds,
  isDormant,
  hungerFrom,
  energyFrom,
  dietFrom,
  healthFrom,
  cleanlinessFrom,
  streakLength,
  localDay,
  type CareAnchors,
  type CareSignals,
} from './needs'
import { createCareState } from './state'

/**
 * Needs math is the part of the living companion most likely to be wrong in a
 * way nobody notices: a meter that reads 70 instead of 65 still looks like a
 * meter. These tests pin the boundaries (0 and 100), the clock going backwards,
 * and the case that matters most in production — a profile that has never been
 * fed.
 */

const NOW = new Date('2026-11-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function isoDaysAgo(days: number, from: Date = NOW): string {
  return new Date(from.getTime() - days * DAY).toISOString()
}

function emptySignals(overrides: Partial<CareSignals> = {}): CareSignals {
  return {
    activityDays: [],
    lateNightDays: [],
    categoriesInWindow: [],
    lastActivityAt: null,
    lastQualifyingActiveDayAt: null,
    lastWorkSessionAt: null,
    lastNoteAt: null,
    ciStatus: 'unknown',
    ciSince: null,
    staleOwnPrDays: null,
    staleSince: null,
    today: '2026-11-03',
    ...overrides,
  }
}

function anchors(overrides: Partial<CareAnchors> = {}): CareAnchors {
  return {
    // Tracking began well before the fixtures, so the floor never competes with
    // the timestamps each test is actually about.
    startedAt: isoDaysAgo(60),
    lastFedAt: null,
    lastCleanedAt: null,
    lastHealedAt: null,
    lastRestedAt: null,
    ...overrides,
  }
}

function event(
  category: NormalizedEvent['category'],
  occurredAt: string,
  id = `${category}-${occurredAt}`,
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

describe('hunger', () => {
  it('is full on the day it was fed', () => {
    expect(hungerFrom(anchors({ lastFedAt: isoDaysAgo(0) }), emptySignals(), NOW)).toBe(100)
  })

  it('loses 25 points a day, exactly', () => {
    expect(hungerFrom(anchors({ lastFedAt: isoDaysAgo(1) }), emptySignals(), NOW)).toBe(75)
    expect(hungerFrom(anchors({ lastFedAt: isoDaysAgo(2) }), emptySignals(), NOW)).toBe(50)
    expect(hungerFrom(anchors({ lastFedAt: isoDaysAgo(4) }), emptySignals(), NOW)).toBe(0)
  })

  it('never goes below zero, however long the neglect', () => {
    expect(hungerFrom(anchors({ lastFedAt: isoDaysAgo(400) }), emptySignals(), NOW)).toBe(0)
  })

  it('counts a busy week as feeding, so shipping is not punished', () => {
    const signals = emptySignals({ lastQualifyingActiveDayAt: isoDaysAgo(1) })
    expect(hungerFrom(anchors({ lastFedAt: null }), signals, NOW)).toBe(75)
  })

  it('does not refill when the clock is set ahead', () => {
    // A device a week ahead writes a feed timestamp in the future. Believing it
    // would pin hunger at 100 on every device it syncs to, so a timestamp more
    // than a few minutes ahead is ignored and the previous anchor applies.
    const future = new Date(NOW.getTime() + 5 * DAY).toISOString()
    expect(hungerFrom(anchors({ lastFedAt: future }), emptySignals(), NOW)).toBe(0)
  })

  it('falls back to the start of tracking when it has never been fed', () => {
    // A brand-new companion is not starving because it has no feed timestamp.
    expect(hungerFrom(anchors({ startedAt: isoDaysAgo(0) }), emptySignals(), NOW)).toBe(100)
    expect(hungerFrom(anchors({ startedAt: isoDaysAgo(3) }), emptySignals(), NOW)).toBe(25)
  })

  it('survives a corrupt timestamp without NaN', () => {
    // A feed record that cannot be parsed is ignored, so hunger falls back to
    // the start of tracking rather than to a `NaN` that would blank the meter.
    const value = hungerFrom(anchors({ lastFedAt: 'not-a-date' }), emptySignals(), NOW)
    expect(Number.isNaN(value)).toBe(false)
    expect(value).toBe(0)
  })
})

describe('energy', () => {
  it('is full with no late nights and a short streak', () => {
    expect(energyFrom(anchors(), emptySignals({ activityDays: ['2026-11-02', '2026-11-03'] }), NOW)).toBe(100)
  })

  it('loses ten points per late night in the window', () => {
    expect(
      energyFrom(
        anchors(),
        emptySignals({ activityDays: ['2026-11-01', '2026-11-02', '2026-11-03'], lateNightDays: ['2026-11-01', '2026-11-02'] }),
        NOW,
      ),
    ).toBe(80)
  })

  it('loses five points per consecutive day past five', () => {
    const week = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']
    // Six consecutive days: one day past five.
    expect(energyFrom(anchors(), emptySignals({ activityDays: week }), NOW)).toBe(95)
  })

  it('never goes below zero', () => {
    const days = Array.from({ length: 20 }, (_, index) =>
      new Date(NOW.getTime() - (index + 1) * DAY).toISOString().slice(0, 10),
    )
    expect(
      energyFrom(anchors(), emptySignals({ activityDays: days, lateNightDays: days }), NOW),
    ).toBe(0)
  })

  it('a rest day resets the counts instead of just the value', () => {
    const signals = emptySignals({
      activityDays: ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
      lateNightDays: ['2026-10-28', '2026-10-29'],
    })
    const beforeRest = energyFrom(anchors(), signals, NOW)
    const afterRest = energyFrom(anchors({ lastRestedAt: isoDaysAgo(0) }), signals, NOW)
    expect(beforeRest).toBeLessThan(100)
    expect(afterRest).toBe(100)
  })
})

describe('diet', () => {
  it('is zero with no activity', () => {
    expect(dietFrom(emptySignals())).toBe(0)
  })

  it('gives a quarter per distinct category and caps at four', () => {
    expect(dietFrom(emptySignals({ categoriesInWindow: ['new-note'] }))).toBe(25)
    expect(dietFrom(emptySignals({ categoriesInWindow: ['new-note', 'new-words'] }))).toBe(50)
    expect(
      dietFrom(
        emptySignals({
          categoriesInWindow: ['new-note', 'new-words', 'merged-pull-request', 'successful-ci'],
        }),
      ),
    ).toBe(100)
    expect(
      dietFrom(
        emptySignals({
          categoriesInWindow: [
            'new-note',
            'new-words',
            'merged-pull-request',
            'successful-ci',
            'published-release',
            'work-session',
          ],
        }),
      ),
    ).toBe(100)
  })
})

describe('health and cleanliness are unmeasured, not perfect', () => {
  it('reports null when CI status is unknown', () => {
    expect(healthFrom(anchors(), emptySignals())).toBeNull()
  })

  it('reports null when no stale-PR producer exists', () => {
    expect(cleanlinessFrom(anchors(), emptySignals())).toBeNull()
  })

  it('drops to 40 on a red build and heals back to 100 after medicine', () => {
    const red = emptySignals({ ciStatus: 'red', ciSince: isoDaysAgo(1) })
    expect(healthFrom(anchors(), red)).toBe(40)
    expect(healthFrom(anchors({ lastHealedAt: isoDaysAgo(0) }), red)).toBe(100)
    // A heal from before the build went red does not count.
    expect(healthFrom(anchors({ lastHealedAt: isoDaysAgo(3) }), red)).toBe(40)
  })

  it('loses five cleanliness points per stale day and clears after a clean', () => {
    const stale = emptySignals({ staleOwnPrDays: 6, staleSince: isoDaysAgo(6) })
    expect(cleanlinessFrom(anchors(), stale)).toBe(70)
    expect(cleanlinessFrom(anchors({ lastCleanedAt: isoDaysAgo(0) }), stale)).toBe(100)
  })
})

describe('dormancy', () => {
  it('needs every measured need at zero and a week since the last meal', () => {
    const starving = { hunger: 0, energy: 0, health: null, cleanliness: null, diet: 0 }
    expect(isDormant(starving, anchors({ lastFedAt: isoDaysAgo(8) }), NOW)).toBe(true)
    // Six days is not a week.
    expect(isDormant(starving, anchors({ lastFedAt: isoDaysAgo(6) }), NOW)).toBe(false)
    // One need still alive keeps it awake.
    expect(
      isDormant({ ...starving, energy: 40 }, anchors({ lastFedAt: isoDaysAgo(8) }), NOW),
    ).toBe(false)
  })

  it('is never dormant while its only needs are unmeasured', () => {
    const unknown = { hunger: 0, energy: 0, health: null, cleanliness: null, diet: 0 }
    expect(isDormant(unknown, anchors({ startedAt: isoDaysAgo(1), lastFedAt: null }), NOW)).toBe(false)
  })
})

describe('signals from the ledger', () => {
  it('separates a late-night session from a daytime one in local time', () => {
    // 23:30 Jakarta (UTC+7) is 16:30 UTC: late night only if the offset is used.
    const ledger = {
      events: [event('work-session', '2026-11-02T16:30:00.000Z')],
    }
    const local = deriveCareSignals(ledger, NOW, { utcOffsetMinutes: 7 * 60 })
    expect(local.lateNightDays).toEqual(['2026-11-02'])

    const utc = deriveCareSignals(ledger, NOW, { utcOffsetMinutes: 0 })
    expect(utc.lateNightDays).toEqual([])
  })

  it('ignores malformed timestamps instead of throwing', () => {
    const ledger = { events: [event('new-note', 'not-a-date')] }
    const signals = deriveCareSignals(ledger, NOW)
    expect(signals.activityDays).toEqual([])
    expect(signals.lastActivityAt).toBeNull()
  })

  it('keeps categories inside the window only', () => {
    const ledger = {
      events: [
        event('new-note', isoDaysAgo(2)),
        event('merged-pull-request', isoDaysAgo(30)),
      ],
    }
    const signals = deriveCareSignals(ledger, NOW)
    expect(signals.categoriesInWindow).toEqual(['new-note'])
  })

  it('discards a CI observation older than the freshness window', () => {
    const signals = deriveCareSignals({ events: [] }, NOW, {
      ci: { status: 'red', since: isoDaysAgo(30) },
    })
    expect(signals.ciStatus).toBe('unknown')
  })
})

describe('streak', () => {
  it('counts back from today', () => {
    expect(streakLength(['2026-11-01', '2026-11-02', '2026-11-03'], '2026-11-03')).toBe(3)
  })

  it('counts back from yesterday so the streak is not broken at midnight', () => {
    expect(streakLength(['2026-11-01', '2026-11-02'], '2026-11-03')).toBe(2)
  })

  it('stops at a gap', () => {
    expect(streakLength(['2026-10-30', '2026-11-02', '2026-11-03'], '2026-11-03')).toBe(2)
  })

  it('is zero with no history', () => {
    expect(streakLength([], '2026-11-03')).toBe(0)
  })
})

describe('localDay', () => {
  it('rolls over at the viewer midnight, not UTC', () => {
    const timestamp = '2026-11-02T18:30:00.000Z'
    expect(localDay(timestamp, 0)).toBe('2026-11-02')
    expect(localDay(timestamp, 7 * 60)).toBe('2026-11-03')
  })
})

describe('deriveNeeds', () => {
  it('produces every key, with null for the unmeasured ones', () => {
    const needs = deriveNeeds(
      anchors({ lastFedAt: isoDaysAgo(1) }),
      emptySignals({ categoriesInWindow: ['new-note'] }),
      NOW,
    )
    expect(needs).toEqual({
      hunger: 75,
      energy: 100,
      health: null,
      cleanliness: null,
      diet: 25,
    })
  })

  it('reads a fresh care state identically on two devices', () => {
    const state = createCareState(NOW.toISOString())
    const signals = emptySignals()
    const first = deriveNeeds(anchorsFrom(state), signals, NOW)
    const second = deriveNeeds(anchorsFrom(state), signals, NOW)
    expect(first).toEqual(second)
  })
})

function anchorsFrom(state: ReturnType<typeof createCareState>): CareAnchors {
  return {
    startedAt: state.startedAt,
    lastFedAt: state.lastFedAt,
    lastCleanedAt: state.lastCleanedAt,
    lastHealedAt: state.lastHealedAt,
    lastRestedAt: state.lastRestedAt,
  }
}
