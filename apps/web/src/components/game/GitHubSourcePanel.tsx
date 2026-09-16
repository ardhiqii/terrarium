'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  ensureBrowserGuestProfile,
  loadBrowserEncounters,
  loadBrowserLedger,
  loadRevealedDraws,
  loadVerifiedEventProofs,
  saveBrowserEncounters,
  saveBrowserLedger,
  saveRevealedDraws,
  saveVerifiedEventProofs,
} from '@/lib/game/product-browser-storage'
import { saveGuestProfile } from '@/lib/game/guest-profile'
import {
  buildProductSnapshot,
  deserializeProductSnapshot,
  mergeProductSnapshots,
  restoreProductStateFromSnapshot,
} from '@/lib/sync/product-snapshot'
import { productEventId } from '@/lib/sync/product-event-id'
import { filterGithubRepositories, type RepositoryScope } from '@/lib/sync/github-repository-browser'
import type { GithubRepository } from '@/lib/sync/github-repositories'
import { CompanionSwitcher } from './CompanionSwitcher'
import { EncounterReveal } from './EncounterReveal'
import { ProductActivityPanel } from './ProductActivityPanel'
import { GitHubRewardGuide } from './GitHubRewardGuide'

interface GithubSettings {
  trackedRepositoryIds: string[]
  excludedRepositoryIds: string[]
  autoIncludePersonal: boolean
  autoIncludeOrganizations: string[]
  lastSyncedAt: string | null
}

interface RepositoryResponse {
  githubId: number
  repositories: GithubRepository[]
  settings: GithubSettings
  approvedRepositoryCount: number
  trackedRepositoryCount: number
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'signed-out' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null)
  const [repositoryQuery, setRepositoryQuery] = useState('')
  const [repositoryScope, setRepositoryScope] = useState<RepositoryScope>('all')
  const [collapsedOwners, setCollapsedOwners] = useState<string[]>([])

  const hydrateState = useCallback(() => {
    const state = browserState()
    setProductState(state)
    setRevealedDraws(loadRevealedDraws(browserProductStorage()))
    return state
  }, [])

  const loadRepositories = useCallback(async () => {
    setStatus('loading')
    setMessage('')
    try {
      const response = await fetch('/api/github/repositories', { cache: 'no-store' })
      const body = await responseBody(response)
      if (response.status === 401) {
        setStatus('signed-out')
        setMessage(errorMessage(body, 'Sign in with GitHub to connect a repository.'))
        return
      }
      if (!response.ok) throw new Error(errorMessage(body, 'Repositories could not be loaded.'))
      const data = body as unknown as RepositoryResponse
      setRepositories(Array.isArray(data.repositories) ? data.repositories : [])
      setSettings(data.settings)
      setDraftTrackedIds(data.settings.trackedRepositoryIds)
      setDraftExcludedIds(data.settings.excludedRepositoryIds)
      setDraftAutoPersonal(data.settings.autoIncludePersonal)
      setDraftOrganizations(data.settings.autoIncludeOrganizations)
      const namespace = `github-${data.githubId}`
      setAccountNamespace(namespace)
      const localState = browserState(namespace)
      const hydrated = await restoreCloudProductState(localState, namespace)
      setProductState(hydrated.state)
      if (hydrated.message) setMessage(hydrated.message)
      setRevealedDraws(loadRevealedDraws(browserProductStorage(), namespace))
      setStatus('ready')
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : 'Repositories could not be loaded.')
    }
  }, [])

  useEffect(() => {
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
  const sourceControlsDisabled = savingSettings || busy

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
      setRepositories(data.repositories)
      setSettings(data.settings)
      setDraftTrackedIds(data.settings.trackedRepositoryIds)
      setDraftExcludedIds(data.settings.excludedRepositoryIds)
      setDraftAutoPersonal(data.settings.autoIncludePersonal)
      setDraftOrganizations(data.settings.autoIncludeOrganizations)
      return true
    } catch {
      setMessage('Repository settings could not be saved. Try again.')
      return false
    } finally {
      setSavingSettings(false)
    }
  }, [draftAutoPersonal, draftOrganizations, draftTrackedIds, savingSettings])

  const syncNow = useCallback(async () => {
    if (!productState) return
    setBusy(true)
    setMessage('')
    try {
      if (settingsChanged && !(await saveSettings())) return
      const response = await fetch('/api/github/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeCompanionId: productState.profile.activeCompanionId }),
      })
      const body = await responseBody(response)
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
      const snapshotHeaders: HeadersInit = { 'Content-Type': 'application/json' }
      if (checkpoint) snapshotHeaders['x-github-sync-checkpoint'] = checkpoint
      const snapshotResponse = await fetch('/api/sync/product', {
        method: 'POST',
        headers: snapshotHeaders,
        body: JSON.stringify(uploadSnapshot),
      })
      const snapshotBody = await responseBody(snapshotResponse)
      const count = typeof body.repositoryCount === 'number' ? body.repositoryCount : 0
      const eventCount = Math.max(0, next.ledger.events.length - productState.ledger.events.length)
      const baselineCount = Array.isArray(body.newBaselineRepositoryIds) ? body.newBaselineRepositoryIds.length : 0
      const skippedCount = typeof body.skippedRepositoryCount === 'number' ? body.skippedRepositoryCount : 0
      const limitNote = skippedCount > 0 ? ` ${skippedCount} more will stay pending; narrow the selection to sync them.` : ''
      const cloudNote = snapshotResponse.ok
        ? ' Condition saved.'
        : ` Local progress is safe, but cloud condition was not saved: ${errorMessage(snapshotBody, 'try again later')}`
      if (body.kind === 'baseline') {
        setLastSyncSummary(`Baseline recorded for ${baselineCount} ${baselineCount === 1 ? 'repository' : 'repositories'} · no old history awarded.${limitNote}${cloudNote}`)
      } else if (body.kind === 'partial' || body.syncStatus === 'partial') {
        setLastSyncSummary(`Checked ${count} tracked ${count === 1 ? 'repository' : 'repositories'} · ${eventCount} new verified events. Some activity could not be read completely; try again to catch up.${limitNote}${cloudNote}`)
      } else {
        setLastSyncSummary(`Checked ${count} tracked ${count === 1 ? 'repository' : 'repositories'} · ${eventCount} new verified events.${limitNote}${cloudNote}`)
      }
      await loadRepositories()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'GitHub activity could not be synced.')
    } finally {
      setBusy(false)
    }
  }, [accountNamespace, loadRepositories, productState, saveSettings, settingsChanged])

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
            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={sourceControlsDisabled || !productState}
              className="ui-row font-ui shrink-0 border px-4 py-3 text-sm font-medium disabled:cursor-wait disabled:opacity-50"
              style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }}
            >
              {busy ? 'Syncing…' : 'Sync GitHub now'}
            </button>
          )}
        </div>
      </section>

      {status === 'loading' && (
        <p className="font-data border-b py-6 text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
          Checking GitHub access…
        </p>
      )}

      {status === 'signed-out' && (
        <section className="mt-6 border p-6" style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}>
          <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Not connected</p>
          <h2 className="font-ui mt-2 text-2xl font-semibold tracking-tight">Connect GitHub to choose a source.</h2>
          <p className="font-prose mt-3 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Terrarium asks GitHub for repository access so it can list personal and organization repositories. You approve the list; only tracked repositories affect progression.
          </p>
          <a href="/api/auth/login" className="ui-row font-ui mt-5 inline-block border px-4 py-2 text-sm" style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}>
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
          </section>

          <section aria-label="Repository browser" className="mt-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Repository browser</p>
                <h2 className="font-ui mt-2 text-2xl font-semibold tracking-tight">Find a source</h2>
              </div>
              <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
                {filteredRepositories.length} of {repositories.length} visible
              </p>
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

          {productState && (
            <div className="mt-8">
              <EncounterReveal state={productState} revealedIds={revealedDraws} onReveal={dismissDraw} onMakeActive={makeActive} />
              <ProductActivityPanel state={productState} sourceLabel="Verified GitHub activity" />
              <GitHubRewardGuide state={productState} />
              <CompanionSwitcher state={productState} onSwitch={makeActive} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
