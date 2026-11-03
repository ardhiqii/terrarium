/**
 * Re-scanning must not pay twice.
 *
 * The guarantee is structural: every id `normalizeMarkdownEvents` mints is derived from
 * content (a hash), a path, and a bucket index, never from the scan time. Replaying the same
 * transition therefore produces the same ids, and `addEvents` drops the duplicates.
 *
 * WHY THIS IS NOT ALREADY COVERED: `markdown-events.test.ts` proves that an UNCHANGED scan
 * after the summary advanced emits nothing, which is the normal path. The dangerous path is
 * a scan that runs twice from the same memory — the summary failed to persist, a retry
 * fired, a second tab scanned the same folder — and nothing tested it.
 *
 * AND WHY THE CAP TESTS COULD NOT COVER IT: `xp-caps-farming.test.ts` asserts accepted
 * COUNTS against the cap, so an id that started including a timestamp would still be cut
 * back to 3 notes / 10 word-buckets and those assertions would pass. The only thing that
 * catches it is asserting the ids themselves are stable.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_EVENT_LEDGER, acceptedLedgerEvents, addEvents, totalXpOf } from './events'
import { normalizeMarkdownEvents, type MarkdownFileSnapshot } from './markdown-events'
import { summarizeScanFiles } from './scan-summary-store'

const NOW = '2026-10-01T12:00:00.000Z'
const CURRENT: readonly MarkdownFileSnapshot[] = [
  {
    path: 'essay.md',
    content: `# Essay\n\n${'word '.repeat(950)}[[Notes]]`,
    modifiedAt: '2026-10-01T10:00:00.000Z',
  },
  { path: 'Notes.md', content: '# Notes\n\nSome thoughts.\n', modifiedAt: '2026-10-01T10:05:00.000Z' },
]

function scan(previous: readonly MarkdownFileSnapshot[] = [], now = NOW) {
  return normalizeMarkdownEvents({
    sourceId: 'mounted-markdown:vault',
    companionId: 'pikachu-family',
    previous: summarizeScanFiles(previous),
    current: CURRENT,
    now,
  })
}

function acceptedXp(events: ReturnType<typeof scan>): number {
  return totalXpOf(acceptedLedgerEvents({ events }))
}

describe('a repeated scan', () => {
  it('mints the same ids, so the ledger cannot double-pay', () => {
    const first = scan()
    const second = scan()

    expect(second.map((event) => event.eventId)).toEqual(first.map((event) => event.eventId))
    expect(new Set(first.map((event) => event.eventId)).size).toBe(first.length)
  })

  it('adds no XP and no events when the same batch is delivered again', () => {
    const batch = scan()
    const once = addEvents(EMPTY_EVENT_LEDGER, batch)
    const twice = addEvents(once, batch)

    expect(twice.events).toHaveLength(once.events.length)
    expect(acceptedXp(twice.events)).toBe(acceptedXp(once.events))
  })

  it('adds no XP when the scan memory was lost and the folder looks new again', () => {
    // The summary store failing to persist is the realistic version of a double-pay: the
    // next scan sees every file as new. Content-addressed ids still collapse it.
    const first = scan([], NOW)
    const rescanFromEmpty = scan([], '2026-10-01T18:00:00.000Z')
    const ledger = addEvents(addEvents(EMPTY_EVENT_LEDGER, first), rescanFromEmpty)

    expect(ledger.events).toHaveLength(new Set(first.map((event) => event.eventId)).size)
    expect(acceptedXp(ledger.events)).toBe(acceptedXp(first))
  })

  it('is not rescued by the daily cap, which is why the ids are asserted', () => {
    // A scan long enough to fill every cap: a doubling here would still be clipped to the
    // caps, so this only holds because the ids collide.
    const big = Array.from({ length: 40 }, (_, i) => ({
      path: `note-${i}.md`,
      content: `# Note ${i}\n\n${'word '.repeat(300)}`,
      modifiedAt: '2026-10-01T10:00:00.000Z',
    }))
    const normalize = (previous: readonly MarkdownFileSnapshot[], now: string) =>
      normalizeMarkdownEvents({
        sourceId: 'mounted-markdown:vault',
        companionId: 'pikachu-family',
        previous: summarizeScanFiles(previous),
        current: big,
        now,
      })

    const batch = normalize([], NOW)
    const again = normalize([], '2026-10-01T20:00:00.000Z')

    expect(new Set([...batch, ...again].map((event) => event.eventId)).size).toBe(batch.length)
  })
})
