'use client'

import { useMemo, useState } from 'react'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { accountNamespaceForGithubId } from '@/lib/game/github-account-scope'
import { resolveCompanionAsset } from '@/lib/game/companion-asset-resolver'
import type { ProductState } from '@/lib/game/product-state'
import {
  CompanionRuntimeProvider,
  CompanionRuntimeStatus,
  useCompanionRuntime,
} from './CompanionRuntimeProvider'
import CompanionSprite from './CompanionSprite'

interface CompanionCollectionProps {
  initialState?: ProductState | null
  signedIn: boolean
  accountId?: number
}

function progressText(
  progression: NonNullable<ProductState['activeCompanion']>['progression'] | null,
): string {
  if (!progression) return 'Progression unavailable'
  if (progression.xpForNextStep === null) return 'Mastery reached'
  return `${progression.xpIntoStep.toLocaleString()} / ${progression.xpForNextStep.toLocaleString()} XP to ${progression.nextForm?.name ?? 'next form'}`
}

function CompanionRoster({
  signedIn,
  accountId,
}: Omit<CompanionCollectionProps, 'initialState'>) {
  const {
    state,
    status,
    switchCompanion,
  } = useCompanionRuntime()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const owned = useMemo(() => {
    if (!state) return []
    const ownedIds = new Set(state.profile.collection.map((reference) => reference.companionId))
    const order = new Map<string, number>()
    state.profile.collection.forEach((reference, index) => {
      if (!order.has(reference.companionId)) order.set(reference.companionId, index)
    })
    return state.companions
      .filter((companion) => ownedIds.has(companion.companionId))
      .sort((left, right) => {
        const leftActive = left.companionId === state.profile.activeCompanionId ? 0 : 1
        const rightActive = right.companionId === state.profile.activeCompanionId ? 0 : 1
        return leftActive - rightActive || (order.get(left.companionId) ?? 0) - (order.get(right.companionId) ?? 0)
      })
  }, [state])

  const activate = async (companionId: string) => {
    if (!state || companionId === state.profile.activeCompanionId || pendingId) return
    setFeedback(null)
    setPendingId(companionId)
    try {
      if (signedIn) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (accountId !== undefined) headers['x-terrarium-github-id'] = String(accountId)
        const response = await fetch('/api/sync/product/activate', {
          method: 'POST',
          headers,
          body: JSON.stringify({ companionId }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(body?.error ?? 'Activation could not be saved.')
        }
      }
      switchCompanion(companionId)
      setFeedback('Active companion updated.')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Activation could not be saved.')
    } finally {
      setPendingId(null)
    }
  }

  if (!state || status === 'loading') {
    return (
      <section className="border p-6" style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }} aria-busy="true">
        <CompanionRuntimeStatus />
      </section>
    )
  }

  return (
    <section aria-labelledby="owned-companions-title">
      <CompanionRuntimeStatus className="mb-3" />
      <div className="flex flex-wrap items-end justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--rule)' }}>
        <div>
          <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>Owned roster</p>
          <h2 id="owned-companions-title" className="font-ui mt-1 text-2xl font-semibold tracking-tight">Your companions</h2>
        </div>
        <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
          {owned.length} {owned.length === 1 ? 'companion' : 'companions'} · {state.encounters.meter} / 100 encounter progress
        </p>
      </div>

      {feedback && (
        <p className="font-data mt-4 text-xs" role="status" style={{ color: 'var(--accent)' }}>{feedback}</p>
      )}

      <div className="mt-6 divide-y" style={{ borderColor: 'var(--rule)' }}>
        {owned.map((companion) => {
          const definition = PROTOTYPE_COMPANION_CATALOG.get(companion.companionId)
          const progression = companion.progression
          const descriptor = definition && progression
            ? resolveCompanionAsset(definition, progression.form.id)
            : null
          const active = companion.companionId === state.profile.activeCompanionId
          const references = state.profile.collection.filter((reference) => reference.companionId === companion.companionId)
          return (
            <article key={companion.companionId} className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-5">
                {/* Alignment slot only: no fill, so the sprite sits bare on the page. */}
                <div data-companion-slot className="flex h-24 w-24 shrink-0 items-center justify-center">
                  {descriptor && <CompanionSprite descriptor={descriptor} scale={2} alt={`${progression?.form.name ?? definition?.name ?? 'Companion'} specimen`} />}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-ui text-xl font-semibold tracking-tight">{progression?.form.name ?? definition?.name ?? companion.companionId}</h3>
                    {active && <span className="font-data border px-2 py-1 text-[10px] uppercase tracking-widest" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>Active</span>}
                  </div>
                  <p className="font-data mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {definition?.name ?? 'Owned companion'} · {references.length} {references.length === 1 ? 'reference' : 'references'}
                  </p>
                  <p className="font-data mt-3 text-sm">{companion.xp.toLocaleString()} XP</p>
                  <p className="font-prose mt-1 text-sm" style={{ color: 'var(--ink-muted)' }}>{progressText(progression)}</p>
                </div>
              </div>
              {!active && (
                <button
                  type="button"
                  onClick={() => void activate(companion.companionId)}
                  disabled={pendingId !== null}
                  className="font-data shrink-0 border px-4 py-2 text-xs uppercase tracking-widest transition-opacity hover:opacity-70 disabled:opacity-50"
                  style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
                >
                  {pendingId === companion.companionId ? 'Activating…' : 'Activate'}
                </button>
              )}
            </article>
          )
        })}
      </div>

      <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
        <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          XP belongs to the active companion. Encounter progress is separate and helps discover additional companions; duplicate encounters award Essence rather than moving XP.
        </p>
      </div>
    </section>
  )
}

export function CompanionCollection({
  initialState = null,
  signedIn,
  accountId,
}: CompanionCollectionProps) {
  const namespace = signedIn && accountId !== undefined
    ? accountNamespaceForGithubId(accountId)
    : undefined

  return (
    <CompanionRuntimeProvider
      initialState={initialState}
      namespace={namespace}
      ownsInitialState={signedIn}
      persistLocal
    >
      <CompanionRoster signedIn={signedIn} accountId={accountId} />
    </CompanionRuntimeProvider>
  )
}
