'use client'

import type { ProductState } from '@/lib/game/product-state'
import { displayCompanionName } from './display-name'

export interface CompanionSwitcherProps {
  state: ProductState
  onSwitch: (companionId: string) => void
}

/**
 * Lists every companion in the collection and lets the user make any of them
 * the active one. XP is per companion and is never moved or deleted when you
 * switch (enforced by the engine). Only shown when there is more than one.
 */
export function CompanionSwitcher({ state, onSwitch }: CompanionSwitcherProps) {
  if (state.companions.length <= 1) return null

  return (
    <section
      className="mt-5 border-t pt-4"
      style={{ borderColor: 'var(--rule)' }}
      aria-labelledby="companion-switcher-title"
    >
      <p
        id="companion-switcher-title"
        className="font-data text-xs uppercase tracking-widest mb-2"
        style={{ color: 'var(--ink-muted)' }}
      >
        Your collection
      </p>
      <div className="flex flex-wrap gap-2">
        {state.companions.map((companion) => {
          const isActive = companion.companionId === state.activeCompanion?.companionId
          return (
            <button
              key={companion.companionId}
              type="button"
              onClick={() => !isActive && onSwitch(companion.companionId)}
              aria-pressed={isActive}
              disabled={isActive}
              className="ui-row font-data text-xs px-3 py-2 border transition-opacity hover:opacity-80"
              style={{
                borderColor: isActive ? 'var(--accent)' : 'var(--rule)',
                color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                background: isActive ? 'var(--paper-raised)' : 'var(--paper)',
                cursor: isActive ? 'default' : 'pointer',
              }}
            >
              {displayCompanionName(companion.companionId)}
              {isActive ? ' · active' : ` · ${companion.xp} xp`}
            </button>
          )
        })}
      </div>
    </section>
  )
}
