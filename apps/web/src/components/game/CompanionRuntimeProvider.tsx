'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  addEvents,
  type EventLedger,
  type NormalizedEvent,
} from '@/lib/game/events'
import {
  createEncounterState,
  mergeEncounterStates,
  type EncounterSignals,
  type EncounterState,
} from '@/lib/game/encounters'
import {
  PROTOTYPE_COMPANION_CATALOG,
  selectStarterCompanionId,
} from '@/lib/game/companion-catalog'
import {
  applyProductEvents,
  createProductState,
  switchActiveCompanion,
  type ProductState,
} from '@/lib/game/product-state'
import {
  migrateLegacyCreature,
  type LegacyCreatureInput,
} from '@/lib/game/companion-migration'
import {
  GUEST_PROFILE_STORAGE_KEY,
  loadGuestProfile,
  saveGuestProfile,
  type GuestProfile,
  type GuestProfileStorage,
} from '@/lib/game/guest-profile'
import {
  browserProductStorage,
  ensureBrowserGuestProfile,
  loadBrowserEncounters,
  loadBrowserLedger,
  loadMarkdownKnownPaths,
  loadRevealedDraws,
  rememberMarkdownPaths,
  saveBrowserEncounters,
  saveBrowserLedger,
  saveRevealedDraws,
} from '@/lib/game/product-browser-storage'
import {
  normalizeMarkdownEvents,
  type MarkdownFileSnapshot,
  type MarkdownRenameHint,
} from '@/lib/game/markdown-events'
import { canonicalizeProductEvent } from '@/lib/sync/product-event-id'

export const COMPANION_STATE_EVENT = 'terrarium:companion-state-updated'
export const COMPANION_PROFILE_EVENT = 'terrarium:guest-profile-updated'
export const COMPANION_SCAN_EVENT = 'terrarium:markdown-scan'

const LEGACY_SCAN_EVENT = 'digital-garden:markdown-scan'
const LEGACY_LEDGER_KEY = 'digital-garden:guest-event-ledger'
const LEGACY_ENCOUNTER_KEY = 'digital-garden:guest-encounters'

type RuntimeStatus = 'loading' | 'ready' | 'storage-unavailable' | 'error'

export interface CompanionRuntimeContextValue {
  state: ProductState | null
  status: RuntimeStatus
  storageMode: 'durable' | 'memory'
  /** True only when this runtime had to create the first profile this visit. */
  isFreshProfile: boolean
  revealedDraws: readonly string[]
  refresh: () => void
  switchCompanion: (companionId: string) => void
  migrateLegacy: (input: LegacyCreatureInput) => void
  dismissDraw: (drawId: string) => void
}

export interface CompanionRuntimeProviderProps {
  children: ReactNode
  /** Server-provided account state can seed a client roster without a flash. */
  initialState?: ProductState | null
  /** Account namespace, when the caller owns an isolated browser profile. */
  namespace?: string
  /** Do not load or persist guest storage when the caller owns state authority. */
  ownsInitialState?: boolean
  /** Keep authoritative account state in memory instead of copying it to guest storage. */
  persistLocal?: boolean
}

const RuntimeContext = createContext<CompanionRuntimeContextValue | null>(null)

interface MarkdownScanDetail {
  sourceId: string
  files: MarkdownFileSnapshot[]
  renameHints?: MarkdownRenameHint[]
}

function profileKey(namespace?: string): string {
  return namespace ? `${GUEST_PROFILE_STORAGE_KEY}:${namespace}` : GUEST_PROFILE_STORAGE_KEY
}

const RUNTIME_STORAGE_KEYS = [
  GUEST_PROFILE_STORAGE_KEY,
  'terrarium:guest-event-ledger',
  'terrarium:guest-encounters',
  'terrarium:guest-revealed-draws',
] as const

/**
 * Runtime notifications are intentionally namespaced. A guest notification
 * has no namespace detail for backwards compatibility; an account runtime
 * must never treat that notification as an instruction to read guest state.
 */
export function companionRuntimeEventMatchesNamespace(event: Event, namespace?: string): boolean {
  const detail: unknown = (event as CustomEvent<unknown>).detail
  if (!detail || typeof detail !== 'object' || Array.isArray(detail) || !('namespace' in detail)) {
    return namespace === undefined
  }
  return (detail as { namespace?: unknown }).namespace === (namespace ?? null)
}

function companionRuntimeStorageKeyMatchesNamespace(key: string | null, namespace?: string): boolean {
  if (key === null) return true
  return RUNTIME_STORAGE_KEYS.some((baseKey) => key === (namespace ? `${baseKey}:${namespace}` : baseKey))
}

/**
 * Merge a browser account copy without letting one tab erase references,
 * baselines, or migration credits another tab already recorded. The profile
 * with the newer update timestamp supplies scalar fields such as active
 * selection; additive collections are retained from both copies.
 */
function mergeAccountProfilesForPersistence(next: GuestProfile, stored: GuestProfile): GuestProfile {
  if (next.guestId !== stored.guestId) return next
  const references = new Map<string, GuestProfile['collection'][number]>()
  for (const reference of stored.collection) references.set(reference.referenceId, reference)
  for (const reference of next.collection) references.set(reference.referenceId, reference)
  const baselines = new Map<string, GuestProfile['sourceBaselines'][number]>()
  for (const baseline of stored.sourceBaselines) baselines.set(baseline.sourceId, baseline)
  for (const baseline of next.sourceBaselines) {
    const existing = baselines.get(baseline.sourceId)
    if (!existing || Date.parse(baseline.observedAt) >= Date.parse(existing.observedAt)) {
      baselines.set(baseline.sourceId, baseline)
    }
  }
  const credits = new Map<string, NonNullable<GuestProfile['legacyCredits']>[number]>()
  for (const credit of stored.legacyCredits ?? []) credits.set(credit.creditId, credit)
  for (const credit of next.legacyCredits ?? []) credits.set(credit.creditId, credit)
  const nextUpdatedAt = Date.parse(next.updatedAt)
  const storedUpdatedAt = Date.parse(stored.updatedAt)
  const scalarSource = Number.isFinite(nextUpdatedAt) && Number.isFinite(storedUpdatedAt) && nextUpdatedAt >= storedUpdatedAt
    ? next
    : stored
  const createdAt = Date.parse(next.createdAt) <= Date.parse(stored.createdAt)
    ? next.createdAt
    : stored.createdAt
  const activeSelection = next.activeSelection && stored.activeSelection
    ? Date.parse(next.activeSelection.selectedAt) >= Date.parse(stored.activeSelection.selectedAt)
      ? next.activeSelection
      : stored.activeSelection
    : next.activeSelection ?? stored.activeSelection
  return {
    ...scalarSource,
    schemaVersion: Math.max(next.schemaVersion, stored.schemaVersion),
    createdAt,
    updatedAt: scalarSource.updatedAt,
    activeCompanionId: activeSelection?.companionId ?? scalarSource.activeCompanionId,
    ...(activeSelection ? { activeSelection } : {}),
    catalogVersion: scalarSource.catalogVersion ?? next.catalogVersion ?? stored.catalogVersion,
    ...(next.migrationVersion || stored.migrationVersion
      ? { migrationVersion: next.migrationVersion ?? stored.migrationVersion }
      : {}),
    collection: [...references.values()],
    sourceBaselines: [...baselines.values()],
    legacyCredits: [...credits.values()],
  }
}

function accountStateFromStorage(
  authoritative: ProductState,
  storage: GuestProfileStorage,
  namespace?: string,
): ProductState {
  // An account provider without a committed namespace is deliberately
  // isolated from every browser key. It must render the server projection or
  // an explicit empty state, never the generic guest archive.
  if (!namespace) return authoritative
  const localProfile = loadGuestProfile(storage, profileKey(namespace))
  if (!localProfile || localProfile.guestId !== authoritative.profile.guestId) return authoritative

  const owned = new Set(authoritative.profile.collection.map((reference) => reference.companionId))
  const localEvents = loadLedger(storage, namespace).events.filter((event) => (
    event.provenance === 'local' &&
    event.source !== 'github' &&
    owned.has(event.companionId)
  ))
  const baselines = new Map(authoritative.profile.sourceBaselines.map((baseline) => [baseline.sourceId, baseline]))
  for (const baseline of localProfile.sourceBaselines) {
    // Note baselines are device-local observation state. GitHub baselines are
    // server checkpoints and must never be revived from a stale browser copy.
    if (baseline.kind !== 'notes') continue
    const current = baselines.get(baseline.sourceId)
    if (!current || baseline.observedAt > current.observedAt) baselines.set(baseline.sourceId, baseline)
  }

  // The server snapshot remains authoritative for selection, collection,
  // migration credits, and encounter rewards. Only local note events and
  // their non-sensitive baselines may rehydrate into this account runtime;
  // stale browser GitHub events cannot render as verified before reconciliation.
  const profile: GuestProfile = {
    ...authoritative.profile,
    sourceBaselines: [...baselines.values()],
  }
  return createProductState(
    profile,
    addEvents(authoritative.ledger, localEvents),
    authoritative.encounters,
    PROTOTYPE_COMPANION_CATALOG,
  )
}

function legacyLedger(storage: GuestProfileStorage): EventLedger {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LEGACY_LEDGER_KEY) ?? '{"events":[]}')
    if (!parsed || typeof parsed !== 'object' || !('events' in parsed) || !Array.isArray(parsed.events)) {
      return { events: [] }
    }
    return addEvents({ events: [] }, (parsed.events as NormalizedEvent[]).map(canonicalizeProductEvent))
  } catch {
    return { events: [] }
  }
}

function loadLedger(storage: GuestProfileStorage, namespace?: string): EventLedger {
  const current = loadBrowserLedger(storage, namespace)
  if (current.events.length > 0 || namespace) return current
  return legacyLedger(storage)
}

function legacyEncounters(storage: GuestProfileStorage): EncounterState {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LEGACY_ENCOUNTER_KEY) ?? 'null')
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

function loadEncounters(storage: GuestProfileStorage, namespace?: string): EncounterState {
  const current = loadBrowserEncounters(storage, namespace)
  if (namespace || current.meter > 0 || current.totalProgress > 0 || current.draws.length > 0) return current
  return legacyEncounters(storage)
}

function signalsFromFiles(files: readonly MarkdownFileSnapshot[]): EncounterSignals {
  const fileTypes = [...new Set(files
    .map((file) => file.path.split('.').pop()?.toLowerCase())
    .filter((value): value is string => Boolean(value)))]
  return { fileTypes }
}

function recordBaseline(
  profile: GuestProfile,
  sourceId: string,
  files: readonly MarkdownFileSnapshot[],
): GuestProfile {
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

/** Kept as a named export for the runtime merge tests and older callers. */
export const mergeEncounterState = mergeEncounterStates

function storageMode(): 'durable' | 'memory' {
  try {
    const key = 'terrarium:storage-probe'
    window.localStorage.setItem(key, '1')
    window.localStorage.removeItem(key)
    return 'durable'
  } catch {
    return 'memory'
  }
}

export function CompanionRuntimeProvider({
  children,
  initialState = null,
  namespace,
  ownsInitialState = false,
  persistLocal = true,
}: CompanionRuntimeProviderProps) {
  const storage = useMemo(() => browserProductStorage(), [])
  const [state, setState] = useState<ProductState | null>(initialState)
  const [status, setStatus] = useState<RuntimeStatus>(initialState ? 'ready' : 'loading')
  const [mode, setMode] = useState<'durable' | 'memory'>('durable')
  const [isFreshProfile, setIsFreshProfile] = useState(!initialState)
  const [revealedDraws, setRevealedDraws] = useState<readonly string[]>([])
  const stateRef = useRef<ProductState | null>(initialState)
  const previousScans = useRef(new Map<string, MarkdownFileSnapshot[]>())
  const initialRef = useRef(initialState)
  const namespaceRef = useRef(namespace)

  const setRuntimeState = useCallback((next: ProductState | null) => {
    stateRef.current = next
    setState(next)
  }, [])

  const persist = useCallback((next: ProductState) => {
    if (!persistLocal || (ownsInitialState && !namespace)) {
      // An account projection without a committed browser namespace is still
      // authoritative in memory, but it is never allowed to write guest keys.
      setRuntimeState(next)
      return
    }
    try {
      // Merge durable event/encounter history before the multi-key write. A
      // second tab may have accepted a source event since this render; its
      // stable IDs must survive this tab's profile write. The server remains
      // authoritative for account activation, migration credits, and cloud
      // encounter rewards on the next account reconciliation.
      const storedProfile = loadGuestProfile(storage, profileKey(namespace))
      const mergedProfile = namespace && storedProfile
        ? mergeAccountProfilesForPersistence(next.profile, storedProfile)
        : next.profile
      const mergedLedger = addEvents(loadLedger(storage, namespace), next.ledger.events)
      const mergedEncounters = mergeEncounterState(loadEncounters(storage, namespace), next.encounters)
      const persisted = createProductState(
        mergedProfile,
        mergedLedger,
        mergedEncounters,
        PROTOTYPE_COMPANION_CATALOG,
      )
      saveGuestProfile(storage, persisted.profile, profileKey(namespace))
      saveBrowserLedger(storage, persisted.ledger, namespace)
      saveBrowserEncounters(storage, persisted.encounters, namespace)
      setRuntimeState(persisted)
      window.dispatchEvent(new CustomEvent(COMPANION_STATE_EVENT, {
        detail: { namespace: namespace ?? null },
      }))
    } catch {
      setRuntimeState(next)
      setStatus('storage-unavailable')
    }
  }, [namespace, ownsInitialState, persistLocal, setRuntimeState, storage])

  const refresh = useCallback(() => {
    if (ownsInitialState) {
      const authoritative = initialRef.current
      if (!authoritative) {
        // Signed-in but not-yet-synced is an explicit empty state. There is no
        // guest fallback here, even when the account namespace is unavailable.
        setRuntimeState(null)
      } else {
        setRuntimeState(accountStateFromStorage(authoritative, storage, namespace))
      }
      setIsFreshProfile(false)
      setStatus('ready')
      return
    }
    try {
      const storedProfile = loadGuestProfile(storage, profileKey(namespace))
      const profile = storedProfile ?? ensureBrowserGuestProfile(
        storage,
        selectStarterCompanionId(PROTOTYPE_COMPANION_CATALOG),
        namespace,
      )
      setIsFreshProfile(!storedProfile)
      const next = createProductState(
        profile,
        loadLedger(storage, namespace),
        loadEncounters(storage, namespace),
        PROTOTYPE_COMPANION_CATALOG,
      )
      setRuntimeState(next)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [namespace, ownsInitialState, setRuntimeState, storage])

  useEffect(() => {
    if (!ownsInitialState || initialState === initialRef.current) return
    // A route refresh/account switch can replace the server projection while
    // this client boundary stays mounted. Reset the authority and scan cache;
    // the next runtime refresh may merge only the matching account namespace.
    initialRef.current = initialState
    previousScans.current.clear()
    refresh()
  }, [initialState, ownsInitialState, refresh])

  useEffect(() => {
    if (namespaceRef.current !== namespace) {
      namespaceRef.current = namespace
      previousScans.current.clear()
    }
    // Browser storage is an external system; probe it after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(storageMode())
    refresh()
    setRevealedDraws(
      ownsInitialState && !namespace
        ? []
        : loadRevealedDraws(storage, namespace),
    )

    const onExternalUpdate = (event: Event) => {
      if (!companionRuntimeEventMatchesNamespace(event, namespace)) return
      refresh()
    }
    const onStorage = (event: StorageEvent) => {
      if (companionRuntimeStorageKeyMatchesNamespace(event.key, namespace)) refresh()
    }
    const onScan = (event: Event) => {
      const detail = (event as CustomEvent<MarkdownScanDetail>).detail
      if (!detail || !detail.sourceId || !Array.isArray(detail.files)) return
      const current = stateRef.current
      if (!current) return
      const previous = previousScans.current.get(detail.sourceId)
      const knownPaths = loadMarkdownKnownPaths(storage, detail.sourceId, namespace)
      const hasBaseline = current.profile.sourceBaselines.some((baseline) => baseline.sourceId === detail.sourceId)
      // Keep path tombstones in a local-only manifest. It lets a later scan
      // distinguish an old note from a genuinely new path without persisting
      // note contents or leaking private paths into ProductSnapshot.
      rememberMarkdownPaths(
        storage,
        detail.sourceId,
        detail.files.map((file) => file.path),
        namespace,
      )
      if (!previous) {
        previousScans.current.set(detail.sourceId, detail.files)
        // A source baseline created before the manifest existed must be
        // initialized once without awarding its existing files as new notes.
        if (!hasBaseline || knownPaths === null) {
          const baselineProfile = recordBaseline(current.profile, detail.sourceId, detail.files)
          if (baselineProfile !== current.profile) {
            persist(createProductState(baselineProfile, current.ledger, current.encounters, PROTOTYPE_COMPANION_CATALOG))
          }
          return
        }
        const normalized = normalizeMarkdownEvents({
          sourceId: detail.sourceId,
          companionId: current.profile.activeCompanionId,
          previous: [],
          current: detail.files,
          knownPaths,
          renameHints: detail.renameHints,
        })
        if (normalized.length === 0) return
        const next = applyProductEvents(current, normalized, PROTOTYPE_COMPANION_CATALOG, {
          encounterSignals: signalsFromFiles(detail.files),
          triggerId: `scan:${detail.sourceId}:${normalized.map((item) => item.eventId).join('|')}`,
        })
        persist(next)
        return
      }
      const normalized = normalizeMarkdownEvents({
        sourceId: detail.sourceId,
        companionId: current.profile.activeCompanionId,
        previous,
        current: detail.files,
        knownPaths: knownPaths ?? [],
        renameHints: detail.renameHints,
      })
      // Preserve deleted snapshots as in-memory tombstones for this tab. If a
      // path is recreated before reload, it remains an edit/identity match and
      // cannot mint a second new-note reward.
      const currentPaths = new Set(detail.files.map((file) => file.path))
      previousScans.current.set(detail.sourceId, [
        ...previous.filter((file) => !currentPaths.has(file.path)),
        ...detail.files,
      ])
      if (normalized.length === 0) return
      const next = applyProductEvents(current, normalized, PROTOTYPE_COMPANION_CATALOG, {
        encounterSignals: signalsFromFiles(detail.files),
        triggerId: `scan:${detail.sourceId}:${normalized.map((item) => item.eventId).join('|')}`,
      })
      persist(next)
    }

    window.addEventListener(COMPANION_STATE_EVENT, onExternalUpdate)
    window.addEventListener(COMPANION_PROFILE_EVENT, onExternalUpdate)
    window.addEventListener('storage', onStorage)
    window.addEventListener(COMPANION_SCAN_EVENT, onScan)
    window.addEventListener(LEGACY_SCAN_EVENT, onScan)
    return () => {
      window.removeEventListener(COMPANION_STATE_EVENT, onExternalUpdate)
      window.removeEventListener(COMPANION_PROFILE_EVENT, onExternalUpdate)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(COMPANION_SCAN_EVENT, onScan)
      window.removeEventListener(LEGACY_SCAN_EVENT, onScan)
    }
  }, [namespace, ownsInitialState, persist, refresh, storage])

  const switchCompanion = useCallback((companionId: string) => {
    const current = stateRef.current
    if (!current) return
    const next = switchActiveCompanion(current, companionId, PROTOTYPE_COMPANION_CATALOG)
    if (next !== current) persist(next)
  }, [persist])

  const migrateLegacy = useCallback((input: LegacyCreatureInput) => {
    const current = stateRef.current
    if (ownsInitialState || !current || isFreshProfile) return
    const result = migrateLegacyCreature(current, input, PROTOTYPE_COMPANION_CATALOG, {
      now: new Date().toISOString(),
    })
    if (result.changed) persist(result.state)
  }, [isFreshProfile, ownsInitialState, persist])

  const dismissDraw = useCallback((drawId: string) => {
    if (ownsInitialState && !namespace) return
    setRevealedDraws((current) => {
      if (current.includes(drawId)) return current
      const next = [...current, drawId]
      saveRevealedDraws(storage, next, namespace)
      return next
    })
  }, [namespace, ownsInitialState, storage])

  const value = useMemo<CompanionRuntimeContextValue>(() => ({
    state,
    status,
    storageMode: mode,
    isFreshProfile,
    revealedDraws,
    refresh,
    switchCompanion,
    migrateLegacy,
    dismissDraw,
  }), [dismissDraw, isFreshProfile, migrateLegacy, mode, refresh, revealedDraws, state, status, switchCompanion])

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
}

export function useCompanionRuntime(): CompanionRuntimeContextValue {
  const value = useContext(RuntimeContext)
  if (!value) throw new Error('useCompanionRuntime must be used inside CompanionRuntimeProvider')
  return value
}

export function CompanionRuntimeStatus({ className = '' }: { className?: string }) {
  const { status, storageMode } = useCompanionRuntime()
  if (status === 'ready' && storageMode !== 'memory') return null
  const message = storageMode === 'memory'
    ? 'Browser storage is unavailable. This session is using a temporary copy.'
    : status === 'loading'
      ? 'Preparing your companion…'
      : status === 'storage-unavailable'
        ? 'Browser storage is unavailable. This session is using a temporary copy.'
        : 'Companion state could not be loaded. Try again.'
  return <p role="status" className={`font-data text-xs uppercase tracking-widest ${className}`} style={{ color: 'var(--ink-muted)' }}>{message}</p>
}
