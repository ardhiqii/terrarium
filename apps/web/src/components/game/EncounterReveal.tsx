'use client'

import { displayCompanionName } from './display-name'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import type { ProductState } from '@/lib/game/product-state'

export interface EncounterRevealProps {
  state: ProductState
  /** Persist one revealed draw id so it stays dismissed across reloads. */
  revealedIds: readonly string[]
  onReveal: (drawId: string) => void
  /** Callback to make a newly drawn companion active. */
  onMakeActive: (companionId: string) => void
}

/**
 * Surfaces the encounter loop that the engine already runs transparently in
 * `applyProductEvents`. New `PersistedEncounterDraw`s are persisted before
 * display, so a refresh cannot reroll them; this component shows a reveal
 * card for each draw the user has not acknowledged yet, then lets them make
 * the result active (duplicates award family Essence, not XP).
 */
export function EncounterReveal({
  state,
  revealedIds,
  onReveal,
  onMakeActive,
}: EncounterRevealProps) {
  const pending = state.encounters.draws.filter(
    (draw) => !revealedIds.includes(draw.id),
  )

  if (pending.length === 0) return null

  return (
    <section
      className="mb-4 p-5"
      style={{ border: '1px solid var(--accent)', background: 'var(--paper-raised)' }}
      aria-live="polite"
    >
      <p className="font-data text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--accent)' }}>
        You encountered something
      </p>
      <div className="flex flex-col gap-3">
        {pending.map((draw) => {
          const definition = PROTOTYPE_COMPANION_CATALOG.get(draw.selectedCompanionId)
          return (
            <div key={draw.id} className="flex flex-col gap-2">
              <p className="font-ui text-lg font-semibold">
                {definition?.name ?? displayCompanionName(draw.selectedCompanionId)}
              </p>
              <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
                {draw.isDuplicate
                  ? `Duplicate · +${draw.essenceAwarded} Essence for this family`
                  : 'New companion added to your collection'}
              </p>
              <div className="flex flex-wrap gap-2">
                {!draw.isDuplicate && (
                  <button
                    type="button"
                    onClick={() => onMakeActive(draw.selectedCompanionId)}
                    className="ui-row font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
                    style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
                  >
                    Make active
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onReveal(draw.id)}
                  className="ui-row font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
