'use client'

import { useEffect, useRef, useState } from 'react'
import { ProductActivityPanel } from './ProductActivityPanel'
import {
  addEvents,
  type EventLedger,
  type NormalizedEvent,
} from '@/lib/game/events'
import {
  createEncounterState,
  type EncounterState,
  type EncounterSignals,
} from '@/lib/game/encounters'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import {
  createProductState,
  applyProductEvents,
  type ProductState,
} from '@/lib/game/product-state'
import {
  loadGuestProfile,
  saveGuestProfile,
  type GuestProfile,
} from '@/lib/game/guest-profile'
import { normalizeMarkdownEvents, type MarkdownFileSnapshot } from '@/lib/game/markdown-events'

const LEDGER_KEY = 'digital-garden:guest-event-ledger'
const ENCOUNTER_KEY = 'digital-garden:guest-encounters'
const PROFILE_EVENT = 'digital-garden:guest-profile-updated'
const SCAN_EVENT = 'digital-garden:markdown-scan'

interface BrowserStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface MarkdownScanDetail {
  sourceId: string
  files: MarkdownFileSnapshot[]
}

function storage(): BrowserStorage {
  return window.localStorage
}

function loadLedger(): EventLedger {
  try {
    const parsed: unknown = JSON.parse(storage().getItem(LEDGER_KEY) ?? '{"events":[]}')
    if (!parsed || typeof parsed !== 'object' || !('events' in parsed) || !Array.isArray(parsed.events)) {
      return { events: [] }
    }
    return addEvents({ events: [] }, parsed.events as NormalizedEvent[])
  } catch {
    return { events: [] }
  }
}

function saveLedger(ledger: EventLedger): void {
  storage().setItem(LEDGER_KEY, JSON.stringify(ledger))
}

function loadEncounters(): EncounterState {
  try {
    const parsed: unknown = JSON.parse(storage().getItem(ENCOUNTER_KEY) ?? 'null')
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

function saveEncounters(encounters: EncounterState): void {
  storage().setItem(ENCOUNTER_KEY, JSON.stringify(encounters))
}

function currentProfile(): GuestProfile | null {
  try {
    return loadGuestProfile(storage())
  } catch {
    return null
  }
}

function signalsFromFiles(files: readonly MarkdownFileSnapshot[]): EncounterSignals {
  const fileTypes = [
    ...new Set(
      files
        .map((file) => file.path.split('.').pop()?.toLowerCase())
        .filter((value): value is string => Boolean(value)),
    ),
  ]
  return { fileTypes }
}

function recordBaseline(profile: GuestProfile, sourceId: string, files: readonly MarkdownFileSnapshot[]): GuestProfile {
  if (profile.sourceBaselines.some((baseline) => baseline.sourceId === sourceId)) return profile
  const timestamp = new Date().toISOString()
  const size = files.reduce((total, file) => total + file.content.length, 0)
  return {
    ...profile,
    updatedAt: timestamp,
    sourceBaselines: [
      ...profile.sourceBaselines,
      {
        sourceId,
        kind: 'notes',
        fingerprint: `local:${files.length}:${size}`,
        observedAt: timestamp,
        metrics: { noteCount: files.length },
      },
    ],
  }
}

export function GuestProductRuntime() {
  const [state, setState] = useState<ProductState | null>(null)
  const previousScans = useRef(new Map<string, MarkdownFileSnapshot[]>())

  useEffect(() => {
    const profile = currentProfile()
    if (!profile) return
    // Hydrate from browser-local state after the client mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(createProductState(profile, loadLedger(), loadEncounters(), PROTOTYPE_COMPANION_CATALOG))

    const onProfileUpdated = () => {
      const nextProfile = currentProfile()
      if (!nextProfile) return
      setState((current) =>
        createProductState(
          nextProfile,
          current?.ledger ?? loadLedger(),
          current?.encounters ?? loadEncounters(),
          PROTOTYPE_COMPANION_CATALOG,
        ),
      )
    }

    const onScan = (event: Event) => {
      const detail = (event as CustomEvent<MarkdownScanDetail>).detail
      if (!detail || !detail.sourceId || !Array.isArray(detail.files)) return
      const profile = currentProfile()
      if (!profile) return
      const hasPreviousScan = previousScans.current.has(detail.sourceId)
      const previous = previousScans.current.get(detail.sourceId) ?? []
      if (!hasPreviousScan) {
        // The first observation is the source baseline. Existing notes are
        // history for identity/context, not retroactive XP.
        previousScans.current.set(detail.sourceId, detail.files)
        const baselineProfile = recordBaseline(profile, detail.sourceId, detail.files)
        if (baselineProfile !== profile) {
          saveGuestProfile(storage(), baselineProfile)
          window.dispatchEvent(new Event(PROFILE_EVENT))
        }
        setState((current) => current ?? createProductState(baselineProfile, loadLedger(), loadEncounters(), PROTOTYPE_COMPANION_CATALOG))
        return
      }
      const normalized = normalizeMarkdownEvents({
        sourceId: detail.sourceId,
        companionId: profile.activeCompanionId,
        previous,
        current: detail.files,
      })
      previousScans.current.set(detail.sourceId, detail.files)
      if (normalized.length === 0) {
        setState((current) => current ?? createProductState(profile, loadLedger(), loadEncounters(), PROTOTYPE_COMPANION_CATALOG))
        return
      }

      setState((current) => {
        const base = current ?? createProductState(profile, loadLedger(), loadEncounters(), PROTOTYPE_COMPANION_CATALOG)
        const next = applyProductEvents(base, normalized, PROTOTYPE_COMPANION_CATALOG, {
          encounterSignals: signalsFromFiles(detail.files),
          triggerId: `scan:${detail.sourceId}:${normalized.map((item) => item.eventId).join('|')}`,
        })
        saveLedger(next.ledger)
        saveEncounters(next.encounters)
        return next
      })
    }

    window.addEventListener(PROFILE_EVENT, onProfileUpdated)
    window.addEventListener(SCAN_EVENT, onScan)
    return () => {
      window.removeEventListener(PROFILE_EVENT, onProfileUpdated)
      window.removeEventListener(SCAN_EVENT, onScan)
    }
  }, [])

  if (!state) return null
  return <ProductActivityPanel state={state} sourceLabel="Local companion" />
}
