'use client'

import { DEFAULT_ENCOUNTER_CONFIG } from '@/lib/game/encounters'
import type { ProductState } from '@/lib/game/product-state'

export interface ProductActivityPanelProps {
  state: ProductState
  sourceLabel?: string
}

function percentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.min(1, Math.max(0, value)) * 100)
}

function displayCompanionName(companionId: string): string {
  const name = companionId.replace(/[-_]+/g, ' ').trim()
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Unnamed companion'
}

function evidenceWording(
  sourceLabel: string | undefined,
  hasLocal: boolean,
  hasVerified: boolean,
): string {
  const subject = sourceLabel ? `${sourceLabel} activity` : 'Activity'

  if (hasLocal && hasVerified) {
    return `${subject} includes local activity that is not independently verified and verified activity from a connected source.`
  }
  if (hasVerified) return `${subject} is verified from a connected source.`
  if (hasLocal) return `${subject} is local and not independently verified.`
  return `${subject} has no recorded events yet.`
}

export function ProductActivityPanel({
  state,
  sourceLabel,
}: ProductActivityPanelProps) {
  const activeCompanion = state.activeCompanion
  const progression = activeCompanion?.progression ?? null
  const xpProgress = percentage(progression?.progress ?? 0)
  const encounterThreshold = DEFAULT_ENCOUNTER_CONFIG.threshold
  const encounterProgress = percentage(state.encounters.meter / encounterThreshold)
  const normalizedSourceLabel = sourceLabel?.trim() || undefined
  const hasLocalActivity = state.ledger.events.some((event) => event.provenance === 'local')
  const hasVerifiedActivity = state.ledger.events.some(
    (event) => event.provenance === 'verified',
  )
  const companionName = activeCompanion
    ? displayCompanionName(activeCompanion.companionId)
    : 'No active companion'
  const progressionName = progression?.step.name ?? 'Not started'

  return (
    <section
      aria-labelledby="product-activity-title"
      className="p-5 sm:p-6"
      style={{
        background: 'var(--paper-raised)',
        border: '1px solid var(--rule)',
      }}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <p
            className="font-data text-xs uppercase tracking-widest"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            {normalizedSourceLabel ?? 'Product activity'}
          </p>
          <h2
            id="product-activity-title"
            className="font-ui mt-1 text-2xl font-semibold tracking-tighter leading-[1.05]"
          >
            {companionName}
          </h2>
        </div>
        <p className="font-data text-xs sm:text-right" style={{ color: 'var(--ink-muted)' }}>
          Active companion
        </p>
      </div>

      <dl className="mt-6 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Progression
          </dt>
          <dd className="font-ui mt-1 text-sm font-medium">{progressionName}</dd>
        </div>
        <div>
          <dt className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            XP
          </dt>
          <dd className="font-data mt-1 text-sm">
            {(activeCompanion?.xp ?? 0).toLocaleString()} xp
          </dd>
        </div>
        <div>
          <dt className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Collection
          </dt>
          <dd className="font-data mt-1 text-sm">
            {state.profile.collection.length.toLocaleString()} companions
          </dd>
        </div>
      </dl>

      <div className="mt-6">
        <div className="font-data flex items-baseline justify-between gap-3 text-xs">
          <span style={{ color: 'var(--ink-muted)' }}>Progress to next form</span>
          <span style={{ color: 'var(--ink-muted)' }}>
            {progression?.xpForNextStep === null
              ? 'complete'
              : progression
                ? `${progression.xpIntoStep} / ${progression.xpForNextStep} xp`
                : 'not started'}
          </span>
        </div>
        <div
          className="mt-2 h-2 w-full"
          style={{ background: 'var(--rule)' }}
          role="progressbar"
          aria-label="Progress to next form"
          aria-valuenow={xpProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${xpProgress}%`}
        >
          <div className="h-full" style={{ width: `${xpProgress}%`, background: 'var(--accent)' }} />
        </div>
        <p className="font-data mt-1.5 text-right text-xs" style={{ color: 'var(--ink-muted)' }}>
          {xpProgress}%
        </p>
      </div>

      <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
        <div className="font-data flex items-baseline justify-between gap-3 text-xs">
          <span style={{ color: 'var(--ink-muted)' }}>Encounter progress</span>
          <span style={{ color: 'var(--ink-muted)' }}>
            {state.encounters.meter} / {encounterThreshold}
          </span>
        </div>
        <div
          className="mt-2 h-1.5 w-full"
          style={{ background: 'var(--rule)' }}
          role="progressbar"
          aria-label="Encounter progress"
          aria-valuenow={encounterProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${encounterProgress}%`}
        >
          <div
            className="h-full"
            style={{ width: `${encounterProgress}%`, background: 'var(--accent)' }}
          />
        </div>
      </div>

      <p className="font-prose mt-5 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        {evidenceWording(normalizedSourceLabel, hasLocalActivity, hasVerifiedActivity)}
      </p>
    </section>
  )
}
