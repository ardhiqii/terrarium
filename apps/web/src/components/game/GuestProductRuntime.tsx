'use client'

import type { ProductState } from '@/lib/game/product-state'
import { CompanionRuntimeProvider, CompanionRuntimeStatus, useCompanionRuntime } from './CompanionRuntimeProvider'
import { ProductActivityPanel } from './ProductActivityPanel'
import { EncounterReveal } from './EncounterReveal'
import { CompanionSwitcher } from './CompanionSwitcher'

function GuestProductPanels({ accountScoped }: { accountScoped: boolean }) {
  const {
    state,
    revealedDraws,
    dismissDraw,
    switchCompanion,
  } = useCompanionRuntime()

  if (!state) return <CompanionRuntimeStatus />

  if (accountScoped) {
    return (
      <>
        <CompanionRuntimeStatus className="mb-3" />
        <ProductActivityPanel state={state} sourceLabel="Account companion" />
      </>
    )
  }

  return (
    <>
      <CompanionRuntimeStatus className="mb-3" />
      <EncounterReveal
        state={state}
        revealedIds={revealedDraws}
        onReveal={dismissDraw}
        onMakeActive={switchCompanion}
      />
      <ProductActivityPanel state={state} sourceLabel="Local companion" />
      <CompanionSwitcher state={state} onSwitch={switchCompanion} />
    </>
  )
}

/**
 * Shared browser runtime boundary. Source listeners, namespaced storage,
 * migration-safe state composition, and active switching live in
 * CompanionRuntimeProvider so other surfaces can render the same projection
 * without a second ledger.
 */
export interface GuestProductRuntimeProps {
  initialState?: ProductState | null
  accountScoped?: boolean
  namespace?: string
}

export function GuestProductRuntime({
  initialState = null,
  accountScoped = false,
  namespace,
}: GuestProductRuntimeProps) {
  return (
    <CompanionRuntimeProvider
      initialState={initialState}
      namespace={namespace}
      ownsInitialState={accountScoped}
      persistLocal
    >
      <GuestProductPanels accountScoped={accountScoped} />
    </CompanionRuntimeProvider>
  )
}
