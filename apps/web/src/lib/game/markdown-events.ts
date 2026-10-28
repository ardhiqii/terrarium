/**
 * Turns two local Markdown scans into normalized, local-provenance events.
 * Contents are inspected in memory and never included in an event payload.
 *
 * THE `previous` SIDE IS A SUMMARY, NOT THE FILES. It used to be full snapshots
 * with content, which made the scan memory impossible to persist (a second copy
 * of the vault) and so lived in a `useRef` that a page reload threw away. The
 * delta a scan needs is only "did this path exist" and "is the content the same",
 * both answerable from a hash plus a word count. So the memory is
 * `MarkdownFileSummary` (see `scan-summary-store.ts`), and this function cannot
 * read an old note's text even in principle.
 */
import { asCompanionId, makeEventId, type CompanionId, type EventCap, type NormalizedEvent } from './events'
import type { MarkdownFileSummary } from './scan-summary-store'
import type { Maturity } from './types'

export interface MarkdownFileSnapshot {
  path: string
  content: string
  modifiedAt: string
}

export interface MarkdownEventInput {
  sourceId: string
  companionId: CompanionId | string
  /** What the folder looked like last time, as summaries. Empty for a new folder. */
  previous: readonly MarkdownFileSummary[]
  current: readonly MarkdownFileSnapshot[]
  /**
   * When the scan ran, from the trusted clock.
   *
   * WHY THIS IS REQUIRED AND NOT DERIVED: daily caps must be bucketed by a day
   * the user cannot choose. File modification time is user-settable (`touch -t`,
   * archive extraction, a crafted mount), so bucketing the cap by mtime let one
   * scan spread its work across 365 buckets and earn a year of allowance at
   * once. The scan time is the one input here that comes from the clock rather
   * than from the files being measured.
   */
  now: string
}

function normalizePath(value: string): string {
  const path = value.trim().replaceAll('\\', '/')
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new TypeError(`Invalid Markdown path: ${value}`)
  }
  return path
}

function iso(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`Invalid Markdown timestamp: ${value}`)
  return parsed.toISOString()
}

function wordCount(content: string): number {
  return content
    .replace(/^---[\s\S]*?---\s*/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length
}

/**
 * The note's maturity from its own frontmatter, absent meaning `seedling`.
 *
 * Deliberately duplicated from `summaryMaturity` in `scan-summary-store.ts`, exactly as `hash`
 * and `wordCount` are: this module produces events, that one decides what survives a reload,
 * and sharing a helper would couple the two for no gain. The two MUST agree -- the diff here
 * compares this value against the stored summary's -- so a test pins them together.
 */
function maturityOf(content: string): Maturity {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)
  if (!front) return 'seedling'
  const line = /^maturity:\s*(.+)$/imu.exec(front[1])
  if (!line) return 'seedling'
  const value = line[1].trim().replace(/^["']|["']$/gu, '').toLowerCase()
  return value === 'budding' || value === 'evergreen' ? value : 'seedling'
}

function links(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/gu)]
    .map((match) => match[1].trim().toLowerCase())
    .filter(Boolean)
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16)
}

/**
 * Cap keys are the day and the category ONLY.
 *
 * WHY THE sourceId IS GONE: it was `mounted-markdown:<folder name>:<day>:<cat>`,
 * which made the allowance per FOLDER. Copying a vault, or renaming the folder
 * (which changes the name, and so the id), minted a whole fresh allowance for
 * identical content: ten copies of one folder measured 1,200 xp in a day
 * against a 166 xp ceiling. A folder name is not an identity, so it cannot be
 * what bounds a budget.
 *
 * The consequence is deliberate: every mounted folder shares one daily budget.
 * Writing honestly across two vaults is rarer than duplicating a vault to farm,
 * and the alternative (an unbounded allowance per folder) has no ceiling at all.
 * The prefix stays so note caps stay disjoint from GitHub's `github:` keys.
 */
function capKey(day: string, category: string): string {
  return `mounted-markdown:${day}:${category}`
}

function activityCap(
  day: string,
  category: 'qualifying-active-day' | 'work-session',
): EventCap {
  return {
    key: capKey(day, category),
    limit: category === 'work-session' ? 2 : 1,
  }
}

/**
 * How much CONTENT may be paid for in one day, across every mounted folder.
 *
 * WHY THIS EXISTS: before these caps, only the two activity categories were
 * bounded. `new-note`, `new-words`, and `resolved-wikilink` were not, so the
 * note source paid without limit while the GitHub source was capped at 30
 * xp/day. That is the exact farming the event model exists to prevent.
 *
 * Values are playtest values, same caveat as the XP rates in `events.ts`.
 */
export const CONTENT_DAILY_LIMITS = {
  /**
   * A person writes a handful of genuinely new notes in a day. Note this is
   * keyed to net-new CONTENT, not to a path, so renaming a file cannot re-earn
   * the bonus (see the `new-note` emit).
   */
  'new-note': 3,
  /**
   * 1,000 words is 10 buckets at 5 xp.
   *
   * Raised from 500 after review: 500 credited a 1,500-word session at a third
   * of its volume, and pushed the `long_form` achievement (10,000 words) out to
   * 20 days of maxed writing. 1,000 words is a substantial session, so an honest
   * long-form day is paid close to in full while padding is still bounded.
   */
  'new-words': 10,
  /** Densely interlinked new notes might resolve a couple of dozen links. */
  'resolved-wikilink': 12,
} as const

type CappedContentCategory = keyof typeof CONTENT_DAILY_LIMITS

function contentCap(day: string, category: CappedContentCategory): EventCap {
  return {
    key: capKey(day, category),
    limit: CONTENT_DAILY_LIMITS[category],
  }
}

/**
 * The DAY a cap buckets by, always from the trusted clock.
 *
 * Never from `file.modifiedAt`: that value is the user's to set, and bucketing
 * by it let a single scan claim a year of allowance.
 */
function clockDay(now: string): string {
  return new Date(now).toISOString().slice(0, 10)
}


function event(
  input: MarkdownEventInput,
  nativeId: string,
  category: NormalizedEvent['category'],
  occurredAt: string,
  metadata?: Readonly<Record<string, string | number | boolean>>,
  eventCap?: EventCap,
): NormalizedEvent {
  return {
    eventId: makeEventId('mounted-markdown', input.sourceId, nativeId),
    companionId: asCompanionId(input.companionId),
    source: 'mounted-markdown',
    sourceId: input.sourceId,
    provenance: 'local',
    category,
    occurredAt,
    ...(eventCap ? { cap: eventCap } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

/** Normalize a scan transition. The first scan should use an empty previous list only for a new folder. */
export function normalizeMarkdownEvents(input: MarkdownEventInput): readonly NormalizedEvent[] {
  const sourceId = input.sourceId.trim()
  if (!sourceId) throw new TypeError('sourceId must be a non-empty string')
  const now = iso(input.now)
  const normalizedInput = { ...input, sourceId, now, companionId: asCompanionId(input.companionId) }
  const before = new Map(input.previous.map((file) => [normalizePath(file.path), file]))
  const after = new Map(
    input.current.map((file) => [normalizePath(file.path), { ...file, modifiedAt: iso(file.modifiedAt) }]),
  )
  const events: NormalizedEvent[] = []
  const activity: Array<{ id: string; occurredAt: string }> = []
  // One scan is one day for cap purposes, from the clock rather than from any
  // file's own timestamp.
  const day = clockDay(normalizedInput.now)

  for (const [path, file] of after) {
    const previous = before.get(path)
    const revision = hash(file.content)
    // Change detection now compares hashes rather than raw text: the stored
    // memory has no text to compare against, which is the point.
    const changed = !previous || previous.hash !== revision
    if (!changed) continue

    // `new-note` is identified by CONTENT, not by path, so moving or renaming a
    // file does not re-earn the bonus for the same note. Renaming is a real
    // action in this app (`GardenSource.rename` moves bytes and nothing else),
    // and before this it paid again: one file renamed 41 times banked 41
    // new-note events.
    if (!previous) {
      events.push(
        event(
          normalizedInput,
          `new-note:${revision}`,
          'new-note',
          file.modifiedAt,
          { path },
          contentCap(day, 'new-note'),
        ),
      )
    }

    // Maturity, compared only between two OBSERVED values. `previous.maturity` is undefined for a
    // summary written before this field existed, and treating that as `seedling` would emit a
    // change for every already-evergreen note on the first scan after deploying. A brand-new note
    // is skipped by the same check: its frontmatter value is the user's STARTING state, not a
    // change from anything.
    if (previous?.maturity) {
      const next = maturityOf(file.content)
      if (next !== previous.maturity) {
        events.push(
          event(
            normalizedInput,
            // Both sides of the transition are in the ID: the previous content hash and the new
            // one. The target value alone is not enough. A note can move seedling -> budding ->
            // seedling -> budding, and the two budding promotions are separate events; keying by
            // `to` (or by `from`+`to`) would give them the same ID and first-write-wins would
            // silently swallow the second, turning a history into a set. Replaying the SAME
            // transition still yields the same ID, which is what makes it idempotent.
            `maturity:${path}:${previous.hash}:${revision}:${next}`,
            'maturity-changed',
            // The TRUSTED CLOCK, not `file.modifiedAt`.
            //
            // Every other content event in this module dates itself from the file's mtime, and
            // this one deliberately does not. An mtime is user-settable (`touch -t`, archive
            // extraction), and this event carries NO cap -- which matters twice: `budgetDayOf`
            // in `events.ts` falls back to `occurredAt` for a cap-free event, so a forged mtime
            // would inject a forged day into the daily budget; and an auditable history is
            // worthless if the timestamps are chosen by the thing being audited. The honest
            // answer to "when did this note change maturity" is "when the app first observed it",
            // which is exactly what `now` is.
            normalizedInput.now,
            { path, from: previous.maturity, to: next },
            // Deliberately uncapped: this is history, not a reward. Capping it would silently drop
            // transitions, and no amount of writing can farm a maturity change.
          ),
        )
      }
    }

    const oldWords = previous ? previous.words : 0
    const newWords = wordCount(file.content)
    const additionalBuckets = Math.max(0, Math.floor((newWords - oldWords) / 100))
    for (let bucket = 1; bucket <= additionalBuckets; bucket += 1) {
      events.push(
        event(
          normalizedInput,
          `words:${path}:${revision}:${bucket}`,
          'new-words',
          file.modifiedAt,
          { bucket },
          contentCap(day, 'new-words'),
        ),
      )
    }

    const oldLinks = new Set(previous ? previous.linkTargets : [])
    const knownTitles = new Set([...after.keys()].map((item) => item.replace(/\.(?:md|mdx)$/iu, '').split('/').pop()!.toLowerCase()))
    for (const target of [...new Set(links(file.content))]) {
      if (!oldLinks.has(target) && knownTitles.has(target)) {
        events.push(
          event(
            normalizedInput,
            `wikilink:${path}:${target}`,
            'resolved-wikilink',
            file.modifiedAt,
            { path },
            contentCap(day, 'resolved-wikilink'),
          ),
        )
      }
    }

    activity.push({ id: `file:${path}:${revision}`, occurredAt: file.modifiedAt })
  }

  // Activity buckets by the trusted day too, so the day it reports is the day
  // the caps charged it to.
  const items = activity
  if (items.length > 0) {
    const ordered = [...items].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
    events.push(
      event(
        normalizedInput,
        `active-day:${day}`,
        'qualifying-active-day',
        ordered[0].occurredAt,
        { activityCount: items.length },
        activityCap(day, 'qualifying-active-day'),
      ),
    )
    const sessions = new Map<number, typeof items>()
    for (const item of items) {
      // Session bucketing keeps the file's own time: a session is about when
      // work happened, and the activity cap already bounds the day.
      const minutes = new Date(item.occurredAt).getUTCHours() * 60 + new Date(item.occurredAt).getUTCMinutes()
      const bucket = Math.floor(minutes / 120)
      const current = sessions.get(bucket) ?? []
      current.push(item)
      sessions.set(bucket, current)
    }
    for (const [bucket, session] of sessions) {
      const first = [...session].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))[0]
      events.push(
        event(
          normalizedInput,
          `work-session:${day}:${bucket}`,
          'work-session',
          first.occurredAt,
          { activityCount: session.length },
          activityCap(day, 'work-session'),
        ),
      )
    }
  }

  return events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId))
}
