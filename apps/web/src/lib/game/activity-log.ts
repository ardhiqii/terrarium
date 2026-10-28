/**
 * The activity log: what each companion actually earned, from what, when.
 *
 * WHY THIS IS A READ MODEL, NOT A NEW STORE: the ledger already records
 * `companionId` and `occurredAt` per event, so "Gengar earned 25 xp from a
 * merged pull request in repo A" is already derivable. Nothing here writes.
 *
 * WHY IT SHOWS EVENTS THAT COUNTED ZERO: a log that only lists accepted events
 * cannot explain a quiet day. The user sees no entries and assumes the feature
 * is broken, when the real cause is a daily cap. So the log lists every event
 * and marks the ones a cap rejected, with the reason. An audit trail that hides
 * its own exclusions is not an audit trail.
 *
 * CONTENT RULE: this module reads only category, occurredAt, source, sourceId,
 * provenance, and the small display metadata bag. It never reads note text,
 * note titles, file paths, or repository contents. `activity-log.test.ts`
 * asserts that.
 */

import {
  XP_BY_EVENT_CATEGORY,
  acceptedLedgerEvents,
  explainLedgerAcceptance,
  type CompanionId,
  type EventCategory,
  type EventLedger,
  type NormalizedEvent,
  type SourceKind,
} from './events'

/** User-facing copy for a category. Follows DESIGN.md §6 (no em-dashes). */
export const CATEGORY_LABEL: Readonly<Record<EventCategory, string>> = {
  'qualifying-active-day': 'Active day',
  'work-session': 'Work session',
  'new-note': 'New note',
  'new-words': 'New writing',
  'resolved-wikilink': 'Resolved wikilink',
  'merged-pull-request': 'Merged pull request',
  'published-release': 'Published release',
  'closed-linked-issue': 'Closed linked issue',
  'successful-ci': 'Green build',
  // A local content event, named here only because this map is exhaustive over EventCategory.
  // It appears in the activity log so a maturity change is visible, not because it is rewarded.
  'maturity-changed': 'Maturity changed',
}

export interface ActivityLogEntry {
  readonly eventId: string
  readonly companionId: CompanionId
  /** ISO timestamp of the activity itself, not of the sync. */
  readonly occurredAt: string
  readonly category: EventCategory
  /** User-facing description of the activity. */
  readonly label: string
  readonly source: SourceKind
  /** Where it came from, e.g. "ardhiqii/terrarium" or a mounted folder name. */
  readonly sourceLabel: string
  readonly provenance: 'local' | 'verified'
  /** XP awarded, or 0 when a cap rejected the event. */
  readonly xp: number
  /** False when the event exists but a daily cap did not accept it. */
  readonly counted: boolean
  /** Why it earned nothing. Present only when `counted` is false. */
  readonly skipReason?: string
}

export interface ActivityLog {
  readonly entries: readonly ActivityLogEntry[]
  /** Sum of the XP actually counted, for the filtered companion, all time. */
  readonly totalXp: number
  /**
   * XP accepted for the newest event's day, across every companion and source.
   *
   * This, not `totalXp`, is what the daily budget meter must show: the budget is
   * one day wide and global, while `totalXp` is a lifetime for one companion.
   */
  readonly dayXp: number
  /** The day `dayXp` belongs to, or null when there is nothing to show. */
  readonly day: string | null
  /** How many entries were listed but earned nothing. */
  readonly skippedCount: number
}

export interface ActivityLogOptions {
  /** Restrict to one companion. Omit for the whole ledger. */
  readonly companionId?: CompanionId | string
}

function sourceLabelFor(event: NormalizedEvent): string {
  // A repository name is an identifier the user already sees on GitHub, not
  // content: it says where the work happened, not what the work said.
  const repositoryName = event.metadata?.repositoryName
  if (typeof repositoryName === 'string' && repositoryName.trim()) {
    return repositoryName.trim()
  }

  switch (event.source) {
    case 'github':
      // No repository name recorded (an event minted before the field
      // existed). Name the account rather than inventing a repository.
      return event.sourceId.trim() || 'GitHub'
    case 'mounted-markdown':
      return event.sourceId.trim() || 'Mounted folder'
    case 'built-in-editor':
      return 'Built-in editor'
  }
}

/**
 * Builds the log newest-first. Events that survived every cap earn their
 * category's XP; the rest are listed with 0 and the reason they did not.
 *
 * The reason comes from the ledger itself rather than being assumed, because
 * there are now two distinguishable ways an event earns nothing: it lost its
 * own source's daily cap, or it was fine but the day's global budget was already
 * spent. Telling a user "beyond the daily limit for this source" when the real
 * cause was the budget would be a lie about how their own economy works.
 */
export function resolveActivityLog(
  ledger: EventLedger,
  options: ActivityLogOptions = {},
): ActivityLog {
  const { accepted, rejected } = explainLedgerAcceptance(ledger)
  const acceptedIds = new Set(accepted.map((event) => event.eventId))

  // Deduplicate the same way the ledger does, so a replayed delivery does not
  // appear twice in the log: first write wins.
  const canonical = new Map<string, NormalizedEvent>()
  for (const event of ledger.events) {
    if (!canonical.has(event.eventId)) canonical.set(event.eventId, event)
  }

  const wanted = options.companionId === undefined ? null : String(options.companionId)

  const entries: ActivityLogEntry[] = []
  for (const event of canonical.values()) {
    if (wanted !== null && String(event.companionId) !== wanted) continue

    const counted = acceptedIds.has(event.eventId)
    const xp = counted ? XP_BY_EVENT_CATEGORY[event.category] : 0
    const reason = rejected.get(event.eventId)

    entries.push({
      eventId: event.eventId,
      companionId: event.companionId,
      occurredAt: event.occurredAt,
      category: event.category,
      label: CATEGORY_LABEL[event.category],
      source: event.source,
      sourceLabel: sourceLabelFor(event),
      provenance: event.provenance,
      xp,
      counted,
      ...(counted
        ? {}
        : {
            skipReason:
              reason === 'daily-budget'
                ? "Beyond today's overall xp budget"
                : 'Beyond the daily limit for this source',
          }),
    })
  }

  // Newest first. Tie-break on eventId so the order is total and stable across
  // reloads, the same guarantee the cap ordering makes.
  entries.sort((left, right) => {
    const time = right.occurredAt.localeCompare(left.occurredAt)
    if (time !== 0) return time
    return left.eventId.localeCompare(right.eventId)
  })

  const totalXp = entries.reduce((sum, entry) => sum + entry.xp, 0)

  // What the DAY has spent, for the budget meter. Deliberately not `totalXp`:
  // that is this companion's entire history, while the budget is one day across
  // every companion. Rendering the lifetime total against a daily budget showed
  // "1,800 / 250" for a busy companion and made the label a false statement.
  // The day is the newest event's day, which is the day a live session is in.
  const newestDay = entries.length > 0 ? entries[0].occurredAt.slice(0, 10) : null
  const dayXp = newestDay === null
    ? 0
    : acceptedLedgerEvents(ledger).reduce((sum, event) => {
        if (event.occurredAt.slice(0, 10) !== newestDay) return sum
        return sum + (XP_BY_EVENT_CATEGORY[event.category] ?? 0)
      }, 0)

  return {
    entries,
    totalXp,
    dayXp,
    day: newestDay,
    skippedCount: entries.filter((entry) => !entry.counted).length,
  }
}

/**
 * Groups the log by companion, so a collection view can show "who earned what"
 * without re-reading the ledger per companion.
 */
export function groupActivityLogByCompanion(
  ledger: EventLedger,
): ReadonlyMap<CompanionId, ActivityLog> {
  const ids = new Set<CompanionId>()
  for (const event of ledger.events) ids.add(event.companionId)

  const grouped = new Map<CompanionId, ActivityLog>()
  for (const id of ids) {
    grouped.set(id, resolveActivityLog(ledger, { companionId: id }))
  }
  return grouped
}
