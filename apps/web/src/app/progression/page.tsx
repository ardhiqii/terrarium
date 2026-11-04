import type { Metadata } from 'next'
import { ProgressionView } from '@/components/game/ProgressionView'

export const metadata: Metadata = {
  title: 'Progression',
  description:
    'Your rank and the achievements you have earned. Derived entirely from your own activity — nothing here is uploaded.',
}

/**
 * Server shell around a client view: rank and achievements are pure functions
 * of the browser-local ledger, so all of the work happens in the tab.
 */
export default function ProgressionPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-12">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          Your standing
        </p>
        <h1 className="font-ui text-4xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Progression
        </h1>
        <p className="font-prose text-base leading-relaxed max-w-[52ch]" style={{ color: 'var(--ink-muted)' }}>
          Your rank and milestones, from everything you write and ship.
        </p>
      </div>
      <ProgressionView />
    </div>
  )
}
