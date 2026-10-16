'use client'

import Link from 'next/link'
import { CompanionRuntimeProvider, CompanionRuntimeStatus, useCompanionRuntime } from './CompanionRuntimeProvider'
import { ProductActivityPanel } from './ProductActivityPanel'

interface HomeCompanionSurfaceProps {
  initialState?: import('@/lib/game/product-state').ProductState | null
  accountScoped?: boolean
  /** Optional account namespace for callers that can identify the session. */
  namespace?: string
}

function HomeCompanionContent({ accountScoped = false }: HomeCompanionSurfaceProps) {
  const { state, status } = useCompanionRuntime()

  if (accountScoped && !state && status !== 'loading') {
    return (
      <section className="border-l-2 px-5 py-4" style={{ borderColor: 'var(--accent)', background: 'var(--paper-raised)' }}>
        <CompanionRuntimeStatus className="mb-3" />
        <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--accent)' }}>Account condition</p>
        <p className="font-ui mt-2 text-sm font-medium">Account companion state is unavailable.</p>
        <p className="font-prose mt-2 text-sm" style={{ color: 'var(--ink-muted)' }}>Open Companions or GitHub to restore the account-scoped product state.</p>
      </section>
    )
  }

  if (!state || status === 'loading') {
    return (
      <section className="border p-6" style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }} aria-busy="true">
        <CompanionRuntimeStatus />
      </section>
    )
  }

  return (
    <div>
      <CompanionRuntimeStatus className="mb-3" />
      <ProductActivityPanel state={state} sourceLabel="Active companion" />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="font-prose text-sm" style={{ color: 'var(--ink-muted)' }}>
          Garden signals are evidence. XP belongs to the active companion only.
        </p>
        <Link
          href="/companions"
          className="font-data text-xs uppercase tracking-widest underline decoration-dotted underline-offset-4"
          style={{ color: 'var(--accent)' }}
        >
          Manage companions
        </Link>
      </div>
    </div>
  )
}

export function HomeCompanionSurface({ initialState = null, accountScoped = false, namespace, ...props }: HomeCompanionSurfaceProps) {
  return (
    <CompanionRuntimeProvider
      initialState={initialState}
      namespace={namespace}
      ownsInitialState={accountScoped}
      persistLocal={!accountScoped}
    >
      <HomeCompanionContent {...props} />
    </CompanionRuntimeProvider>
  )
}
