import { describe, expect, it } from 'vitest'
import { XP_BY_EVENT_CATEGORY } from './events'
import { normalizeMarkdownEvents } from './markdown-events'
import {
  InMemoryScanSummaryStore,
  SCAN_SUMMARY_STORAGE_KEY,
  loadScanSummaries,
  summarizeScanFiles,
  summaryMaturity,
  type MarkdownFileSummary,
} from './scan-summary-store'

/**
 * Maturity used to have no history.
 *
 * `xp.ts` says it plainly: promotion XP is "derived from the current maturity snapshot rather than
 * a historical event log, since nothing in this codebase records WHEN a note changed maturity,
 * only what it is now." The scan's persisted memory (`MarkdownFileSummary`) had no maturity field,
 * so the diff could not answer "did this change" and the app recomputed from the snapshot instead.
 * A downgrade therefore erased its own XP with no record it was ever awarded.
 *
 * These tests pin the history, and just as importantly pin the things that must NOT fire: a first
 * scan, and a summary written before the field existed.
 */
const companionId = 'pikachu-default'
/** The trusted clock. Deliberately different from every file's mtime, below. */
const now = '2026-08-28T12:00:00.000Z'
/** User-settable, and months before the scan: exactly the value a history must not trust. */
const mtime = '2026-01-01T00:00:00.000Z'

function note(maturity?: string, body = 'body words here'): string {
  const front = maturity === undefined ? `---\ntags: [x]\n---\n` : `---\nmaturity: ${maturity}\n---\n`
  return `${front}${body}`
}

/** The previous side as a real stored summary would be built. */
function previousWith(content: string, path = 'n.md'): MarkdownFileSummary[] {
  return summarizeScanFiles([{ path, content, modifiedAt: mtime }])
}

function scan(previous: MarkdownFileSummary[], content: string) {
  return normalizeMarkdownEvents({
    sourceId: 'vault:main',
    companionId,
    previous,
    current: [{ path: 'n.md', content, modifiedAt: mtime }],
    now,
  })
}

function changes(events: ReturnType<typeof normalizeMarkdownEvents>) {
  return events.filter((event) => event.category === 'maturity-changed')
}

describe('maturity history', () => {
  it('records a change, dated from the trusted clock and not the file mtime', () => {
    const found = changes(scan(previousWith(note('seedling')), note('budding')))
    expect(found).toHaveLength(1)
    expect(found[0].occurredAt).toBe(now)
    expect(found[0].occurredAt).not.toBe(mtime)
    expect(found[0].metadata).toMatchObject({ path: 'n.md', from: 'seedling', to: 'budding' })
    // This event carries NO cap: `budgetDayOf` falls back to `occurredAt` for a cap-free event,
    // so a cap here would not help and a forged mtime would have hurt.
    expect(found[0].cap).toBeUndefined()
    expect(found[0].provenance).toBe('local')
  })

  it('records a DOWNGRADE, which is the case that used to erase XP silently', () => {
    const found = changes(scan(previousWith(note('evergreen')), note('seedling')))
    expect(found).toHaveLength(1)
    expect(found[0].metadata).toMatchObject({ from: 'evergreen', to: 'seedling' })
  })

  it('pays nothing: history first, XP unchanged (option A)', () => {
    expect(XP_BY_EVENT_CATEGORY['maturity-changed']).toBe(0)
  })

  it('emits nothing for a first scan, whatever the starting maturity', () => {
    // A brand-new note's frontmatter is the user's STARTING state, not a change from anything.
    // Getting this wrong would award a promotion for every note in the vault on first contact.
    for (const maturity of ['seedling', 'budding', 'evergreen', undefined]) {
      const events = normalizeMarkdownEvents({
        sourceId: 'vault:main',
        companionId,
        previous: [],
        current: [{ path: 'n.md', content: note(maturity), modifiedAt: mtime }],
        now,
      })
      expect(changes(events), `first scan starting at ${maturity}`).toHaveLength(0)
    }
  })

  it('emits nothing when the stored summary predates the field', () => {
    // Exactly what localStorage holds after upgrading: a valid summary with no maturity. Treating
    // that absence as `seedling` would emit a change for every already-evergreen note.
    const legacy: MarkdownFileSummary[] = [
      { path: 'n.md', hash: 'deadbeef', words: 3, links: 0, linkTargets: [], modifiedAt: mtime },
    ]
    expect(legacy[0].maturity).toBeUndefined()
    expect(changes(scan(legacy, note('evergreen')))).toHaveLength(0)
  })

  it('is idempotent when the same transition is replayed', () => {
    const previous = previousWith(note('seedling'))
    const current = note('budding')
    const first = changes(scan(previous, current))
    const again = changes(scan(previous, current))
    expect(first).toHaveLength(1)
    expect(again[0].eventId).toBe(first[0].eventId)
  })

  it('keeps a repeated transition, so this is a history and not a set', () => {
    // seedling -> budding -> seedling -> budding. Both budding promotions are real events. An ID
    // keyed only on the target value (or on from+to) would collapse the second into the first.
    const a = note('seedling')
    const b = note('budding')
    const back = note('seedling', 'body words here changed')

    const firstBudding = changes(scan(previousWith(a), b))
    const toSeedling = changes(scan(previousWith(b), back))
    const secondBudding = changes(scan(previousWith(back), b))

    expect(firstBudding).toHaveLength(1)
    expect(toSeedling).toHaveLength(1)
    expect(secondBudding).toHaveLength(1)
    expect(secondBudding[0].eventId).not.toBe(firstBudding[0].eventId)
  })

  it('loads a legacy stored summary instead of discarding it', () => {
    // THE FAILURE THAT ACTUALLY HURTS is not a missing promotion, it is a DROPPED summary:
    // `loadScanSummaries` returning {} re-baselines the vault, so the next scan sees every note
    // as new and re-awards `new-note` for all of them. A summary without maturity must load,
    // with maturity simply absent.
    const store = new InMemoryScanSummaryStore()
    store.setItem(
      SCAN_SUMMARY_STORAGE_KEY,
      JSON.stringify({
        'vault:main': {
          sourceId: 'vault:main',
          observedAt: now,
          files: [
            { path: 'n.md', hash: 'deadbeef', words: 3, links: 0, linkTargets: [], modifiedAt: mtime },
          ],
        },
      }),
    )

    const loaded = loadScanSummaries(store)
    expect(Object.keys(loaded)).toEqual(['vault:main'])
    expect(loaded['vault:main'].files).toHaveLength(1)
    expect(loaded['vault:main'].files[0].maturity).toBeUndefined()

    // And a summary written now carries the field, so the NEXT scan can compare.
    const fresh = summarizeScanFiles([{ path: 'n.md', content: note('evergreen'), modifiedAt: mtime }])
    expect(fresh[0].maturity).toBe('evergreen')
  })

  it('ignores a garbage maturity value without dropping the summary', () => {
    const store = new InMemoryScanSummaryStore()
    store.setItem(
      SCAN_SUMMARY_STORAGE_KEY,
      JSON.stringify({
        s: {
          sourceId: 's',
          observedAt: now,
          files: [{ path: 'n.md', hash: 'aa', words: 1, links: 0, linkTargets: [], modifiedAt: mtime, maturity: 'ripe' }],
        },
      }),
    )
    const loaded = loadScanSummaries(store)
    expect(Object.keys(loaded)).toEqual(['s'])
    expect(loaded.s.files[0].maturity).toBeUndefined()
  })

  it('agrees with the summary store about what a maturity value is', () => {
    // The helper is duplicated on purpose (same reason `hash` and `wordCount` are). If the two
    // ever disagree, the diff compares two different questions and changes fire or vanish at
    // random, so they are pinned together here.
    const cases = [
      note('seedling'),
      note('budding'),
      note('evergreen'),
      note(undefined),
      note('Evergreen'),
      note('  "budding"  '),
      note('bogus'),
      'no frontmatter at all',
    ]
    for (const content of cases) {
      const viaSummary = summaryMaturity(content)
      const found = changes(scan(previousWith(note('seedling')), content))
      if (viaSummary === 'seedling') {
        expect(found, `"${content.slice(0, 24)}" must not count as a change from seedling`).toHaveLength(0)
      } else {
        expect(found?.[0]?.metadata?.to, `"${content.slice(0, 24)}"`).toBe(viaSummary)
      }
    }
  })
})
