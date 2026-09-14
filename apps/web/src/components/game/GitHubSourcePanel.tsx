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
  saveBrowserEncounters,
  saveBrowserLedger,
  saveRevealedDraws,
} from '@/lib/game/product-browser-storage'
import { saveGuestProfile } from '@/lib/game/guest-profile'
import { buildProductSnapshot } from '@/lib/sync/product-snapshot'
import { CompanionSwitcher } from './CompanionSwitcher'
import { EncounterReveal } from './EncounterReveal'
import { ProductActivityPanel } from './ProductActivityPanel'
import { GitHubRewardGuide } from './GitHubRewardGuide'

interface GithubRepository {
  id: string
  name: string
  fullName: string
  ownerLogin: string
  ownerType: 'User' | 'Organization'
  private: boolean
  visibility: string
  defaultBranch: string | null
  archived: boolean
  canRead: boolean
}

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

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}))
  return isRecord(body) ? body : {}
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === 'string' ? body.error : fallback
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
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null)

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
      setProductState(browserState(namespace))
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
  const groupedRepositories = useMemo(() => {
    const groups = new Map<string, GithubRepository[]>()
    for (const repository of repositories) {
      const current = groups.get(repository.ownerLogin) ?? []
      current.push(repository)
      groups.set(repository.ownerLogin, current)
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [repositories])
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

  const saveSettings = useCallback(async (): Promise<boolean> => {
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
  }, [draftAutoPersonal, draftOrganizations, draftTrackedIds])

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
      const incoming = Array.isArray(body.events)
        ? body.events.map(parseEvent).filter((event): event is NormalizedEvent => event !== null)
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

      const snapshotResponse = await fetch('/api/sync/product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildProductSnapshot(next)),
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
              disabled={busy || !productState}
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
                <input type="checkbox" checked={draftAutoPersonal} onChange={(event) => setDraftAutoPersonal(event.target.checked)} className="mt-1" />
                <span><span className="font-ui block">Auto-include personal repos</span><span className="font-prose text-xs" style={{ color: 'var(--ink-muted)' }}>Future personal repositories get a fresh baseline.</span></span>
              </label>
              {organizations.map((organization) => (
                <label key={organization} className="flex items-start gap-3 text-sm">
                  <input type="checkbox" checked={draftOrganizations.includes(organization.toLowerCase())} onChange={() => toggleOrganization(organization.toLowerCase())} className="mt-1" />
                  <span><span className="font-ui block">Auto-include {organization}</span><span className="font-prose text-xs" style={{ color: 'var(--ink-muted)' }}>New repos in this approved organization start fresh.</span></span>
                </label>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" onClick={() => { setDraftTrackedIds(repositories.filter((repo) => repo.canRead && !repo.archived).map((repo) => repo.id)); setDraftExcludedIds([]) }} className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider" style={{ borderColor: 'var(--rule)' }}>
                Select all available
              </button>
              <button type="button" onClick={() => { setDraftTrackedIds([]); setDraftExcludedIds(repositories.filter((repo) => !repo.archived && repo.canRead && (repo.ownerType === 'User' ? draftAutoPersonal : draftOrganizations.includes(repo.ownerLogin.toLowerCase()))).map((repo) => repo.id)) }} className="ui-row font-data border px-3 py-2 text-xs uppercase tracking-wider" style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}>
                Clear tracking
              </button>
              <button type="button" onClick={() => void saveSettings()} disabled={!settingsChanged || busy} className="ui-row font-ui border px-3 py-2 text-sm disabled:opacity-50" style={{ borderColor: 'var(--accent)' }}>
                {settingsChanged ? 'Save repository choices' : 'Choices saved'}
              </button>
            </div>
          </section>

          <section className="mt-6 grid gap-4">
            {groupedRepositories.map(([owner, ownerRepositories]) => (
              <div key={owner} className="border" style={{ borderColor: 'var(--rule)' }}>
                <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}>
                  <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>{owner}</p>
                  <span className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>{ownerRepositories.length} repos</span>
                </div>
                <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                  {ownerRepositories.map((repository) => {
                    const autoTracked = repository.ownerType === 'User'
                      ? draftAutoPersonal
                      : draftOrganizations.includes(repository.ownerLogin.toLowerCase())
                    const checked = draftTrackedIds.includes(repository.id) || (autoTracked && !draftExcludedIds.includes(repository.id))
                    const disabled = repository.archived || !repository.canRead
                    return (
                      <label key={repository.id} className="flex items-start gap-3 px-5 py-4" style={{ opacity: disabled ? 0.55 : 1 }}>
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleTracked(repository)} className="mt-1" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-ui text-sm font-medium">{repository.name}</span>
                            <span className="font-data text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>{repository.private ? 'private' : 'public'}</span>
                            {repository.archived && <span className="font-data text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>archived</span>}
                          </span>
                          <span className="font-data mt-1 block truncate text-xs" style={{ color: 'var(--ink-muted)' }}>{repository.fullName} · {repository.canRead ? 'readable' : 'access paused'}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
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
