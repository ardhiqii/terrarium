/**
 * The condition layer's persistent state.
 *
 * WHY THIS IS NOT PART OF THE XP LEDGER: `PRODUCT.md` §4.4 splits the game into
 * a progression layer (permanent, monotonic, idempotent) and a condition layer
 * (changes daily, can drop, always recoverable). This file is the whole of the
 * condition layer's stored state, and it deliberately contains no XP, no stage,
 * and no collection entry. Neglect can never lower anything the user earned
 * because none of it is reachable from here.
 *
 * WHAT IS STORED AND WHAT IS NOT:
 * - Stored: care timestamps, the item mint log, and what has been spent. Those
 *   are facts about what the user did, and they cannot be recomputed.
 * - Not stored: needs, mood, and inventory. Those are derived on read
 *   (`needs.ts`, `mood.ts`), because a stored need is a need that can go stale,
 *   drift between devices, or be edited into a lie.
 *
 * The shape is plain JSON with no nested objects beyond flat records, so it
 * cross the sync boundary unchanged and needs no opaque-id treatment: there is
 * no repository name, note title, or other user text anywhere in it.
 */

import type { EventLedger } from '../events'
import {
  MAX_MINT_RECORDS,
  ITEM_DAILY_CAP,
  ITEM_INVENTORY_MAX,
  planItemGrants,
  toyGrantFor,
} from './items'
import { localDay, type CareAnchors } from './needs'
import { CARE_ITEM_KINDS, type CareItemKind } from './scene'

/**
 * One grant the companion's ledger has been read for.
 *
 * `granted` distinguishes "this went into the cupboard" from "the cupboard was
 * full, so this meal was eaten at the table". Keeping the second kind is what
 * stops a full cupboard from turning into an invisible backlog: without it, a
 * user who earned forty meals while full could draw them down one at a time and
 * hunger would stop meaning anything.
 */
export interface CareMint {
  readonly id: string
  readonly item: CareItemKind
  readonly at: string
  readonly granted: boolean
}

export interface CareState {
  /** When care tracking began. The floor for every decay, and for dormancy. */
  readonly startedAt: string
  readonly updatedAt: string
  readonly lastFedAt: string | null
  readonly lastPlayedAt: string | null
  readonly lastCleanedAt: string | null
  readonly lastHealedAt: string | null
  readonly lastRestedAt: string | null
  readonly lastPettedAt: string | null
  /** When the last mood-lifting action or reward landed. Drives `excited`. */
  readonly lastRewardAt: string | null
  /** Newest last. Bounded by `MAX_MINT_RECORDS`. */
  readonly mints: readonly CareMint[]
  /**
   * Lifetime items granted, per kind. Monotonic, and NOT derivable from `mints`:
   * the log is bounded, so counting its records would make a long-playing user's
   * cupboard empty itself when old grants are pruned. `granted − spent` is the
   * inventory.
   */
  readonly granted: Readonly<Record<CareItemKind, number>>
  /** Lifetime count of items used, per kind. Items are consumed, never refunded. */
  readonly spent: Readonly<Record<CareItemKind, number>>
}

/** A zeroed spend record, so a fresh state is the same shape as a merged one. */
export function emptySpent(): Record<CareItemKind, number> {
  return { food: 0, treat: 0, medicine: 0, toy: 0, soap: 0 }
}

export function createCareState(now: string): CareState {
  return {
    startedAt: now,
    updatedAt: now,
    lastFedAt: null,
    lastPlayedAt: null,
    lastCleanedAt: null,
    lastHealedAt: null,
    lastRestedAt: null,
    lastPettedAt: null,
    lastRewardAt: null,
    mints: [],
    granted: emptySpent(),
    spent: emptySpent(),
  }
}

/** The timestamp view `needs.ts` works from. */
export function careAnchors(state: CareState): CareAnchors {
  return {
    startedAt: state.startedAt,
    lastFedAt: state.lastFedAt,
    lastCleanedAt: state.lastCleanedAt,
    lastHealedAt: state.lastHealedAt,
    lastRestedAt: state.lastRestedAt,
  }
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(max, Math.max(0, value))
}

/**
 * What is in the cupboard right now.
 *
 * `granted − spent`, clamped to the per-item maximum. Never negative: a spend
 * that a merge could not account for (see `mergeCareState`) shows as an empty
 * shelf, not as a debt.
 *
 * WHY THE LIFETIME COUNTER AND NOT THE LOG: `mints` is bounded, so counting its
 * records loses every granted item as soon as the log fills — a user near the
 * bound saw their cupboard drop to zero on the next page load. The counter is
 * monotonic and survives pruning; the log is only there to deduplicate.
 */
export function inventoryOf(state: CareState): Record<CareItemKind, number> {
  const inventory = emptySpent()
  for (const item of CARE_ITEM_KINDS) {
    inventory[item] = clamp(
      (state.granted[item] ?? 0) - (state.spent[item] ?? 0),
      ITEM_INVENTORY_MAX[item],
    )
  }
  return inventory
}

/**
 * The retained mint log: chronological, bounded, deterministic.
 *
 * WHY CHRONOLOGICAL AND WHY THIS IS A SEPARATE STEP: the log used to be appended
 * in scan order and truncated by position. Because a full cupboard appends
 * `granted:false` records after the real grants, truncation evicted exactly the
 * records that had produced items — the cupboard emptied itself. Ordering by
 * grant time before truncation makes the retained set depend only on the ledger,
 * not on the order a client happened to scan it in, which is also what lets
 * `mintCareItems` recognise a state it has already produced.
 */
function retainedMints(candidates: Iterable<CareMint>): CareMint[] {
  const ordered = [...candidates].sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  )
  if (ordered.length <= MAX_MINT_RECORDS) return ordered
  return ordered.slice(ordered.length - MAX_MINT_RECORDS)
}

function sameMints(left: readonly CareMint[], right: readonly CareMint[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].id !== right[index].id ||
      left[index].granted !== right[index].granted ||
      left[index].item !== right[index].item
    ) {
      return false
    }
  }
  return true
}

/**
 * Turn newly observed ledger activity into items.
 *
 * Idempotent by construction: a grant whose id is already in the log is
 * skipped, so a re-scan, a reload, or a replayed snapshot mints nothing. The
 * second scan is the case that matters — every page load re-reads the whole
 * cumulative ledger, not just the new events — and it must return the SAME
 * object, because the House persists whenever the minted state changes identity.
 * A non-idempotent mint is a save/render loop, not a cosmetic bug.
 *
 * The daily cap is enforced HERE, not only in the planner: the planner buckets a
 * grant by the viewer's local day, and a timezone change re-buckets it. Counting
 * what is already committed to a day is what keeps "four meals a day" true across
 * a DST shift or a flight.
 */
export function mintCareItems(
  state: CareState,
  ledger: EventLedger,
  now: Date,
  options: { readonly utcOffsetMinutes?: number; readonly today?: string } = {},
): CareState {
  const offset = options.utcOffsetMinutes ?? 0
  const grants = planItemGrants(ledger, { utcOffsetMinutes: offset })

  // The daily toy is the one item the ledger cannot describe: opening the app is
  // the event. It goes through the same log, so it deduplicates by local day.
  const today = options.today ?? localToday(now, offset)
  const toy = toyGrantFor(today, now)
  const planned = toy ? [...grants, toy] : grants

  const existing = new Map(state.mints.map((mint) => [mint.id, mint]))
  const candidates = new Map(existing)
  for (const grant of planned) {
    if (!candidates.has(grant.id)) {
      candidates.set(grant.id, { id: grant.id, item: grant.item, at: grant.at, granted: false })
    }
  }

  // Drop the oldest BEFORE deciding what to grant. A grant that does not survive
  // retention must not increment the lifetime counter, or every reload would
  // hand the user a phantom meal from a record that was never kept.
  const retained = retainedMints(candidates.values())

  const inventory = inventoryOf(state)
  const granted = { ...state.granted }
  const perDay = new Map<string, number>()
  for (const mint of state.mints) {
    const day = localDay(mint.at, offset)
    if (day === null) continue
    const bucket = `${mint.item}:${day}`
    perDay.set(bucket, (perDay.get(bucket) ?? 0) + 1)
  }

  let changed = false
  const next: CareMint[] = retained.map((mint) => {
    const known = existing.get(mint.id)
    if (known) return known
    changed = true

    const day = localDay(mint.at, offset) ?? ''
    const bucket = `${mint.item}:${day}`
    const used = perDay.get(bucket) ?? 0
    perDay.set(bucket, used + 1)

    const withinCap = used < ITEM_DAILY_CAP[mint.item]
    const hasRoom = inventory[mint.item] < ITEM_INVENTORY_MAX[mint.item]
    const didGrant = withinCap && hasRoom
    if (didGrant) {
      inventory[mint.item] += 1
      granted[mint.item] = (granted[mint.item] ?? 0) + 1
    }
    return { ...mint, granted: didGrant }
  })

  // A candidate that was retained away is not a change: it was never kept, and
  // re-planning it on the next read must not report a difference either.
  if (!changed && sameMints(state.mints, next)) return state
  return { ...state, updatedAt: now.toISOString(), mints: next, granted }
}

/** The viewer's local day, used for the daily-login toy. */
function localToday(now: Date, utcOffsetMinutes: number): string {
  return new Date(now.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/**
 * Spend one item.
 *
 * The caller has already checked that the item is in the cupboard; this only
 * records the cost. Kept separate from the action that spends it so the same
 * accounting serves `feed`, `play`, `clean` and `heal` without four copies.
 */
export function spendItem(state: CareState, item: CareItemKind, now: Date): CareState {
  return {
    ...state,
    updatedAt: now.toISOString(),
    spent: { ...state.spent, [item]: (state.spent[item] ?? 0) + 1 },
  }
}

function laterOf(left: string | null, right: string | null): string | null {
  if (left === null) return right
  if (right === null) return left
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (!Number.isFinite(leftMs)) return right
  if (!Number.isFinite(rightMs)) return left
  return leftMs >= rightMs ? left : right
}

/**
 * Merge two devices' condition state.
 *
 * THE RULE IS "NEWEST TIMESTAMP WINS PER NEED", not "take the newer state".
 * Taking the newer state whole would let a device that had never been fed
 * overwrite a week of care simply because it synced last. Each timestamp is
 * merged on its own, so a feed on the laptop and a rest on the phone both
 * survive.
 *
 * `spent` merges by maximum, not by sum. Summing would charge a spend twice
 * when one device's snapshot already contained the other's; taking the max can
 * hand back one item when both devices spent at the same instant. Items are
 * cosmetic and hunger is recoverable, so the second error is the harmless one,
 * and it always resolves in the user's favour rather than inventing a debt.
 */
export function mergeCareState(left: CareState, right: CareState): CareState {
  const byId = new Map<string, CareMint>()
  for (const mint of [...left.mints, ...right.mints]) {
    const existing = byId.get(mint.id)
    // A grant recorded on either side counts as granted: the device that had
    // room is not wrong, and dropping it would silently eat an earned item.
    if (!existing || (!existing.granted && mint.granted)) byId.set(mint.id, mint)
  }
  const mints = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))

  const spent = emptySpent()
  const granted = emptySpent()
  for (const item of CARE_ITEM_KINDS) {
    spent[item] = Math.max(left.spent[item] ?? 0, right.spent[item] ?? 0)
    // Granted is monotonic on each device, so the max is the truth about how
    // many items were ever earned. Summing would double-count grants that both
    // snapshots already contained.
    granted[item] = Math.max(left.granted[item] ?? 0, right.granted[item] ?? 0)
  }

  return {
    startedAt: earliestStart(left, right),
    updatedAt: laterOf(left.updatedAt, right.updatedAt) ?? left.updatedAt,
    lastFedAt: laterOf(left.lastFedAt, right.lastFedAt),
    lastPlayedAt: laterOf(left.lastPlayedAt, right.lastPlayedAt),
    lastCleanedAt: laterOf(left.lastCleanedAt, right.lastCleanedAt),
    lastHealedAt: laterOf(left.lastHealedAt, right.lastHealedAt),
    lastRestedAt: laterOf(left.lastRestedAt, right.lastRestedAt),
    lastPettedAt: laterOf(left.lastPettedAt, right.lastPettedAt),
    lastRewardAt: laterOf(left.lastRewardAt, right.lastRewardAt),
    mints: retainedMints(mints),
    granted,
    spent,
  }
}

/**
 * `startedAt` takes the EARLIER value on merge, unlike every other timestamp.
 *
 * It is not an event; it is the floor of every decay curve. Taking the later of
 * two would make a companion that was merged from two devices look younger than
 * it is, which refills every need for free. This is the one place where "newest
 * wins" is exactly wrong, and it is worth the second rule to say so.
 */
export function earliestStart(left: CareState, right: CareState): string {
  const leftMs = Date.parse(left.startedAt)
  const rightMs = Date.parse(right.startedAt)
  if (!Number.isFinite(leftMs)) return right.startedAt
  if (!Number.isFinite(rightMs)) return left.startedAt
  return leftMs <= rightMs ? left.startedAt : right.startedAt
}

const CARE_KEYS = [
  'startedAt',
  'updatedAt',
  'lastFedAt',
  'lastPlayedAt',
  'lastCleanedAt',
  'lastHealedAt',
  'lastRestedAt',
  'lastPettedAt',
  'lastRewardAt',
  'mints',
  'granted',
  'spent',
] as const

const MINT_KEYS = ['id', 'item', 'at', 'granted'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertTimestamp(
  value: unknown,
  field: string,
  nullable: boolean,
): void {
  if (value === null) {
    if (!nullable) throw new TypeError(`${field} must be a timestamp`)
    return
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a timestamp or null`)
  }
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be a timestamp`)
}

/**
 * Validate condition state read from storage or from a synced snapshot.
 *
 * READ-SIDE, NOT WRITE-SIDE ONLY: the profile lives in `localStorage` and the
 * snapshot crosses the network, so an inventory of 999 or a mint with an
 * unknown item has to be refused here. A permissive validator would let a
 * hand-edited profile set `spent` to -5 and refill the cupboard forever.
 */
export function validateCareState(value: unknown): asserts value is CareState {
  if (!isRecord(value)) throw new TypeError('care must be an object')
  const unknown = Object.keys(value).filter(
    (key) => !(CARE_KEYS as readonly string[]).includes(key),
  )
  if (unknown.length > 0) throw new TypeError(`care has unknown field(s): ${unknown.join(', ')}`)
  const missing = CARE_KEYS.filter((key) => !(key in value))
  if (missing.length > 0) throw new TypeError(`care is missing field(s): ${missing.join(', ')}`)

  assertTimestamp(value.startedAt, 'care.startedAt', false)
  assertTimestamp(value.updatedAt, 'care.updatedAt', false)
  for (const field of [
    'lastFedAt',
    'lastPlayedAt',
    'lastCleanedAt',
    'lastHealedAt',
    'lastRestedAt',
    'lastPettedAt',
    'lastRewardAt',
  ] as const) {
    assertTimestamp(value[field], `care.${field}`, true)
  }

  if (!Array.isArray(value.mints)) throw new TypeError('care.mints must be an array')
  if (value.mints.length > MAX_MINT_RECORDS) throw new TypeError('care.mints is too long')
  const ids = new Set<string>()
  for (const mint of value.mints) {
    if (!isRecord(mint)) throw new TypeError('care.mints entries must be objects')
    // Exact keys, like every other object in this codebase's validators: a mint
    // carrying an extra field is a schema change that has to be noticed, not
    // silently accepted and then dropped on the next write.
    const extra = Object.keys(mint).filter((key) => !(MINT_KEYS as readonly string[]).includes(key))
    if (extra.length > 0) {
      throw new TypeError(`care.mints[] has unknown field(s): ${extra.join(', ')}`)
    }
    if (typeof mint.id !== 'string' || mint.id.trim().length === 0) {
      throw new TypeError('care.mints[].id must be a non-empty string')
    }
    if (!CARE_ITEM_KINDS.includes(mint.item as CareItemKind)) {
      throw new TypeError('care.mints[].item is not a supported item')
    }
    assertTimestamp(mint.at, 'care.mints[].at', false)
    if (typeof mint.granted !== 'boolean') {
      throw new TypeError('care.mints[].granted must be a boolean')
    }
    if (ids.has(mint.id)) throw new TypeError('care.mints contains a duplicate id')
    ids.add(mint.id)
  }

  validateItemCounts(value.granted, 'care.granted')
  validateItemCounts(value.spent, 'care.spent')
}

/**
 * A per-item counter record (granted or spent).
 *
 * Every item must be present, so a state written before a new item kind existed
 * is rejected rather than silently reading as zero and handing out free items.
 */
function validateItemCounts(value: unknown, field: string): void {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  for (const [key, amount] of Object.entries(value)) {
    if (!CARE_ITEM_KINDS.includes(key as CareItemKind)) {
      throw new TypeError(`${field} contains an unsupported item`)
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new TypeError(`${field} values must be finite non-negative numbers`)
    }
    if (!Number.isInteger(amount)) throw new TypeError(`${field} values must be integers`)
  }
  for (const item of CARE_ITEM_KINDS) {
    if (!(item in value)) throw new TypeError(`${field} is missing ${item}`)
  }
}
