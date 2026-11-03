/**
 * Items: work earns them, the user spends them on the companion.
 *
 * TWO RULES THAT MUST NOT BLUR:
 * 1. Items never give XP, and caring never gives XP. XP stays work-only
 *    (`PRODUCT.md` §5). These are two separate economies that happen to read the
 *    same ledger.
 * 2. An item is minted from a LEDGER EVENT ID, once. Re-syncing, reopening the
 *    page, or replaying a scan cannot mint a second food for the same merged
 *    pull request, for exactly the reason XP cannot be farmed twice: the ledger
 *    already deduplicated that event, and this module mints by `eventId`.
 *
 * THE DAILY CAP IS NOT THE SAME THING AS THE XP CAP. XP's caps decide how much a
 * day pays out. These caps decide how much *food* a day can put in the cupboard,
 * so a user who merges twelve pull requests in one afternoon does not end up
 * with a pantry that makes hunger meaningless for a week. The caps are per item
 * per local day and are applied when the grant is planned, so the plan is
 * deterministic: the same ledger always yields the same grants, in the same
 * order, no matter which device computes it.
 */

import type { EventCategory, EventLedger, NormalizedEvent } from '../events'
import { localDay, parseTimestamp } from './needs'
import type { CareItemKind } from './scene'

/** What one ledger event hands over, or `null` for events that give nothing. */
export function itemForCategory(category: EventCategory): CareItemKind | null {
  switch (category) {
    // A day of work, a shipped change, or a new note is a meal.
    case 'qualifying-active-day':
    case 'merged-pull-request':
    case 'new-note':
      return 'food'
    // A release is a treat: rarer, and it also lifts the mood.
    case 'published-release':
      return 'treat'
    // A green build is medicine. Deliberately NOT conditional on the branch
    // being red: the item is earned by the build, and whether it is *needed*
    // is the heal action's business.
    case 'successful-ci':
      return 'medicine'
    // Closing a linked issue tidies the repository, which is what soap is for.
    case 'closed-linked-issue':
      return 'soap'
    // Words, links and maturity history are activity, not supplies. Notes pay
    // out through `new-note` and the daily active day already.
    default:
      return null
  }
}

/**
 * The most of one item a single local day may mint.
 *
 * Playtest values. Food is generous because it is the action a user reaches for
 * most; treats are one a day because a release is rare and the treat also
 * triggers the excited mood, which stops being special if it is constant.
 */
export const ITEM_DAILY_CAP: Readonly<Record<CareItemKind, number>> = {
  food: 4,
  treat: 1,
  medicine: 2,
  toy: 1,
  soap: 2,
}

/**
 * The most of one item the inventory will hold.
 *
 * This is the anti-hoarding bound from §3.3: a month of not playing must not
 * produce a cupboard that pre-fills the next month. Mints that would exceed it
 * are not recorded at all, so the stored log stays honest about what was
 * actually granted.
 */
export const ITEM_INVENTORY_MAX: Readonly<Record<CareItemKind, number>> = {
  food: 10,
  treat: 3,
  medicine: 3,
  toy: 3,
  soap: 5,
}

/** How many mint records are kept. Older grants are already spent. */
export const MAX_MINT_RECORDS = 400

/** How many daily-login days are remembered. */
export const MAX_TOY_DAYS = 14

/** One planned grant: which item, from which ledger event (or day), when. */
export interface ItemGrant {
  /** Stable id used to deduplicate a mint. A ledger event id, or `toy:<day>`. */
  readonly id: string
  readonly item: CareItemKind
  readonly at: string
  /** The local day the grant is charged to, for the daily cap. */
  readonly day: string
}

export interface PlanGrantsOptions {
  readonly utcOffsetMinutes?: number
}

/**
 * Every grant a ledger is worth, in canonical order.
 *
 * THE DAILY CAP IS NOT APPLIED HERE, and that is deliberate. If the planner
 * silently dropped grants beyond a day's cap, a refused grant would leave no
 * record at all — and since the cap is bucketed by the viewer's local day, a
 * timezone change would then re-plan that same event as a fresh grant on another
 * day. Recording every grant and letting `mintCareItems` mark the surplus as
 * `granted:false` is what makes "four meals a day" survive a flight or a DST
 * shift: the event is known, so it can never pay twice.
 *
 * Ordered by `occurredAt` then `eventId`, so the same ledger always produces the
 * same order and the earliest events win the cap on every device.
 */
export function planItemGrants(
  ledger: EventLedger,
  options: PlanGrantsOptions = {},
): ItemGrant[] {
  const offset = options.utcOffsetMinutes ?? 0
  // VALIDATE BEFORE SORTING. The ledger is restored from browser storage by a
  // loader that only checks that `events` is an array, so one record with a
  // numeric `occurredAt` is reachable — and `localeCompare` on it throws inside
  // the House's render. A malformed record is skipped here rather than allowed
  // to take the page down.
  const usable = (ledger.events as readonly NormalizedEvent[]).filter(
    (event) =>
      typeof event?.occurredAt === 'string' &&
      typeof event?.eventId === 'string' &&
      parseTimestamp(event.occurredAt) !== null,
  )
  const ordered = [...usable].sort((left, right) => {
    const time = left.occurredAt.localeCompare(right.occurredAt)
    return time !== 0 ? time : left.eventId.localeCompare(right.eventId)
  })

  const grants: ItemGrant[] = []

  for (const event of ordered) {
    const item = itemForCategory(event.category)
    if (item === null) continue
    const day = localDay(event.occurredAt, offset)
    if (day === null) continue
    grants.push({ id: event.eventId, item, at: event.occurredAt, day })
  }

  return grants
}

/**
 * The daily-login toy, as a grant.
 *
 * `null` when today's toy was already recorded. The toy is the only item that
 * does not come from the ledger: opening the app is the event, and there is no
 * source to deduplicate against, so the local day itself is the id.
 */
export function toyGrantFor(today: string, now: Date): ItemGrant | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(today)) return null
  return { id: `toy:${today}`, item: 'toy', at: now.toISOString(), day: today }
}

/** A sentence explaining where each item comes from, for the House. */
export const ITEM_SOURCE_COPY: Readonly<Record<CareItemKind, string>> = {
  food: 'One for each active day, merged pull request, and new note',
  treat: 'One for a published release',
  medicine: 'One for a green build',
  toy: 'One a day, just for coming back',
  soap: 'One for each linked issue you close',
}
