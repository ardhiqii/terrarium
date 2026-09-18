'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  asCompanionId,
  asEventId,
  type EventCategory,
  type EventMetadataValue,
  type NormalizedEvent,
} from '@/lib/game/events'
import {
  applyProductEvents,
  createProductState,
  switchActiveCompanion,
  type ProductState,
} from '@/lib/game/product-state'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import {
  browserProductStorage,
  DEFAULT_STORED_SYNC_SCHEDULE,
  ensureBrowserGuestProfile,
  loadBrowserEncounters,
  loadBrowserLedger,
  loadRevealedDraws,
  loadSyncRequestUsage,
  loadSyncScheduleState,
  loadVerifiedEventProofs,
  saveBrowserEncounters,
  saveBrowserLedger,
  saveRevealedDraws,
  saveSyncRequestUsage,
  saveSyncScheduleState,
  saveVerifiedEventProofs,
} from '@/lib/game/product-browser-storage'
import { saveGuestProfile, type GuestProfile } from '@/lib/game/guest-profile'
import {
  clearGithubRepositoryCache,
  decideFailedListingRefresh,
  loadGithubRepositoryCache,
  saveGithubRepositoryCache,
} from '@/lib/game/github-repository-browser-cache'
import {
  adoptAccountGuestIdentity,
  canRunGuestIdentityAction,
  describeGuestIdentityConflict,
  describeGuestIdentitySide,
  guestIdentityActionPlan,
  guestIdentityActionSummary,
  isGuestIdentityConflict,
  summarizeGuestSnapshot,
  type GuestIdentityConflictAction,
  type GuestIdentityConflictView,
  type GuestIdentitySideSummary,
} from '@/lib/game/guest-identity-conflict'
import {
  buildProductSnapshot,
  deserializeProductSnapshot,
  mergeProductSnapshots,
  restoreProductStateFromSnapshot,
  type ProductSnapshot,
} from '@/lib/sync/product-snapshot'
import { productEventId } from '@/lib/sync/product-event-id'
import { loginHrefFor } from '@/lib/sync/oauth-return-path'
import {
  addSyncRequestUsage,
  MAX_SYNC_REPOSITORIES,
  mergeSyncRequestUsage,
  parseSyncSchedule,
  scheduleIntervalMs,
  scheduleTick,
  SYNC_SCHEDULE_OPTIONS,
  syncScheduleLabel,
  type SyncRequestUsageEntry,
  type SyncScheduleInterval,
} from '@/lib/sync/sync-schedule'
import { filterGithubRepositories, type RepositoryScope } from '@/lib/sync/github-repository-browser'
import type { GithubRepository } from '@/lib/sync/github-repositories'
import { CompanionSwitcher } from './CompanionSwitcher'
import { SyncProgress } from './SyncProgress'
import { EncounterReveal } from './EncounterReveal'
import { ProductActivityPanel } from './ProductActivityPanel'
import { GitHubRewardGuide } from './GitHubRewardGuide'

interface GithubSettings {
  trackedRepositoryIds: readonly string[]
  excludedRepositoryIds: readonly string[]
  autoIncludePersonal: boolean
  autoIncludeOrganizations: readonly string[]
  lastSyncedAt: string | null
}

interface RepositoryResponse {
  githubId: number
  repositories: GithubRepository[]
  settings: GithubSettings
  approvedRepositoryCount: number
  trackedRepositoryCount: number
  /** When the server read this listing from GitHub. */
  fetchedAt: number
  /** True when the server fell back to its own cached listing. */
  stale: boolean
}

const EVENT_CATEGORIES: readonly EventCategory[] = [
  'qualifying-active-day',
  'work-session',
  'new-note',
  'new-words',
  'resolved-wikilink',
  'merged-pull-request',
  'published-release',
  'closed-linked-issue',
  'successful-ci',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEventCategory(value: unknown): value is EventCategory {
  return typeof value === 'string' && EVENT_CATEGORIES.includes(value as EventCategory)
}

function parseEvent(value: unknown): NormalizedEvent | null {
  if (!isRecord(value)) return null
  if (
    typeof value.eventId !== 'string' ||
    typeof value.companionId !== 'string' ||
    value.source !== 'github' ||
    value.provenance !== 'verified' ||
    !isEventCategory(value.category) ||
    typeof value.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(value.occurredAt))
  ) return null

  let event: NormalizedEvent = {
    eventId: asEventId(value.eventId),
    companionId: asCompanionId(value.companionId),
    source: 'github',
    sourceId: 'github-sync',
    provenance: 'verified',
    category: value.category,
    occurredAt: new Date(value.occurredAt).toISOString(),
  }
  if (
    isRecord(value.cap) &&
    typeof value.cap.key === 'string' &&
    value.cap.key.trim().length > 0 &&
    typeof value.cap.limit === 'number' &&
    Number.isInteger(value.cap.limit) &&
    value.cap.limit >= 0
  ) {
    event = { ...event, cap: { key: value.cap.key, limit: value.cap.limit } }
  }
  if (isRecord(value.metadata)) {
    const metadata: Record<string, EventMetadataValue> = {}
    for (const [key, metadataValue] of Object.entries(value.metadata)) {
      if (
        (typeof metadataValue === 'string' || typeof metadataValue === 'number' || typeof metadataValue === 'boolean') &&
        ['activityCount', 'bucket', 'number', 'repositoryId', 'linkedPullRequestId', 'pullRequestId', 'sessionBucket'].includes(key)
      ) {
        metadata[key] = metadataValue
      }
    }
    if (Object.keys(metadata).length > 0) event = { ...event, metadata }
  }
  return event
}

function parseVerifiedEventProofs(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const proofs: Record<string, string> = {}
  for (const [eventId, proof] of Object.entries(value)) {
    if (/^event-[0-9a-f]{8}-[0-9a-f]{8}$/u.test(eventId) && typeof proof === 'string' && proof.length <= 128) {
      proofs[eventId] = proof
    }
  }
  return proofs
}

function proofsFromSnapshotEvents(
  events: readonly { eventId: string; verifiedProof?: string }[],
): Record<string, string> {
  const proofs: Record<string, string> = {}
  for (const event of events) {
    if (event.verifiedProof) proofs[event.eventId] = event.verifiedProof
  }
  return proofs
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}))
  return isRecord(body) ? body : {}
}

/**
 * Writes a fresh listing into browser storage and returns the time it was read
 * from GitHub. `savedAt` tracks the read time, not the write time, so the
 * freshness label stays honest when the server itself served a cache entry.
 */
function persistRepositoryCache(data: RepositoryResponse): number {
  const repositories = Array.isArray(data.repositories) ? data.repositories : []
  const readAt = typeof data.fetchedAt === 'number' && Number.isFinite(data.fetchedAt) && data.fetchedAt > 0
    ? data.fetchedAt
    : Date.now()
  saveGithubRepositoryCache(browserProductStorage(), {
    githubId: data.githubId,
    savedAt: readAt,
    repositories,
    settings: data.settings,
    approvedRepositoryCount: typeof data.approvedRepositoryCount === 'number'
      ? data.approvedRepositoryCount
      : repositories.length,
    trackedRepositoryCount: typeof data.trackedRepositoryCount === 'number'
      ? data.trackedRepositoryCount
      : 0,
  })
  return readAt
}

function relativeAgeLabel(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
}

/**
 * "List updated 3 min ago", or the degraded variant when the visible list is
 * the last known one because GitHub could not be read.
 */
function repositoryListFreshnessLabel(readAt: number | null, stale: boolean): string | null {
  if (readAt === null) return null
  const updated = relativeAgeLabel(Date.now() - readAt)
  return stale ? `cached · unavailable · updated ${updated}` : `List updated ${updated}`
}

interface SyncProgressState {
  repositoryIndex: number
  repositoryCount: number
  repository: string
  requestsDone: number
}

/**
 * How often the scheduler re-checks the cadence. It is much shorter than any
 * interval option so a tab that was closed through its due time syncs soon
 * after it reopens, and short enough that the pause notice is not stale.
 */
const SCHEDULE_TICK_MS = 30 * 1000

/**
 * Reads a streamed sync response.
 *
 * A sync reads up to 25 repositories back to back, so the route answers with
 * newline-delimited JSON and reports each repository as it starts. Pre-flight
 * failures and the no-repositories path still answer with ordinary JSON, and
 * that is handled here so callers see one shape either way.
 */
async function readSyncResponse(
  response: Response,
  onProgress: (progress: SyncProgressState) => void,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/x-ndjson') || !response.body) {
    return responseBody(response)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // Held in an object so the closure assignments below are not narrowed away.
  const outcome: {
    result: Record<string, unknown>
    failure: string | null
    /** True once a `result` or `error` line has been seen. */
    sawTerminal: boolean
  } = {
    result: {},
    failure: null,
    sawTerminal: false,
  }

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // A corrupt or partial line must never take the whole sync down.
      return
    }
    if (!isRecord(parsed)) return
    if (parsed.type === 'progress') {
      onProgress({
        repositoryIndex: typeof parsed.repositoryIndex === 'number' ? parsed.repositoryIndex : 0,
        repositoryCount: typeof parsed.repositoryCount === 'number' ? parsed.repositoryCount : 0,
        repository: typeof parsed.repository === 'string' ? parsed.repository : '',
        requestsDone: typeof parsed.requestsDone === 'number' ? parsed.requestsDone : 0,
      })
      return
    }
    if (parsed.type === 'result' && isRecord(parsed.payload)) {
      outcome.result = parsed.payload
      outcome.sawTerminal = true
      return
    }
    if (parsed.type === 'error') {
      outcome.sawTerminal = true
      outcome.failure = typeof parsed.error === 'string'
        ? parsed.error
        : 'GitHub activity could not be synced.'
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // A line split across two chunks stays buffered until its newline arrives.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    // Flush the decoder. A multi-byte character split across the final chunk
    // boundary is held back until the stream is explicitly drained, and losing
    // it would corrupt the terminal line.
    buffer += decoder.decode()
    handleLine(buffer)
  } finally {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined)
    }
    try {
      reader.releaseLock()
    } catch {
      // A lock already released by cancel() must not mask the real outcome.
    }
  }

  if (outcome.failure) throw new Error(outcome.failure)
  // A stream that ends without a terminal line means the sync was cut off: a
  // platform timeout, a proxy that rewrote the content type, or a corrupt line.
  // Returning an empty body here would surface as a successful sync reporting
  // "0 new verified events", which is precisely the false success this
  // indicator exists to prevent. Fail loudly instead.
  if (!outcome.sawTerminal) {
    throw new Error('The sync ended before it finished. Nothing was awarded; try again.')
  }
  return outcome.result
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === 'string' ? body.error : fallback
}

function repositoryOwnerId(owner: string): string {
  return owner.toLowerCase().replace(/[^a-z0-9]+/gu, '-') || 'unknown'
}

function browserState(namespace?: string): ProductState {
  const storage = browserProductStorage()
  const profile = ensureBrowserGuestProfile(storage, PROTOTYPE_COMPANION_CATALOG.list()[0].id, namespace)
  return createProductState(
    profile,
    loadBrowserLedger(storage, namespace),
    loadBrowserEncounters(storage, namespace),
    PROTOTYPE_COMPANION_CATALOG,
  )
}

function saveBrowserProductState(state: ProductState, namespace: string): void {
  const storage = browserProductStorage()
  saveGuestProfile(storage, state.profile, `terrarium:guest-profile:${namespace}`)
  saveBrowserLedger(storage, state.ledger, namespace)
  saveBrowserEncounters(storage, state.encounters, namespace)
}

function isBlankAccountState(state: ProductState): boolean {
  return state.ledger.events.length === 0 &&
    state.profile.sourceBaselines.length === 0 &&
    state.profile.collection.length === 1 &&
    state.profile.collection[0]?.acquisition === 'starter'
}

async function restoreCloudProductState(
  local: ProductState,
  namespace: string,
): Promise<{ state: ProductState; message?: string }> {
  try {
    const storage = browserProductStorage()
    const localProofs = loadVerifiedEventProofs(storage, namespace)
    const response = await fetch('/api/sync/product', { cache: 'no-store' })
    if (response.status === 401 || response.status === 404) return { state: local }
    const body = await responseBody(response)
    if (!response.ok) {
      return {
        state: local,
        message: errorMessage(body, 'Cloud condition could not be restored; local progress is safe.'),
      }
    }
    const cloud = deserializeProductSnapshot(JSON.stringify(body))
    if (!cloud) {
      return { state: local, message: 'Cloud condition was invalid; local progress is safe.' }
    }

    let restored: ProductState
    let restoredProofs: Record<string, string>
    if (cloud.guestId === local.profile.guestId) {
      const merged = mergeProductSnapshots(buildProductSnapshot(local, undefined, localProofs), cloud)
      restored = restoreProductStateFromSnapshot(merged, local.profile, PROTOTYPE_COMPANION_CATALOG)
      restoredProofs = proofsFromSnapshotEvents(merged.events)
    } else if (isBlankAccountState(local)) {
      // A fresh browser has a new local guest ID. Adopt the account's cloud ID
      // so future POSTs can continue the recovered profile instead of hitting
      // the route's different-guest conflict guard.
      restored = restoreProductStateFromSnapshot(cloud, local.profile, PROTOTYPE_COMPANION_CATALOG)
      restoredProofs = proofsFromSnapshotEvents(cloud.events)
    } else {
      return {
        state: local,
        message: 'A different local guest profile is already active. Local progress was kept; export or review it before restoring the cloud condition.',
      }
    }
    saveBrowserProductState(restored, namespace)
    saveVerifiedEventProofs(storage, restoredProofs, restored.ledger.events.map((event) => productEventId(event.eventId)), namespace)
    return { state: restored, message: 'Cloud condition restored.' }
  } catch {
    return { state: local, message: 'Cloud condition could not be restored; local progress is safe.' }
  }
}

interface ProductUploadResult {
  readonly ok: boolean
  readonly status: number
  readonly body: Record<string, unknown>
}

/** Upload one product snapshot, carrying the signed checkpoint when the sync issued one. */
async function uploadProductSnapshot(snapshot: ProductSnapshot, checkpoint: string | null): Promise<ProductUploadResult> {
  const response = await fetch('/api/sync/product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(checkpoint ? { snapshot, checkpoint } : snapshot),
  })
  return { ok: response.ok, status: response.status, body: await responseBody(response) }
}

/**
 * Read the account's cloud snapshot so the identity chooser can describe it.
 * Returns null when the copy cannot be read; the chooser then says so instead
 * of inventing an identity to adopt.
 */
async function readAccountSnapshot(): Promise<ProductSnapshot | null> {
  try {
    const response = await fetch('/api/sync/product', { cache: 'no-store' })
    if (!response.ok) return null
    return deserializeProductSnapshot(JSON.stringify(await responseBody(response)))
  } catch {
    return null
  }
}

/**
 * Persist and display the merged snapshot a successful upload returned, so the
 * browser copy is the same union the server now holds.
 */
function adoptUploadedSnapshot(
  body: Record<string, unknown>,
  fallbackProfile: GuestProfile,
  namespace: string,
): ProductState | null {
  const snapshot = deserializeProductSnapshot(JSON.stringify(body))
  if (!snapshot) return null
  const state = restoreProductStateFromSnapshot(snapshot, fallbackProfile, PROTOTYPE_COMPANION_CATALOG)
  try {
    const storage = browserProductStorage()
    saveBrowserProductState(state, namespace)
    saveVerifiedEventProofs(
      storage,
      proofsFromSnapshotEvents(snapshot.events),
      state.ledger.events.map((event) => productEventId(event.eventId)),
      namespace,
    )
  } catch {
    // A refused storage write (private mode, quota) must not undo an upload
    // that already succeeded server-side.
  }
  return state
}

/** One side of the identity chooser: what this copy actually holds. */
function GuestIdentitySideCard({ label, summary }: { label: string; summary: GuestIdentitySideSummary }) {
  const description = describeGuestIdentitySide(summary)
  return (
    <div className="bg-[color:var(--paper)] px-5 py-4">
      <p className="font-data text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>{label}</p>
      <p className="font-ui mt-1 text-sm font-medium">{description.events} · {description.companions}</p>
      <p className="font-prose mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>{description.xp} · {description.guestIdShort}</p>
      {description.createdAt && (
        <p className="font-data mt-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
          Created {new Date(description.createdAt).toLocaleDateString()}
        </p>
      )}
      {description.emptinessNote && (
        <p className="font-prose mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>{description.emptinessNote}</p>
      )}
    </div>
  )
}

interface PendingGuestConflict {
  readonly view: GuestIdentityConflictView
  /** The account copy the chooser described; the restore action writes it locally. */
  readonly cloudSnapshot: ProductSnapshot | null
  /** The refused sync's signed checkpoint, so its GitHub baseline can still commit. */
  readonly checkpoint: string | null
}

export function GitHubSourcePanel() {
  const [repositories, setRepositories] = useState<GithubRepository[]>([])
  const [settings, setSettings] = useState<GithubSettings | null>(null)
  const [draftTrackedIds, setDraftTrackedIds] = useState<string[]>([])
  const [draftExcludedIds, setDraftExcludedIds] = useState<string[]>([])
  const [draftAutoPersonal, setDraftAutoPersonal] = useState(false)
  const [draftOrganizations, setDraftOrganizations] = useState<string[]>([])
  const [productState, setProductState] = useState<ProductState | null>(null)
  const [revealedDraws, setRevealedDraws] = useState<string[]>([])
  const [accountNamespace, setAccountNamespace] = useState<string | null>(null)
  // `disconnected` keeps the progression panels visible after the user
  // disconnects: the credential is gone, but earned XP and the companion are
  // exactly what the confirmation says were kept.
  const [status, setStatus] = useState<'loading' | 'ready' | 'signed-out' | 'error' | 'disconnected'>('loading')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<SyncProgressState | null>(null)
  // Cancelling only makes sense while the GitHub read is still in flight. Once
  // the result has arrived the remaining work is local and must finish, or the
  // panel would claim a cancellation while still applying the events.
  const [readingPhase, setReadingPhase] = useState(false)
  const syncAbortRef = useRef<AbortController | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null)
  // Automatic-sync cadence. The default comes from the product docs (every 15
  // minutes) and the choice is per browser profile, because a schedule only runs
  // while this page is open.
  const [schedule, setSchedule] = useState<SyncScheduleInterval>(DEFAULT_STORED_SYNC_SCHEDULE.interval)
  const [scheduleNotice, setScheduleNotice] = useState('')
  const [nextSyncLabel, setNextSyncLabel] = useState('')
  // GitHub requests are counted over a rolling hour. Every attempt records what
  // its progress stream actually spent, and the schedule pauses before the
  // account's hourly ceiling is reached instead of running into a hard limit.
  const syncUsageRef = useRef<SyncRequestUsageEntry[]>([])
  const lastAttemptAtRef = useRef<number | null>(null)
  const lastObservedRequestsRef = useRef<number | null>(null)
  const requestsThisSyncRef = useRef(0)
  // Read through a ref so an in-flight sync records against the cadence the
  // user has now, not the one that was selected when the sync started.
  const scheduleRef = useRef(schedule)
  useEffect(() => {
    scheduleRef.current = schedule
  }, [schedule])
  const [repositoryQuery, setRepositoryQuery] = useState('')
  const [repositoryScope, setRepositoryScope] = useState<RepositoryScope>('all')
  const [collapsedOwners, setCollapsedOwners] = useState<string[]>([])
  // When the visible listing was read from GitHub, and whether it is the last
  // known one because a refresh failed. Shown next to the result count so the
  // picker never implies the list is fresher than it is.
  const [listFetchedAt, setListFetchedAt] = useState<number | null>(null)
  const [listStale, setListStale] = useState(false)
  const [refreshingList, setRefreshingList] = useState(false)
  const [disconnectStage, setDisconnectStage] = useState<'idle' | 'confirm'>('idle')
  const [disconnecting, setDisconnecting] = useState(false)
  // The identity guard's 409 leaves a choice, not a dead end: both copies are
  // described here and each action reports its outcome in the sync summary.
  const guestConflictRef = useRef<PendingGuestConflict | null>(null)
  const [guestConflict, setGuestConflict] = useState<PendingGuestConflict | null>(null)
  const [guestConflictStage, setGuestConflictStage] = useState<'idle' | GuestIdentityConflictAction>('idle')
  const [resolvingGuestConflict, setResolvingGuestConflict] = useState<GuestIdentityConflictAction | null>(null)
  const showGuestConflict = useCallback((next: PendingGuestConflict | null) => {
    // The ref is set in the same tick as the state so `loadRepositories` can
    // tell that its generic "different local guest profile" hydration note
    // would duplicate (and contradict) the chooser now on screen.
    guestConflictRef.current = next
    setGuestConflict(next)
    setGuestConflictStage('idle')
  }, [])
  // The GitHub account id of the last successful response. A stored listing is
  // only painted for that account once it is known; null means "not confirmed
  // yet", which is the first paint of a session.
  const accountGithubIdRef = useRef<number | null>(null)
  // The account whose listing was CONFIRMED in this mount. A failed read may
  // keep the visible listing only while it belongs to the account the server
  // answered for, so this is an account id rather than a mount-scoped boolean:
  // a shared profile can switch accounts in another tab, and the old account's
  // private repository names must not stay on screen for the new one.
  const confirmedGithubIdRef = useRef<number | null>(null)
  // Whether the drafts differ from the saved settings, read through a ref so a
  // refresh can keep unsaved edits without making `loadRepositories` depend on
  // draft state.
  const unsavedDraftRef = useRef(false)

  const hydrateState = useCallback(() => {
    const state = browserState()
    setProductState(state)
    setRevealedDraws(loadRevealedDraws(browserProductStorage()))
    const stored = loadSyncScheduleState(browserProductStorage())
    setSchedule(stored.interval)
    lastAttemptAtRef.current = stored.lastAttemptAt
    syncUsageRef.current = loadSyncRequestUsage(browserProductStorage())
    return state
  }, [])

  const applySettings = useCallback((next: GithubSettings) => {
    setSettings(next)
    setDraftTrackedIds([...next.trackedRepositoryIds])
    setDraftExcludedIds([...next.excludedRepositoryIds])
    setDraftAutoPersonal(next.autoIncludePersonal)
    setDraftOrganizations([...next.autoIncludeOrganizations])
  }, [])

  /**
   * Loads the repository listing.
   *
   * With no `refresh`, the browser copy is painted synchronously first so the
   * picker has no loading state, then the server is asked anyway: the server
   * keeps its own five-minute copy, so the request is normally free, settings
   * stay server-authoritative, and a cold browser with a warm server still
   * gets data. `refresh: true` (the Refresh list button) skips the cache and
   * asks the server to revalidate against GitHub.
   */
  const loadRepositories = useCallback(async (options?: { refresh?: boolean }) => {
    const refresh = options?.refresh === true
    const storage = browserProductStorage()
    // Paint the stored copy only when it is known to belong to this account.
    // Before a response confirms the account this is a best guess that the
    // answer below replaces or discards.
    const cached = loadGithubRepositoryCache(storage, accountGithubIdRef.current ?? undefined)
    /**
     * Applies server settings unless the user has unsaved draft edits. The
     * server's settings did not change while a refresh ran, so reverting the
     * drafts would silently discard the user's selection.
     */
    const applyServerSettings = (next: GithubSettings) => {
      if (unsavedDraftRef.current) {
        setSettings(next)
        return
      }
      applySettings(next)
    }
    if (refresh) {
      setRefreshingList(true)
    } else if (cached) {
      // Instant paint from the last successful listing; the fetch below still
      // runs and stays the source of truth for settings.
      setRepositories([...cached.repositories])
      applyServerSettings(cached.settings)
      setListFetchedAt(cached.savedAt)
      setListStale(false)
      setStatus('ready')
    } else {
      setStatus('loading')
    }
    setMessage('')
    try {
      const response = await fetch(
        `/api/github/repositories${refresh ? '?refresh=1' : ''}`,
        { cache: 'no-store' },
      )
      const body = await responseBody(response)
      if (response.status === 401) {
        // The stored copy belongs to a session that is over. A different
        // account signing in on this profile must not inherit it.
        clearGithubRepositoryCache(storage)
        accountGithubIdRef.current = null
        confirmedGithubIdRef.current = null
        setStatus('signed-out')
        setMessage(errorMessage(body, 'Sign in with GitHub to connect a repository.'))
        return
      }
      if (!response.ok) {
        const failure = errorMessage(body, 'Repositories could not be loaded.')
        // A failed read is not a dead end when the list on screen is known to
        // belong to the account the server answered for: keep the picker
        // usable and say which list the user is looking at. A failure answered
        // for a DIFFERENT account means the visible list belongs to a session
        // that is over -- a shared profile can switch accounts in another tab
        // -- so it is dropped rather than shown for the new account.
        const failedAccountId = typeof body.githubId === 'number' && Number.isFinite(body.githubId)
          ? body.githubId
          : null
        const outcome = decideFailedListingRefresh({
          cached,
          confirmedGithubId: confirmedGithubIdRef.current,
          failedGithubId: failedAccountId,
        })
        if (outcome === 'keep-listing') {
          setListStale(true)
          setStatus('ready')
          setMessage(`${failure} Showing the last known repository list.`)
          return
        }
        if (outcome === 'drop-listing') {
          confirmedGithubIdRef.current = null
          accountGithubIdRef.current = null
          setRepositories([])
          setSettings(null)
          setDraftTrackedIds([])
          setDraftExcludedIds([])
          setDraftAutoPersonal(false)
          setDraftOrganizations([])
        }
        throw new Error(failure)
      }
      const data = body as unknown as RepositoryResponse
      const nextAccountId = typeof data.githubId === 'number' && Number.isFinite(data.githubId)
        ? data.githubId
        : null
      // A successful answer for a different account means the drafts on screen
      // belong to the old account. They must not survive as "unsaved edits"
      // over the new account's settings: their repository IDs are foreign, and
      // saving them would only be rejected as unavailable.
      const accountChanged = accountGithubIdRef.current !== null && nextAccountId !== accountGithubIdRef.current
      accountGithubIdRef.current = nextAccountId
      setRepositories(Array.isArray(data.repositories) ? data.repositories : [])
      if (accountChanged) {
        unsavedDraftRef.current = false
        applySettings(data.settings)
      } else {
        applyServerSettings(data.settings)
      }
      setListFetchedAt(persistRepositoryCache(data))
      setListStale(data.stale === true)
      confirmedGithubIdRef.current = accountGithubIdRef.current
      const namespace = `github-${data.githubId}`
      setAccountNamespace(namespace)
      const storedSchedule = loadSyncScheduleState(browserProductStorage(), namespace)
      setSchedule(storedSchedule.interval)
      lastAttemptAtRef.current = storedSchedule.lastAttemptAt
      syncUsageRef.current = loadSyncRequestUsage(browserProductStorage(), namespace)
      const localState = browserState(namespace)
      const hydrated = await restoreCloudProductState(localState, namespace)
      setProductState(hydrated.state)
      if (hydrated.message && !guestConflictRef.current) setMessage(hydrated.message)
      setRevealedDraws(loadRevealedDraws(browserProductStorage(), namespace))
      setStatus('ready')
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : 'Repositories could not be loaded.')
    } finally {
      setRefreshingList(false)
    }
  }, [applySettings])

  // A layout effect runs before the browser paints, so a remount paints the
  // cached listing in the first frame instead of flashing the loading state.
  useLayoutEffect(() => {
    hydrateState()
    void loadRepositories()
  }, [hydrateState, loadRepositories])

  const organizations = useMemo(
    () => [...new Set(repositories.filter((repo) => repo.ownerType === 'Organization').map((repo) => repo.ownerLogin))].sort(),
    [repositories],
  )
  const filteredRepositories = useMemo(() => {
    return filterGithubRepositories(repositories, repositoryQuery, repositoryScope)
  }, [repositories, repositoryQuery, repositoryScope])
  const groupedRepositories = useMemo(() => {
    const groups = new Map<string, GithubRepository[]>()
    for (const repository of filteredRepositories) {
      const current = groups.get(repository.ownerLogin) ?? []
      current.push(repository)
      groups.set(repository.ownerLogin, current)
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [filteredRepositories])
  const repositoryCountsByOwner = useMemo(() => {
    const counts = new Map<string, number>()
    for (const repository of repositories) counts.set(repository.ownerLogin, (counts.get(repository.ownerLogin) ?? 0) + 1)
    return counts
  }, [repositories])
  const userRepositoryCount = useMemo(
    () => repositories.filter((repository) => repository.ownerType === 'User').length,
    [repositories],
  )
  const organizationRepositoryCount = repositories.length - userRepositoryCount
  const repositoryFiltersActive = repositoryQuery.trim().length > 0 || repositoryScope !== 'all'
  const effectiveTrackedCount = useMemo(
    () => repositories.filter((repository) => {
      if (repository.archived || !repository.canRead || draftExcludedIds.includes(repository.id)) return false
      return draftTrackedIds.includes(repository.id) ||
        (repository.ownerType === 'User'
          ? draftAutoPersonal
          : draftOrganizations.includes(repository.ownerLogin.toLowerCase()))
    }).length,
    [draftAutoPersonal, draftExcludedIds, draftOrganizations, draftTrackedIds, repositories],
  )
  const settingsChanged = settings !== null && (
    settings.trackedRepositoryIds.join('|') !== [...draftTrackedIds].sort().join('|') ||
    settings.excludedRepositoryIds.join('|') !== [...draftExcludedIds].sort().join('|') ||
    settings.autoIncludePersonal !== draftAutoPersonal ||
    settings.autoIncludeOrganizations.join('|') !== [...draftOrganizations].sort().join('|')
  )
  // Kept in a ref so `loadRepositories` can read the flag without depending on
  // draft state (a new identity would re-run the mount effect on every edit).
  useEffect(() => {
    unsavedDraftRef.current = settingsChanged
  }, [settingsChanged])
  const sourceControlsDisabled = savingSettings || busy || resolvingGuestConflict !== null
  const listControlsDisabled = sourceControlsDisabled || refreshingList
  const listFreshnessLabel = repositoryListFreshnessLabel(listFetchedAt, listStale)

  const saveSettings = useCallback(async (): Promise<boolean> => {
    if (savingSettings) return false
    setSavingSettings(true)
    setMessage('')
    try {
      const response = await fetch('/api/github/repositories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackedRepositoryIds: [...draftTrackedIds].sort(),
          excludedRepositoryIds: [...draftExcludedIds].sort(),
          autoIncludePersonal: draftAutoPersonal,
          autoIncludeOrganizations: [...draftOrganizations].sort(),
        }),
      })
      const body = await responseBody(response)
      if (!response.ok) {
        setMessage(errorMessage(body, 'Repository settings could not be saved.'))
        return false
      }
      const data = body as unknown as RepositoryResponse
      accountGithubIdRef.current = typeof data.githubId === 'number' && Number.isFinite(data.githubId)
        ? data.githubId
        : null
      setRepositories(data.repositories)
      applySettings(data.settings)
      // The save response carries the authoritative settings too, so the
      // browser copy must not keep an older selection.
      setListFetchedAt(persistRepositoryCache(data))
      setListStale(data.stale === true)
      confirmedGithubIdRef.current = accountGithubIdRef.current
      return true
    } catch {
      setMessage('Repository settings could not be saved. Try again.')
      return false
    } finally {
      setSavingSettings(false)
    }
  }, [applySettings, draftAutoPersonal, draftOrganizations, draftTrackedIds, savingSettings])

  const syncNow = useCallback(async () => {
    if (!productState) return
    setBusy(true)
    setMessage('')
    setProgress(null)
    setReadingPhase(true)
    requestsThisSyncRef.current = 0
    const controller = new AbortController()
    syncAbortRef.current = controller
    const cancelled = (): boolean => controller.signal.aborted
    try {
      if (settingsChanged && !(await saveSettings())) return
      const response = await fetch('/api/github/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeCompanionId: productState.profile.activeCompanionId }),
        signal: controller.signal,
      })
      let body: Record<string, unknown> = {}
      try {
        body = await readSyncResponse(response, (next) => {
          // The progress stream is the only honest measure of what this sync
          // cost the account's hourly GitHub request budget.
          requestsThisSyncRef.current = Math.max(requestsThisSyncRef.current, next.requestsDone)
          setProgress(next)
        }, controller.signal)
      } catch (error) {
        // An aborted read is the user's own doing, not a failure.
        if (cancelled()) {
          setLastSyncSummary('Sync cancelled. No new activity was awarded.')
          return
        }
        throw error
      } finally {
        setReadingPhase(false)
      }
      if (cancelled()) {
        setLastSyncSummary('Sync cancelled. No new activity was awarded.')
        return
      }
      if (!response.ok) {
        setMessage(errorMessage(body, 'GitHub activity could not be synced.'))
        return
      }
      const verifiedEventProofs = parseVerifiedEventProofs(body.verifiedEventProofs)
      const incoming = Array.isArray(body.events)
        ? body.events
          .map(parseEvent)
          .filter((event): event is NormalizedEvent => event !== null)
          .filter((event) => Boolean(verifiedEventProofs[productEventId(event.eventId)]))
        : []
      const next = applyProductEvents(
        productState,
        incoming,
        PROTOTYPE_COMPANION_CATALOG,
        { triggerId: `github-sync:${body.lastSyncedAt ?? 'unknown'}` },
      )
      const storage = browserProductStorage()
      saveGuestProfile(storage, next.profile, accountNamespace ? `terrarium:guest-profile:${accountNamespace}` : undefined)
      saveBrowserLedger(storage, next.ledger, accountNamespace ?? undefined)
      saveBrowserEncounters(storage, next.encounters, accountNamespace ?? undefined)
      setProductState(next)

      const persistedProofs = {
        ...loadVerifiedEventProofs(storage, accountNamespace ?? undefined),
        ...verifiedEventProofs,
      }
      const uploadSnapshot = buildProductSnapshot(next, undefined, persistedProofs)
      // Save receipts before the cloud upload. The signed checkpoint sent with
      // the snapshot is committed server-side only after this upload succeeds,
      // so a failed condition upload remains retryable.
      saveVerifiedEventProofs(
        storage,
        proofsFromSnapshotEvents(uploadSnapshot.events),
        uploadSnapshot.events.map((event) => event.eventId),
        accountNamespace ?? undefined,
      )
      const checkpoint = typeof body.checkpoint === 'string' ? body.checkpoint : null
      // The checkpoint travels in the BODY. A real account's signed checkpoint
      // is tens of kilobytes (measured ~21 KB at 500 events), far beyond the
      // request-header budget of the platform in front of the function, where
      // it was rejected upstream as a bodyless 500 and the baseline was never
      // committed. A body has a megabyte-scale allowance instead.
      const upload = await uploadProductSnapshot(uploadSnapshot, checkpoint)
      const snapshotBody = upload.body
      const count = typeof body.repositoryCount === 'number' ? body.repositoryCount : 0
      const eventCount = Math.max(0, next.ledger.events.length - productState.ledger.events.length)
      const baselineCount = Array.isArray(body.newBaselineRepositoryIds) ? body.newBaselineRepositoryIds.length : 0
      const skippedCount = typeof body.skippedRepositoryCount === 'number' ? body.skippedRepositoryCount : 0
      const limitNote = skippedCount > 0
        ? ` ${skippedCount} more will be read by the next sync; repositories without a baseline go first.`
        : ''
      // Truncation is not a failure: the scan window ended before the oldest
      // activity, and everything newer than the checkpoint was still awarded.
      const truncatedNote = body.truncated === true
        ? ' The scan window ended before the oldest activity; earlier history is not awarded.'
        : ''
      let cloudNote = upload.ok
        ? ' Condition saved.'
        : ` Local progress is safe, but cloud condition was not saved: ${errorMessage(snapshotBody, 'try again later')}`
      // The identity guard is the one refusal that needs a decision rather than
      // a retry: the account already stores a different guest profile, so both
      // copies are described and the user chooses instead of dead-ending the
      // backup. Any other 409 keeps its own retryable explanation.
      let nextConflict: PendingGuestConflict | null = null
      if (!upload.ok && isGuestIdentityConflict(upload.status, snapshotBody)) {
        const localSummary = summarizeGuestSnapshot(uploadSnapshot)
        const cloudSnapshot = await readAccountSnapshot()
        const cloudSummary = cloudSnapshot ? summarizeGuestSnapshot(cloudSnapshot) : null
        if (localSummary && !cancelled()) {
          nextConflict = {
            view: describeGuestIdentityConflict(localSummary, cloudSummary),
            cloudSnapshot,
            checkpoint,
          }
          cloudNote += ' Choose how to continue in the box above.'
        }
      }
      // A successful upload clears any earlier choice; a new conflict replaces
      // the displayed one with the state that just came back from the server.
      showGuestConflict(nextConflict)
      if (body.kind === 'baseline') {
        setLastSyncSummary(`Baseline recorded for ${baselineCount} ${baselineCount === 1 ? 'repository' : 'repositories'} · no old history awarded.${limitNote}${truncatedNote}${cloudNote}`)
      } else if (body.kind === 'partial' || body.syncStatus === 'partial') {
        setLastSyncSummary(`Checked ${count} tracked ${count === 1 ? 'repository' : 'repositories'} · ${eventCount} new verified events. Some activity could not be read completely; try again to catch up.${limitNote}${cloudNote}`)
      } else {
        setLastSyncSummary(`Checked ${count} tracked ${count === 1 ? 'repository' : 'repositories'} · ${eventCount} new verified events.${truncatedNote}${limitNote}${cloudNote}`)
      }
      await loadRepositories()
    } catch (error) {
      if (cancelled()) {
        setLastSyncSummary('Sync cancelled. No new activity was awarded.')
      } else {
        setMessage(error instanceof Error ? error.message : 'GitHub activity could not be synced.')
      }
    } finally {
      // The panel's own state is restored first and unconditionally: a browser
      // storage write can be refused (private mode, quota), and a write must
      // never leave the panel busy or the scheduler blocked on a dead abort
      // controller. Persistence is best-effort after that.
      setBusy(false)
      setProgress(null)
      setReadingPhase(false)
      syncAbortRef.current = null

      // A cancelled or failed attempt still spent requests against the account's
      // hourly ceiling, so the budget counts what was really issued.
      const attemptedAt = Date.now()
      lastAttemptAtRef.current = attemptedAt
      if (requestsThisSyncRef.current > 0) {
        lastObservedRequestsRef.current = requestsThisSyncRef.current
        syncUsageRef.current = addSyncRequestUsage(
          syncUsageRef.current,
          attemptedAt,
          requestsThisSyncRef.current,
        )
      }
      try {
        const storage = browserProductStorage()
        // `saveSyncRequestUsage` merges a peer tab's entries; it returns the
        // merged record even when the storage write itself is refused.
        syncUsageRef.current = saveSyncRequestUsage(
          storage,
          syncUsageRef.current,
          accountNamespace ?? undefined,
          attemptedAt,
        )
        saveSyncScheduleState(
          storage,
          { interval: scheduleRef.current, lastAttemptAt: attemptedAt },
          accountNamespace ?? undefined,
        )
      } catch {
        // Browser storage is unavailable; the in-memory cadence still holds.
      }
    }
  }, [accountNamespace, loadRepositories, productState, saveSettings, settingsChanged, showGuestConflict])

  /**
   * Resolve the identity choice the 409 left open.
   *
   * The panel only wires the buttons; whether an action may run — including
   * the mandatory confirm step for the destructive one — comes from the pure
   * helper, so a single click can never delete an account's copy or replace
   * local progression on its own.
   */
  const resolveGuestConflict = useCallback(async (
    action: GuestIdentityConflictAction,
    confirmed: boolean,
  ): Promise<void> => {
    const pending = guestConflict
    const state = productState
    const namespace = accountNamespace
    if (!pending || !state || !namespace || resolvingGuestConflict) return
    const plan = guestIdentityActionPlan(pending.view, action)
    if (!plan || !plan.available) return
    if (!canRunGuestIdentityAction(pending.view, action, confirmed)) {
      // The first click moves the destructive choice into its confirm step.
      setGuestConflictStage(action)
      return
    }

    setResolvingGuestConflict(action)
    setMessage('')
    try {
      const storage = browserProductStorage()

      if (action === 'use-browser') {
        const deletion = await fetch('/api/sync/product', { method: 'DELETE' })
        if (!deletion.ok) {
          setLastSyncSummary(guestIdentityActionSummary(action, {
            result: 'failed',
            step: 'delete-cloud',
            detail: errorMessage(await responseBody(deletion), `try again (HTTP ${deletion.status})`),
          }))
          return
        }
        // The account's row is gone, so the guard cannot refuse the retry. The
        // chooser closes even if the upload itself fails, because an ordinary
        // sync can retry that upload.
        showGuestConflict(null)
        const upload = await uploadProductSnapshot(
          buildProductSnapshot(state, undefined, loadVerifiedEventProofs(storage, namespace)),
          pending.checkpoint,
        )
        setLastSyncSummary(guestIdentityActionSummary(action, upload.ok
          ? { result: 'succeeded' }
          : { result: 'failed', step: 'upload', detail: errorMessage(upload.body, 'try again with Sync GitHub now') }))
        return
      }

      if (action === 'keep-both') {
        if (!pending.cloudSnapshot) {
          setLastSyncSummary(guestIdentityActionSummary(action, {
            result: 'failed',
            step: 'read-cloud',
            detail: 'try Sync GitHub now again so the account copy can be read',
          }))
          return
        }
        // Adopt the account's guest identity and keep this browser's ledger,
        // encounters, and XP. The account's starter reference is reused so the
        // next merge unions one starter entry, not two.
        const accountStarterReferenceId = pending.cloudSnapshot.collection.find(
          (reference) => reference.acquisition === 'starter',
        )?.referenceId ?? null
        const adopted = createProductState(
          adoptAccountGuestIdentity(state.profile, pending.cloudSnapshot.guestId, new Date().toISOString(), accountStarterReferenceId),
          state.ledger,
          state.encounters,
          PROTOTYPE_COMPANION_CATALOG,
        )
        try {
          saveBrowserProductState(adopted, namespace)
        } catch {
          setLastSyncSummary(guestIdentityActionSummary(action, {
            result: 'failed',
            step: 'adopt-identity',
            detail: 'browser storage refused the change',
          }))
          return
        }
        setProductState(adopted)
        const upload = await uploadProductSnapshot(
          buildProductSnapshot(adopted, undefined, loadVerifiedEventProofs(storage, namespace)),
          pending.checkpoint,
        )
        if (!upload.ok) {
          setLastSyncSummary(guestIdentityActionSummary(action, {
            result: 'failed',
            step: 'upload',
            detail: errorMessage(upload.body, 'try again later'),
          }))
          return
        }
        const merged = adoptUploadedSnapshot(upload.body, adopted.profile, namespace)
        if (merged) setProductState(merged)
        showGuestConflict(null)
        setLastSyncSummary(guestIdentityActionSummary(action, { result: 'succeeded' }))
        return
      }

      if (!pending.cloudSnapshot) {
        setLastSyncSummary(guestIdentityActionSummary(action, {
          result: 'failed',
          step: 'read-cloud',
          detail: 'try Sync GitHub now again so the account copy can be read',
        }))
        return
      }
      // Follow the account: replace this namespace's local product state with
      // the cloud snapshot and adopt its guest identity.
      let restored: ProductState
      try {
        restored = restoreProductStateFromSnapshot(pending.cloudSnapshot, state.profile, PROTOTYPE_COMPANION_CATALOG)
        saveBrowserProductState(restored, namespace)
        saveVerifiedEventProofs(
          storage,
          proofsFromSnapshotEvents(pending.cloudSnapshot.events),
          restored.ledger.events.map((event) => productEventId(event.eventId)),
          namespace,
        )
      } catch {
        setLastSyncSummary(guestIdentityActionSummary(action, {
          result: 'failed',
          step: 'replace-local',
          detail: 'browser storage refused the change',
        }))
        return
      }
      setProductState(restored)
      // The checkpoint belongs to the GitHub window whose events the local
      // ledger just gave up, so it is dropped: the next sync re-reads that
      // window and awards it against the account's copy.
      const upload = await uploadProductSnapshot(
        buildProductSnapshot(restored, undefined, loadVerifiedEventProofs(storage, namespace)),
        null,
      )
      if (!upload.ok) {
        setLastSyncSummary(guestIdentityActionSummary(action, {
          result: 'failed',
          step: 'upload',
          detail: errorMessage(upload.body, 'try again with Sync GitHub now'),
        }))
        return
      }
      showGuestConflict(null)
      setLastSyncSummary(guestIdentityActionSummary(action, { result: 'succeeded' }))
    } finally {
      setResolvingGuestConflict(null)
      setGuestConflictStage('idle')
    }
  }, [accountNamespace, guestConflict, productState, resolvingGuestConflict, showGuestConflict])

  const changeSchedule = useCallback((next: SyncScheduleInterval) => {
    setSchedule(next)
    setScheduleNotice('')
    setNextSyncLabel('')
    saveSyncScheduleState(
      browserProductStorage(),
      { interval: next, lastAttemptAt: lastAttemptAtRef.current },
      accountNamespace ?? undefined,
    )
  }, [accountNamespace])

  /**
   * Disconnect GitHub: the only control that removes the stored credential.
   * It deliberately keeps earned XP, the companion, and the repository
   * choices -- deleting synced data stays `DELETE /api/sync/product`, a
   * separate explicit action. Nothing automatic (a revoked token, an outage,
   * a closed tab, an expired cookie) can reach this path.
   */
  const disconnectGitHub = useCallback(async () => {
    if (disconnecting) return
    setDisconnecting(true)
    setMessage('')
    try {
      const response = await fetch('/api/github/repositories', { method: 'DELETE' })
      if (response.status === 401) {
        // The credential is still stored; the session cookie is what is
        // missing, so say that instead of claiming a disconnect happened.
        setStatus('signed-out')
        setMessage('Your session expired. Sign in again to disconnect GitHub.')
        return
      }
      if (!response.ok) {
        setMessage('GitHub could not be disconnected. Try again.')
        return
      }
      clearGithubRepositoryCache(browserProductStorage())
      setRepositories([])
      confirmedGithubIdRef.current = null
      accountGithubIdRef.current = null
      setSettings(null)
      setDraftTrackedIds([])
      setDraftExcludedIds([])
      setDraftAutoPersonal(false)
      setDraftOrganizations([])
      // The namespace is kept: it is the local storage key for this account's
      // progression, not the credential. Companion switches and reveals stay
      // in the account's namespace so reconnecting resumes the same state.
      setListFetchedAt(null)
      setListStale(false)
      setScheduleNotice('')
      setNextSyncLabel('')
      // Not `signed-out`: the credential is gone, but the progression panels
      // stay visible because earned XP and the companion were kept.
      setStatus('disconnected')
      setMessage('GitHub disconnected. Earned XP was kept.')
    } catch {
      setMessage('GitHub could not be disconnected. Try again.')
    } finally {
      setDisconnecting(false)
      setDisconnectStage('idle')
    }
  }, [disconnecting])

  // The latest `syncNow` is reached through a ref so the ticker below does not
  // have to be torn down every time product state changes.
  const syncNowRef = useRef(syncNow)
  useEffect(() => {
    syncNowRef.current = syncNow
  }, [syncNow])

  /**
   * The scheduled sync runs only while this page is open -- that is the whole
   * contract in the product docs, and it is why the cadence lives in the panel
   * rather than in a server cron. One ticker owns every automatic decision, so
   * two intervals can never double a sync.
   */
  useEffect(() => {
    if (status !== 'ready') return
    // A manual cadence has no ticker at all; the rendered copy for `manual`
    // above ignores any notice left over from a previous cadence.
    if (scheduleIntervalMs(schedule) === null) return

    const tick = (): void => {
      const now = Date.now()
      try {
        // A peer tab may have spent requests we have not seen; fold its record
        // in before deciding, or two tabs each think the whole budget is free.
        syncUsageRef.current = mergeSyncRequestUsage(
          syncUsageRef.current,
          loadSyncRequestUsage(browserProductStorage(), accountNamespace ?? undefined, now),
        )
      } catch {
        // Storage unavailable: decide from the in-memory record.
      }
      const result = scheduleTick({
        interval: schedule,
        now,
        lastAttemptAt: lastAttemptAtRef.current,
        usage: syncUsageRef.current,
        // The estimate must match what a sync actually reads: the window, not
        // the whole tracked set, or a 5-minute cadence would pause forever for
        // an account whose window costs far less than its total.
        trackedRepositoryCount: Math.min(effectiveTrackedCount, MAX_SYNC_REPOSITORIES),
        lastObservedRequests: lastObservedRequestsRef.current,
        busy: syncAbortRef.current !== null,
      })
      syncUsageRef.current = [...result.usage]
      setScheduleNotice(result.notice)
      setNextSyncLabel(result.nextLabel)
      if (result.run) {
        // The scheduler must never reject into the timer; syncNow reports its
        // own failures through the panel's message state.
        void syncNowRef.current().catch(() => undefined)
      }
    }

    tick()
    const timer = window.setInterval(tick, SCHEDULE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [accountNamespace, effectiveTrackedCount, schedule, status])

  const toggleTracked = (repository: GithubRepository) => {
    const autoTracked = repository.ownerType === 'User'
      ? draftAutoPersonal
      : draftOrganizations.includes(repository.ownerLogin.toLowerCase())
    const checked = draftTrackedIds.includes(repository.id) || (autoTracked && !draftExcludedIds.includes(repository.id))
    if (checked) {
      setDraftTrackedIds((current) => current.filter((value) => value !== repository.id))
      if (autoTracked) setDraftExcludedIds((current) => current.includes(repository.id) ? current : [...current, repository.id])
    } else {
      setDraftTrackedIds((current) => current.includes(repository.id) ? current : [...current, repository.id])
      setDraftExcludedIds((current) => current.filter((value) => value !== repository.id))
    }
  }

  const toggleOrganization = (login: string) => {
    setDraftOrganizations((current) => current.includes(login) ? current.filter((value) => value !== login) : [...current, login])
  }

  const toggleOwner = (owner: string) => {
    setCollapsedOwners((current) => current.includes(owner)
      ? current.filter((value) => value !== owner)
      : [...current, owner])
  }

  const dismissDraw = (drawId: string) => {
    setRevealedDraws((current) => {
      const next = current.includes(drawId) ? current : [...current, drawId]
      saveRevealedDraws(browserProductStorage(), next, accountNamespace ?? undefined)
      return next
    })
  }

  const makeActive = (companionId: string) => {
    if (!productState) return
    const next = switchActiveCompanion(productState, companionId, PROTOTYPE_COMPANION_CATALOG)
    if (next === productState) return
    const storage = browserProductStorage()
    saveGuestProfile(storage, next.profile, accountNamespace ? `terrarium:guest-profile:${accountNamespace}` : undefined)
    setProductState(next)
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6">
      <section className="border-y py-8" style={{ borderColor: 'var(--rule)' }}>
        <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
          GitHub · remote signal
        </p>
        <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <h1 className="font-ui text-4xl font-semibold tracking-tighter sm:text-5xl">
              Let your work wake the companion.
            </h1>
            <p className="font-prose mt-4 max-w-xl text-base leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              Choose the repositories Terrarium may read. GitHub activity is verified for you, while repository contents and code stay out of Terrarium.
            </p>
          </div>
          {status === 'ready' && (
            <div className="shrink-0 lg:w-72">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void syncNow()}
                  disabled={sourceControlsDisabled || !productState}
                  className="ui-row font-ui border px-4 py-3 text-sm font-medium transition-transform active:translate-y-[1px] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"
                  style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }}
                >
                  {busy ? 'Syncing…' : 'Sync GitHub now'}
                </button>
                {busy && readingPhase && (
                  <button
                    type="button"
                    onClick={() => syncAbortRef.current?.abort()}
                    className="ui-row font-ui border px-3 py-3 text-xs transition-transform active:translate-y-[1px] motion-reduce:transition-none"
                    style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {busy && (
                <SyncProgress
                  repositoryIndex={progress?.repositoryIndex ?? 0}
                  repositoryCount={progress?.repositoryCount ?? 0}
                  repository={progress?.repository ?? ''}
                  requestsDone={progress?.requestsDone ?? 0}
                />
              )}
              <label
                htmlFor="github-sync-schedule"
                className="font-data mt-4 block text-[10px] uppercase tracking-wider"
                style={{ color: 'var(--ink-muted)' }}
              >
                Automatic sync
                <select
                  id="github-sync-schedule"
                  value={schedule}
                  disabled={sourceControlsDisabled}
                  onChange={(event) => changeSchedule(parseSyncSchedule(event.target.value))}
                  className="font-ui mt-1.5 w-full border bg-[color:var(--paper)] px-2 py-2 text-xs"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                >
                  {SYNC_SCHEDULE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{syncScheduleLabel(option)}</option>
                  ))}
                </select>
              </label>
              <p
                role={scheduleNotice ? 'status' : undefined}
                aria-live={scheduleNotice ? 'polite' : undefined}
                className="font-prose mt-2 text-xs leading-relaxed"
                style={{ color: 'var(--ink-muted)' }}
              >
                {schedule === 'manual'
                  ? 'Automatic sync is off. Use Sync GitHub now.'
                  : scheduleNotice
                    || nextSyncLabel
                    || 'Runs while this page is open. It pauses before your hourly GitHub request limit is spent.'}
              </p>
            </div>
          )}
        </div>
      </section>

      {status === 'loading' && (
        <p className="font-data border-b py-6 text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
          Checking GitHub access…
        </p>
      )}

      {(status === 'signed-out' || status === 'disconnected') && (
        <section className="mt-6 border p-6" style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}>
          <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Not connected</p>
          <h2 className="font-ui mt-2 text-2xl font-semibold tracking-tight">Connect GitHub to choose a source.</h2>
          <p className="font-prose mt-3 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Terrarium asks GitHub for repository access so it can list personal and organization repositories. You approve the list; only tracked repositories affect progression.
          </p>
          {message && (
            <p role="status" aria-live="polite" className="font-prose mt-3 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              {message}
            </p>
          )}
          <a href={loginHrefFor('/github')} className="ui-row font-ui mt-5 inline-block border px-4 py-2 text-sm" style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}>
            Sign in with GitHub
          </a>
        </section>
      )}

      {status === 'error' && (
        <section className="mt-6 border p-6" style={{ borderColor: 'var(--rule)' }}>
          <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>{message}</p>
          <button type="button" onClick={() => void loadRepositories()} className="ui-row font-data mt-4 border px-3 py-2 text-xs uppercase tracking-wider" style={{ borderColor: 'var(--rule)' }}>
            Try again
          </button>
        </section>
      )}

      {status === 'ready' && settings && (
        <>
          <section
            aria-label="GitHub source status"
            className="mt-6 grid gap-px border sm:grid-cols-3"
            style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}
          >
            <div className="bg-[color:var(--paper)] px-5 py-4">
              <p className="font-data text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Connection</p>
              <p className="font-ui mt-1 text-sm font-medium">GitHub account linked</p>
              <p className="font-prose mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>Private activity stays owner-only.</p>
            </div>
            <div className="bg-[color:var(--paper)] px-5 py-4">
              <p className="font-data text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Tracking</p>
              <p className="font-ui mt-1 text-sm font-medium">{effectiveTrackedCount} of {repositories.length} repositories</p>
              <p className="font-prose mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>Only selected sources move XP.</p>
            </div>
            <div className="bg-[color:var(--paper)] px-5 py-4">
              <p className="font-data text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Last checkpoint</p>
              <p className="font-ui mt-1 text-sm font-medium">{settings.lastSyncedAt ? new Date(settings.lastSyncedAt).toLocaleDateString() : 'Not synced yet'}</p>
              <p className="font-prose mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>Sync again when you want fresh receipts.</p>
            </div>
          </section>

          {/*
            The identity guard's 409 used to be a sentence in the summary and a
            dead end. Both copies are shown with what they actually hold, and
            every action reports its outcome back in the summary below.
          */}
          {guestConflict && (
            <section
              aria-label="Cloud backup needs a choice"
              className="mt-6 border p-5 sm:p-6"
              style={{ borderColor: 'var(--accent)', background: 'var(--paper-raised)' }}
            >
              <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--accent)' }}>Cloud backup blocked</p>
              <h2 className="font-ui mt-2 text-2xl font-semibold tracking-tight">{guestConflict.view.headline}</h2>
              <p className="font-prose mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                This browser's progress is safe. The account guard stopped the upload because the two copies use different Terrarium identities; nothing is overwritten until you choose.
              </p>

              <div className="mt-5 grid gap-px border sm:grid-cols-2" style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}>
                <GuestIdentitySideCard label="This browser" summary={guestConflict.view.local} />
                {guestConflict.view.cloud ? (
                  <GuestIdentitySideCard label="Account cloud copy" summary={guestConflict.view.cloud} />
                ) : (
                  <div className="bg-[color:var(--paper)] px-5 py-4">
                    <p className="font-data text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Account cloud copy</p>
                    <p className="font-ui mt-1 text-sm font-medium">Not readable right now</p>
                    <p className="font-prose mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>Sync GitHub now again so the account's copy can be read.</p>
                  </div>
                )}
              </div>

              <div className="mt-5 space-y-4">
                {guestConflict.view.actions.map((plan) => (
                  <div
                    key={plan.action}
                    className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-start sm:justify-between"
                    style={{ borderColor: 'var(--rule)' }}
                  >
                    <div className="max-w-2xl">
                      <p className="font-ui text-sm font-medium">
                        {plan.label}
                        {plan.recommended && (
                          <span className="font-data ml-2 text-[10px] uppercase tracking-wider" style={{ color: 'var(--accent)' }}>Recommended</span>
                        )}
                      </p>
                      <p className="font-prose mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>{plan.description}</p>
                    </div>
                    {guestConflictStage === plan.action && plan.requiresConfirmation ? (
                      <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                        <p role="alert" className="font-prose max-w-sm text-xs leading-relaxed sm:text-right" style={{ color: 'var(--ink-muted)' }}>
                          {plan.discardsCloudSnapshot
                            ? "The account's cloud copy is deleted before the new upload. This cannot be undone."
                            : "This browser's progress for this account is replaced by the account's cloud copy."}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void resolveGuestConflict(plan.action, true)}
                            disabled={resolvingGuestConflict !== null}
                            aria-busy={resolvingGuestConflict === plan.action}
                            className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50"
                            style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }}
                          >
                            {resolvingGuestConflict === plan.action ? 'Working…' : 'Confirm and continue'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setGuestConflictStage('idle')}
                            disabled={resolvingGuestConflict !== null}
                            className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50"
                            style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void resolveGuestConflict(plan.action, false)}
                        disabled={!plan.available || resolvingGuestConflict !== null || busy}
                        aria-busy={resolvingGuestConflict === plan.action}
                        className="ui-row font-data shrink-0 border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50"
                        style={{
                          borderColor: plan.recommended ? 'var(--accent)' : 'var(--rule)',
                          color: plan.recommended ? 'var(--ink)' : 'var(--ink-muted)',
                        }}
                      >
                        {resolvingGuestConflict === plan.action ? 'Working…' : plan.label}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {effectiveTrackedCount === 0 && (
            <section className="mt-6 border-l-2 px-5 py-4" style={{ borderColor: 'var(--accent)', background: 'var(--paper-raised)' }}>
              <p className="font-ui text-sm font-medium">Choose a repository before your companion can follow GitHub work.</p>
              <p className="font-prose mt-1 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                Start with one project, or select all available repositories below. The first sync records a clean baseline; it will not award old history.
              </p>
            </section>
          )}

          <section className="mt-6 border p-5 sm:p-6" style={{ borderColor: 'var(--rule)' }}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Source settings</p>
                <h2 className="font-ui mt-2 text-2xl font-semibold tracking-tight">Approved → tracked</h2>
                <p className="font-prose mt-2 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                  Approved means GitHub lets Terrarium read the repository. Tracked means its future activity can move your companion. New repositories start with a clean baseline.
                </p>
              </div>
              <div className="font-data text-xs sm:text-right" style={{ color: 'var(--ink-muted)' }}>
                <div>{repositories.length} approved</div>
                <div>{effectiveTrackedCount} selected</div>
              </div>
            </div>

            <div className="mt-6 grid gap-3 border-t pt-5 sm:grid-cols-2" style={{ borderColor: 'var(--rule)' }}>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" checked={draftAutoPersonal} disabled={sourceControlsDisabled} onChange={(event) => setDraftAutoPersonal(event.target.checked)} className="mt-1" />
                <span><span className="font-ui block">Auto-include personal repos</span><span className="font-prose text-xs" style={{ color: 'var(--ink-muted)' }}>Future personal repositories get a fresh baseline.</span></span>
              </label>
              {organizations.map((organization) => (
                <label key={organization} className="flex items-start gap-3 text-sm">
                  <input type="checkbox" checked={draftOrganizations.includes(organization.toLowerCase())} disabled={sourceControlsDisabled} onChange={() => toggleOrganization(organization.toLowerCase())} className="mt-1" />
                  <span><span className="font-ui block">Auto-include {organization}</span><span className="font-prose text-xs" style={{ color: 'var(--ink-muted)' }}>New repos in this approved organization start fresh.</span></span>
                </label>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" disabled={sourceControlsDisabled} onClick={() => { setDraftTrackedIds(repositories.filter((repo) => repo.canRead && !repo.archived).map((repo) => repo.id)); setDraftExcludedIds([]) }} className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50" style={{ borderColor: 'var(--rule)' }}>
                Select all available
              </button>
              <button type="button" disabled={sourceControlsDisabled} onClick={() => { setDraftTrackedIds([]); setDraftExcludedIds(repositories.filter((repo) => !repo.archived && repo.canRead && (repo.ownerType === 'User' ? draftAutoPersonal : draftOrganizations.includes(repo.ownerLogin.toLowerCase()))).map((repo) => repo.id)) }} className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50" style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}>
                Clear tracking
              </button>
              <button
                type="button"
                onClick={() => void saveSettings()}
                disabled={!settingsChanged || sourceControlsDisabled}
                aria-busy={savingSettings}
                className="ui-row font-ui inline-flex items-center gap-2 border px-3 py-2 text-sm disabled:cursor-wait disabled:opacity-50"
                style={{ borderColor: 'var(--accent)' }}
              >
                {savingSettings && <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--accent)' }} />}
                {savingSettings ? 'Saving choices...' : settingsChanged ? 'Save repository choices' : 'Choices saved'}
              </button>
              {savingSettings && (
                <span role="status" aria-live="polite" className="font-data self-center text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                  Saving repository choices
                </span>
              )}
            </div>

            {/*
              Disconnect lives here, visually separated from the selection
              controls, because it is destructive in a different way: it drops
              the credential and the sync baselines but keeps XP, the
              companion, and these choices. Deleting synced data is a
              different control on the account surface.
            */}
            <div className="mt-6 border-t pt-5" style={{ borderColor: 'var(--rule)' }}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-xl">
                  <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Disconnect</p>
                  <p className="font-prose mt-2 text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                    Stops future tracking and removes the stored GitHub token. Earned XP, your companion, and the repository choices above are kept. Signing out is not disconnecting.
                  </p>
                </div>
                {disconnectStage === 'idle' ? (
                  <button
                    type="button"
                    onClick={() => setDisconnectStage('confirm')}
                    disabled={sourceControlsDisabled || disconnecting}
                    className="ui-row font-data shrink-0 border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50"
                    style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                  >
                    Disconnect GitHub
                  </button>
                ) : (
                  <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                    <p role="alert" className="font-prose max-w-sm text-xs leading-relaxed sm:text-right" style={{ color: 'var(--ink-muted)' }}>
                      Future tracking stops and the token is removed. Earned XP and your repository choices stay. Deleting synced data remains a separate action.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void disconnectGitHub()}
                        disabled={disconnecting}
                        aria-busy={disconnecting}
                        className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50"
                        style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }}
                      >
                        {disconnecting ? 'Disconnecting…' : 'Confirm disconnect'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisconnectStage('idle')}
                        disabled={disconnecting}
                        className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50"
                        style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section aria-label="Repository browser" className="mt-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Repository browser</p>
                <h2 className="font-ui mt-2 text-2xl font-semibold tracking-tight">Find a source</h2>
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                {listFreshnessLabel && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="font-data text-xs"
                    style={{ color: listStale ? 'var(--accent)' : 'var(--ink-muted)' }}
                  >
                    {listFreshnessLabel}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void loadRepositories({ refresh: true })}
                  disabled={listControlsDisabled}
                  aria-busy={refreshingList}
                  className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider disabled:cursor-wait disabled:opacity-50"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                >
                  {refreshingList ? 'Refreshing…' : 'Refresh list'}
                </button>
                <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
                  {filteredRepositories.length} of {repositories.length} visible
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
              <form role="search" aria-label="Find a repository" onSubmit={(event) => event.preventDefault()} className="relative min-w-0 flex-1">
                <label htmlFor="github-repository-search" className="sr-only">Find a repository or owner</label>
                <input
                  id="github-repository-search"
                  type="search"
                  value={repositoryQuery}
                  onChange={(event) => { setRepositoryQuery(event.target.value); setCollapsedOwners([]) }}
                  placeholder="Find a repository or owner"
                  className="font-ui w-full border bg-[color:var(--paper)] px-3 py-2.5 pr-16 text-sm"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                />
                {repositoryQuery && (
                  <button
                    type="button"
                    onClick={() => { setRepositoryQuery(''); setCollapsedOwners([]) }}
                    className="ui-row font-data absolute right-1 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] uppercase tracking-wider"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    Clear
                  </button>
                )}
              </form>

              <div role="group" aria-label="Repository source filter" className="flex flex-wrap gap-2">
                {([
                  ['all', 'All sources'],
                  ['user', 'Individual owners'],
                  ['organization', 'Organizations'],
                ] as const).map(([scope, label]) => (
                  <button
                    key={scope}
                    type="button"
                    aria-pressed={repositoryScope === scope}
                    data-active={repositoryScope === scope}
                    onClick={() => { setRepositoryScope(scope); setCollapsedOwners([]) }}
                    className="ui-segment font-data border px-3 py-2 text-[10px] uppercase tracking-wider"
                    style={{ borderColor: repositoryScope === scope ? 'var(--accent)' : 'var(--rule)', color: repositoryScope === scope ? 'var(--ink)' : 'var(--ink-muted)' }}
                  >
                    {label}
                    <span className="ml-1" style={{ color: 'var(--ink-muted)' }}>
                      {scope === 'all' ? repositories.length : scope === 'user' ? userRepositoryCount : organizationRepositoryCount}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {repositoryFiltersActive && (
              <p role="status" aria-live="polite" className="font-data mt-3 text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                Showing {filteredRepositories.length} matching {filteredRepositories.length === 1 ? 'source' : 'sources'}
              </p>
            )}
          </section>

          <section className="mt-8 space-y-8">
            {groupedRepositories.map(([owner, ownerRepositories]) => {
              const ownerKey = repositoryOwnerId(owner)
              const totalOwnerRepositories = repositoryCountsByOwner.get(owner) ?? ownerRepositories.length
              const collapsed = collapsedOwners.includes(owner)
              return (
                <section key={owner} aria-labelledby={`github-owner-${ownerKey}`}>
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    aria-controls={`github-owner-content-${ownerKey}`}
                    onClick={() => toggleOwner(owner)}
                    className="ui-row flex w-full items-center justify-between gap-4 border-l-2 px-4 py-3 text-left"
                    style={{ borderColor: 'var(--accent)' }}
                  >
                    <span className="min-w-0">
                      <span id={`github-owner-${ownerKey}`} className="font-data block truncate text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>{owner}</span>
                      <span className="font-prose mt-1 block text-sm" style={{ color: 'var(--ink-muted)' }}>Repository sources</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {ownerRepositories.length === totalOwnerRepositories ? `${totalOwnerRepositories} repos` : `${ownerRepositories.length} of ${totalOwnerRepositories}`}
                      </span>
                      <span aria-hidden="true" className="font-data text-lg leading-none" style={{ color: 'var(--accent)' }}>{collapsed ? '+' : '−'}</span>
                    </span>
                  </button>
                  <div id={`github-owner-content-${ownerKey}`} hidden={collapsed} className="mt-3 grid gap-2">
                      {ownerRepositories.map((repository) => {
                        const autoTracked = repository.ownerType === 'User'
                          ? draftAutoPersonal
                          : draftOrganizations.includes(repository.ownerLogin.toLowerCase())
                        const checked = draftTrackedIds.includes(repository.id) || (autoTracked && !draftExcludedIds.includes(repository.id))
                        const disabled = repository.archived || !repository.canRead
                        return (
                          <label
                            key={repository.id}
                            data-active={checked}
                            className="ui-row github-source-tile grid min-h-16 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-4 sm:p-4"
                            style={{ opacity: disabled || sourceControlsDisabled ? 0.55 : 1 }}
                          >
                            <input type="checkbox" checked={checked} disabled={disabled || sourceControlsDisabled} onChange={() => toggleTracked(repository)} className="shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="font-ui text-sm font-medium">{repository.name}</span>
                                <span className="font-data text-[10px] uppercase tracking-wider" style={{ color: checked ? 'var(--accent)' : 'var(--ink-muted)' }}>{checked ? 'tracking' : 'available'}</span>
                                <span className="font-data text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>{repository.private ? 'private' : 'public'}</span>
                                {repository.archived && <span className="font-data text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>archived</span>}
                              </span>
                              <span className="font-data mt-1 block truncate text-xs" style={{ color: 'var(--ink-muted)' }}>{repository.fullName}</span>
                            </span>
                            <span className="font-data hidden shrink-0 text-right text-[10px] uppercase tracking-wider sm:block" style={{ color: repository.canRead ? 'var(--ink-muted)' : 'var(--accent)' }}>
                              {repository.canRead ? 'readable' : 'access paused'}
                            </span>
                          </label>
                        )
                      })}
                  </div>
                </section>
              )
            })}
            {repositories.length > 0 && filteredRepositories.length === 0 && (
              <section className="border-l-2 px-5 py-4" style={{ borderColor: 'var(--accent)', background: 'var(--paper-raised)' }}>
                <p className="font-ui text-sm font-medium">No repositories match this view.</p>
                <p className="font-prose mt-1 text-sm" style={{ color: 'var(--ink-muted)' }}>Try a different name or source filter.</p>
                <button type="button" onClick={() => { setRepositoryQuery(''); setRepositoryScope('all'); setCollapsedOwners([]) }} className="ui-row font-data mt-4 border px-3 py-2 text-xs uppercase tracking-wider" style={{ borderColor: 'var(--rule)' }}>
                  Show all repositories
                </button>
              </section>
            )}
            {repositories.length === 0 && (
              <p className="font-prose border p-5 text-sm" style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}>
                GitHub returned no repositories this account can read.
              </p>
            )}
          </section>

          {message && <p role="alert" className="font-ui mt-5 text-sm" style={{ color: 'var(--accent)' }}>{message}</p>}
          {lastSyncSummary && <p role="status" aria-live="polite" className="font-prose mt-5 border-l-2 pl-4 text-sm leading-relaxed" style={{ borderColor: 'var(--accent)', color: 'var(--ink-muted)' }}>{lastSyncSummary}</p>}
          {settings.lastSyncedAt && !lastSyncSummary && <p className="font-data mt-5 text-xs" style={{ color: 'var(--ink-muted)' }}>Last checked {new Date(settings.lastSyncedAt).toLocaleString()}</p>}
        </>
      )}

      {/*
        The progression surface belongs to the account, not to the connection.
        After a disconnect the credential is gone but the earned XP, companion,
        and activity history stay, so they keep rendering.
      */}
      {(status === 'disconnected' || (status === 'ready' && settings)) && productState && (
        <div className="mt-8">
          <EncounterReveal state={productState} revealedIds={revealedDraws} onReveal={dismissDraw} onMakeActive={makeActive} />
          <ProductActivityPanel state={productState} sourceLabel="Verified GitHub activity" />
          <GitHubRewardGuide state={productState} />
          <CompanionSwitcher state={productState} onSwitch={makeActive} />
        </div>
      )}
    </div>
  )
}
