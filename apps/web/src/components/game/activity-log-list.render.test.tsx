/**
 * The activity log, rendered.
 *
 * WHY A RENDER TEST AND NOT A SOURCE GREP: every other component test in this repo reads the
 * `.tsx` file as a string and asserts a literal appears in it. That catches a rename and
 * misses a regression — a component that computes the wrong number still contains the right
 * words. This file mounts the component with `renderToStaticMarkup`, which needs no DOM and
 * no browser-only dependency, and asserts what a reader would actually see.
 *
 * The budget meter is the case that matters: it reported a number the ledger never used (0 of
 * 300 on a day that was already spent), and the source-grep tests could not see it.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type NormalizedEvent } from '@/lib/game/events'
import { ActivityLogList } from './ActivityLogList'

const SCAN_DAY = '2026-10-01'

function note(index: number, occurredAt = `${SCAN_DAY}T09:00:00.000Z`): NormalizedEvent {
  return {
    eventId: asEventId(`note-${index}`),
    companionId: asCompanionId('pikachu-family'),
    source: 'mounted-markdown',
    sourceId: 'vault-1',
    provenance: 'local',
    category: 'new-note',
    occurredAt,
    cap: { key: `mounted-markdown:${SCAN_DAY}:new-note`, limit: 20 },
  }
}

function render(events: NormalizedEvent[]): string {
  // React escapes the apostrophe in "Today's" as an entity; decode what we assert on so the
  // test is about the words a reader sees, not about the serializer's escaping.
  return renderToStaticMarkup(<ActivityLogList ledger={{ events }} />).replaceAll('&#x27;', "'")
}

describe('ActivityLogList', () => {
  it('shows a spent day as the full budget, not as zero', () => {
    // Twelve notes fill 300 XP. Backdated mtimes used to make the meter read 0 / 300 here.
    const backdated = Array.from({ length: 12 }, (_, i) =>
      note(i, `2019-03-${String(1 + i).padStart(2, '0')}T09:00:00.000Z`),
    )

    const html = render(backdated)

    expect(html).toContain("Today's xp budget")
    expect(html).toContain('300 / 300')
  })

  it('hides the meter while the day is far from the ceiling', () => {
    // The honest ceiling for both current sources is 221, so a meter that always shows would
    // be noise. One note is 25 XP.
    const html = render([note(0)])

    expect(html).not.toContain("Today's xp budget")
    expect(html).toContain('+25 xp')
  })

  it('marks a rejected row in words, with the reason, instead of hiding it', () => {
    const spent = Array.from({ length: 12 }, (_, i) => note(i))
    const html = renderToStaticMarkup(
      <ActivityLogList ledger={{ events: [...spent, note(99)] }} limit={20} />,
    ).replaceAll('&#x27;', "'")

    expect(html).toContain('no xp')
    expect(html).toContain("Beyond today's overall xp budget")
    expect(html).toContain('1 entry earned')
  })

  it('states the total it is showing, so the number is attributed', () => {
    const html = render([note(0), note(1)])

    expect(html).toContain('Recorded total')
    expect(html).toContain('50 xp')
  })
})
