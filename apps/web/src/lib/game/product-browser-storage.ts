/**
 * Browser persistence shared by product-source panels.
 *
 * The data stays in localStorage for the prototype. This module has no React
 * or server imports, so the website can keep the local-first rule while a
 * future desktop app replaces this boundary with a local folder/database.
 */

import { addEvents, type EventLedger, type NormalizedEvent } from './events'
import { createEncounterState, type EncounterState } from './encounters'
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

export interface BrowserProductStorage extends GuestProfileStorage {}

function namespacedKey(key: string, namespace?: string): string {
  return namespace ? `${key}:${namespace}` : key
}

export function browserProductStorage(): BrowserProductStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  }
}

export function loadBrowserLedger(storage: BrowserProductStorage, namespace?: string): EventLedger {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(namespacedKey(LEDGER_KEY, namespace)) ?? '{"events":[]}')
    if (!parsed || typeof parsed !== 'object' || !('events' in parsed) || !Array.isArray(parsed.events)) {
      return { events: [] }
    }
    return addEvents({ events: [] }, parsed.events as NormalizedEvent[])
  } catch {
    return { events: [] }
  }
}

export function saveBrowserLedger(storage: BrowserProductStorage, ledger: EventLedger, namespace?: string): void {
  storage.setItem(namespacedKey(LEDGER_KEY, namespace), JSON.stringify(ledger))
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
