/**
 * Browser persistence shared by product-source panels.
 *
 * The data stays in localStorage for the prototype. This module has no React
 * or server imports, so the website can keep the local-first rule while a
 * future desktop app replaces this boundary with a local folder/database.
 */

import { addEvents, type EventLedger, type NormalizedEvent } from './events'
import { createEncounterState, type EncounterState } from './encounters'
import { canonicalizeProductEvent } from '../sync/product-event-id'
import {
  deserializeProductSnapshot,
  serializeProductSnapshot,
  type ProductSnapshot,
} from '../sync/product-snapshot'
import {
  MAX_RECEIPT_REPAIR_EVENT_IDS,
  PRODUCT_EVENT_ID_PATTERN,
  type StoredReceiptFailure,
} from '../sync/github-receipt-repair'
import {
  mergeSyncRequestUsage,
  parseSyncSchedule,
  pruneSyncRequestUsage,
  type SyncRequestUsageEntry,
  type SyncScheduleInterval,
} from '../sync/sync-schedule'
import {
  createGuestProfile,
  GUEST_PROFILE_STORAGE_KEY,
  loadGuestProfile,
  saveGuestProfile,
  type GuestProfile,
  type GuestProfileStorage,
} from './guest-profile'

const LEDGER_KEY = 'terrarium:guest-event-ledger'
const ENCOUNTER_KEY = 'terrarium:guest-encounters'
const REVEALED_DRAWS_KEY = 'terrarium:guest-revealed-draws'
const VERIFIED_EVENT_PROOFS_KEY = 'terrarium:github-event-proofs'
/**
 * Automatic-sync cadence, stored per browser profile (and per account
 * namespace). A schedule only runs while the website is open, so it is browser
 * state rather than account state: a device with the tab closed must not make
 * the server believe a sync is scheduled.
 */
const SYNC_SCHEDULE_KEY = 'terrarium:github-sync-schedule'
/** Rolling record of the GitHub requests recent syncs actually spent. */
const SYNC_USAGE_KEY = 'terrarium:github-sync-usage'
const SYNC_RECOVERY_KEY = 'terrarium:github-sync-recovery'
const PRODUCT_EVENT_ID = PRODUCT_EVENT_ID_PATTERN

// A browser can expose localStorage but refuse reads/writes (privacy mode,
// blocked third-party storage, quota, or a disabled origin). Keep the local-first
// runtime alive in that case; the in-memory copy is intentionally a best-effort
// session fallback, never a reason to clear or overwrite the durable archive.
const memoryFallback = new Map<string, string>()

export interface BrowserProductStorage extends GuestProfileStorage {}

/**
 * A failed product upload is durable browser state, not a reason to rescan and
 * risk losing the signed checkpoint after a reload. The snapshot remains a
 * derived-only payload and the checkpoint is useful only to the same account
 * namespace; neither value is sent anywhere except the authenticated product
 * route on an explicit retry.
 */
export interface StoredGithubSyncRecovery {
  readonly snapshot: ProductSnapshot
  readonly checkpoint: string | null
  readonly failures: readonly StoredReceiptFailure[]
  readonly blockedEventIds: readonly string[]
  readonly attemptedAt: string
}

function cleanRecoveryFailures(value: unknown): StoredReceiptFailure[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const failures: StoredReceiptFailure[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const eventId = record.eventId
    if (typeof eventId !== 'string' || !PRODUCT_EVENT_ID.test(eventId) || seen.has(eventId)) continue
    const reason = typeof record.reason === 'string' && record.reason.trim().length > 0
      ? record.reason
      : 'receipt-rejected'
    const digest = typeof record.payloadDigest === 'string' && /^[0-9a-f]{16}$/u.test(record.payloadDigest)
      ? record.payloadDigest
      : null
    seen.add(eventId)
    failures.push({ eventId, reason, payloadDigest: digest })
    if (failures.length >= MAX_RECEIPT_REPAIR_EVENT_IDS) break
  }
  return failures
}

function namespacedKey(key: string, namespace?: string): string {
  return namespace ? `${key}:${namespace}` : key
}

export function browserProductStorage(): BrowserProductStorage {
  return {
    getItem: (key) => {
      if (memoryFallback.has(key)) return memoryFallback.get(key) ?? null
      try {
        return typeof window === 'undefined' ? null : window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    setItem: (key, value) => {
      try {
        if (typeof window === 'undefined') throw new Error('localStorage is unavailable')
        window.localStorage.setItem(key, value)
        memoryFallback.delete(key)
      } catch {
        memoryFallback.set(key, value)
      }
    },
    removeItem: (key) => {
      memoryFallback.delete(key)
      try {
        if (typeof window !== 'undefined') window.localStorage.removeItem(key)
      } catch {
        // The in-memory copy was already removed; a blocked durable store is
        // not a reason to make the current page crash.
      }
    },
  }
}

export function loadBrowserLedger(storage: BrowserProductStorage, namespace?: string): EventLedger {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(LEDGER_KEY, namespace)) ?? '{"events":[]}')
    if (!parsed || typeof parsed !== 'object' || !('events' in parsed) || !Array.isArray(parsed.events)) {
      return { events: [] }
    }
    return addEvents({ events: [] }, (parsed.events as NormalizedEvent[]).map(canonicalizeProductEvent))
  } catch {
    return { events: [] }
  }
}

export function saveBrowserLedger(storage: BrowserProductStorage, ledger: EventLedger, namespace?: string): void {
  storage.setItem(namespacedKey(LEDGER_KEY, namespace), JSON.stringify(ledger))
}

/**
 * Receipts must survive a failed cloud upload. GitHub's baseline advances in
 * its own request, so the next retry may not return the same events again.
 * Keep only opaque event IDs and short server receipts in the account-local
 * namespace; source IDs and note content never enter this record.
 */
export function loadVerifiedEventProofs(
  storage: BrowserProductStorage,
  namespace?: string,
): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(VERIFIED_EVENT_PROOFS_KEY, namespace)) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([eventId, proof]) =>
        PRODUCT_EVENT_ID.test(eventId) && typeof proof === 'string' && proof.length > 0 && proof.length <= 128,
      ),
    )
  } catch {
    return {}
  }
}

export function saveVerifiedEventProofs(
  storage: BrowserProductStorage,
  proofs: Readonly<Record<string, string>>,
  eventIds?: readonly string[],
  namespace?: string,
): void {
  const allowed = eventIds ? new Set(eventIds) : null
  const clean = Object.fromEntries(
    Object.entries(proofs).filter(([eventId, proof]) =>
      PRODUCT_EVENT_ID.test(eventId) &&
      (!allowed || allowed.has(eventId)) &&
      typeof proof === 'string' && proof.length > 0 && proof.length <= 128,
    ),
  )
  storage.setItem(namespacedKey(VERIFIED_EVENT_PROOFS_KEY, namespace), JSON.stringify(clean))
}

/** Merge a repair's replacements into the namespace without erasing other
 * receipts that are still needed by the cumulative browser ledger. */
export function mergeVerifiedEventProofs(
  storage: BrowserProductStorage,
  proofs: Readonly<Record<string, string>>,
  namespace?: string,
): void {
  saveVerifiedEventProofs(
    storage,
    { ...loadVerifiedEventProofs(storage, namespace), ...proofs },
    undefined,
    namespace,
  )
}

export function saveGithubSyncRecovery(
  storage: BrowserProductStorage,
  recovery: StoredGithubSyncRecovery,
  namespace?: string,
): void {
  try {
    const serializedSnapshot = serializeProductSnapshot(recovery.snapshot)
    const failures = cleanRecoveryFailures(recovery.failures).slice(0, MAX_RECEIPT_REPAIR_EVENT_IDS)
    const blockedEventIds = [...new Set(recovery.blockedEventIds.filter((eventId) => PRODUCT_EVENT_ID.test(eventId)))]
      .slice(0, MAX_RECEIPT_REPAIR_EVENT_IDS)
    const attemptedAt = new Date(recovery.attemptedAt)
    if (!Number.isFinite(attemptedAt.getTime())) return
    if (recovery.checkpoint !== null && (typeof recovery.checkpoint !== 'string' || recovery.checkpoint.length === 0)) return
    storage.setItem(
      namespacedKey(SYNC_RECOVERY_KEY, namespace),
      JSON.stringify({
        snapshot: JSON.parse(serializedSnapshot),
        checkpoint: recovery.checkpoint,
        failures,
        blockedEventIds,
        attemptedAt: attemptedAt.toISOString(),
      }),
    )
  } catch {
    // Recovery is best effort. The primary local ledger is written separately
    // and is never cleared when a browser quota refuses this diagnostic record.
  }
}

export function loadGithubSyncRecovery(
  storage: BrowserProductStorage,
  namespace?: string,
): StoredGithubSyncRecovery | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(SYNC_RECOVERY_KEY, namespace)) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const snapshotValue = typeof record.snapshot === 'string'
      ? record.snapshot
      : JSON.stringify(record.snapshot)
    const snapshot = deserializeProductSnapshot(snapshotValue)
    if (!snapshot) return null
    const checkpoint = record.checkpoint === null || record.checkpoint === undefined
      ? null
      : typeof record.checkpoint === 'string' && record.checkpoint.length > 0
        ? record.checkpoint
        : null
    if (typeof record.attemptedAt !== 'string' || Number.isNaN(Date.parse(record.attemptedAt))) return null
    const failures = cleanRecoveryFailures(record.failures)
    const blockedEventIds = Array.isArray(record.blockedEventIds)
      ? [...new Set(record.blockedEventIds.filter((eventId): eventId is string =>
          typeof eventId === 'string' && PRODUCT_EVENT_ID.test(eventId),
        ))].slice(0, MAX_RECEIPT_REPAIR_EVENT_IDS)
      : []
    return {
      snapshot,
      checkpoint,
      failures,
      blockedEventIds,
      attemptedAt: new Date(record.attemptedAt).toISOString(),
    }
  } catch {
    return null
  }
}

export function clearGithubSyncRecovery(
  storage: BrowserProductStorage,
  namespace?: string,
): void {
  try {
    storage.removeItem(namespacedKey(SYNC_RECOVERY_KEY, namespace))
  } catch {
    // Best effort; retaining recovery is safer than claiming it was cleared.
  }
}

export function loadBrowserEncounters(storage: BrowserProductStorage, namespace?: string): EncounterState {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(ENCOUNTER_KEY, namespace)) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return createEncounterState()
    const value = parsed as Partial<EncounterState>
    if (
      typeof value.meter !== 'number' ||
      typeof value.totalProgress !== 'number' ||
      typeof value.nextSequence !== 'number' ||
      !Array.isArray(value.draws) ||
      !Array.isArray(value.processedTriggerIds) ||
      !value.essenceByFamily ||
      typeof value.essenceByFamily !== 'object'
    ) return createEncounterState()
    return value as EncounterState
  } catch {
    return createEncounterState()
  }
}

export function saveBrowserEncounters(storage: BrowserProductStorage, encounters: EncounterState, namespace?: string): void {
  storage.setItem(namespacedKey(ENCOUNTER_KEY, namespace), JSON.stringify(encounters))
}

export function loadRevealedDraws(storage: BrowserProductStorage, namespace?: string): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(REVEALED_DRAWS_KEY, namespace)) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

export function saveRevealedDraws(storage: BrowserProductStorage, ids: readonly string[], namespace?: string): void {
  storage.setItem(namespacedKey(REVEALED_DRAWS_KEY, namespace), JSON.stringify(ids))
}

/** Stored automatic-sync cadence and the last attempt time. */
export interface StoredSyncSchedule {
  readonly interval: SyncScheduleInterval
  /** Epoch milliseconds of the last sync attempt, so a reload keeps the cadence. */
  readonly lastAttemptAt: number | null
}

export const DEFAULT_STORED_SYNC_SCHEDULE: StoredSyncSchedule = {
  interval: parseSyncSchedule(null),
  lastAttemptAt: null,
}

/**
 * Stored automatic-sync cadence; falls back to the documented 15-minute
 * default. A reload keeps the previous attempt time, so reopening the page does
 * not turn the cadence into "sync on every page load".
 */
export function loadSyncScheduleState(
  storage: BrowserProductStorage,
  namespace?: string,
): StoredSyncSchedule {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(SYNC_SCHEDULE_KEY, namespace)) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return DEFAULT_STORED_SYNC_SCHEDULE
    const record = parsed as { interval?: unknown; lastAttemptAt?: unknown }
    const lastAttemptAt = typeof record.lastAttemptAt === 'number' && Number.isFinite(record.lastAttemptAt)
      ? record.lastAttemptAt
      : null
    return { interval: parseSyncSchedule(record.interval), lastAttemptAt }
  } catch {
    return DEFAULT_STORED_SYNC_SCHEDULE
  }
}

export function saveSyncScheduleState(
  storage: BrowserProductStorage,
  state: StoredSyncSchedule,
  namespace?: string,
): void {
  try {
    storage.setItem(
      namespacedKey(SYNC_SCHEDULE_KEY, namespace),
      JSON.stringify({
        interval: parseSyncSchedule(state.interval),
        lastAttemptAt: state.lastAttemptAt,
        savedAt: new Date().toISOString(),
      }),
    )
  } catch {
    // Browser storage can refuse a write (private mode, quota). The cadence
    // lives in memory for this session, and this call sits inside a sync's
    // `finally` block: throwing here would strand the panel in a busy state.
  }
}

/**
 * Recent sync request costs, newest last.
 *
 * Only counts and timestamps are kept; no repository or activity detail ever
 * enters this record.
 */
export function loadSyncRequestUsage(
  storage: BrowserProductStorage,
  namespace?: string,
  now: number = Date.now(),
): SyncRequestUsageEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(SYNC_USAGE_KEY, namespace)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return pruneSyncRequestUsage(
      parsed.filter((entry): entry is SyncRequestUsageEntry =>
        typeof entry === 'object' && entry !== null &&
        typeof (entry as SyncRequestUsageEntry).at === 'number' &&
        typeof (entry as SyncRequestUsageEntry).requests === 'number',
      ),
      now,
    )
  } catch {
    return []
  }
}

/**
 * Record one sync's cost, merging whatever another tab already wrote.
 *
 * Two tabs share this storage, so writing the in-memory list whole would erase
 * the other tab's spend and the account's real hourly total would be
 * undercounted. Union first, then persist; a refused write still returns the
 * merged record so the caller's in-memory accounting stays correct.
 */
export function saveSyncRequestUsage(
  storage: BrowserProductStorage,
  entries: readonly SyncRequestUsageEntry[],
  namespace?: string,
  now: number = Date.now(),
): SyncRequestUsageEntry[] {
  let merged = pruneSyncRequestUsage(mergeSyncRequestUsage(entries), now)
  try {
    merged = pruneSyncRequestUsage(
      mergeSyncRequestUsage(loadSyncRequestUsage(storage, namespace, now), entries),
      now,
    )
    storage.setItem(namespacedKey(SYNC_USAGE_KEY, namespace), JSON.stringify(merged))
  } catch {
    // Best effort: the caller keeps the in-memory record.
  }
  return merged
}

export function ensureBrowserGuestProfile(
  storage: BrowserProductStorage,
  starterCompanionId: string,
  namespace?: string,
): GuestProfile {
  const profileKey = namespace ? namespacedKey(GUEST_PROFILE_STORAGE_KEY, namespace) : undefined
  const existing = loadGuestProfile(storage, profileKey)
  if (existing) return existing
  const now = new Date().toISOString()
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const profile = createGuestProfile({
    guestId: `guest-${randomId}`,
    starterCompanionId,
    now,
  })
  saveGuestProfile(storage, profile, profileKey)
  return profile
}
