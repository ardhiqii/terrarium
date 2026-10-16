import type { Metadata } from 'next'
import Link from 'next/link'
import { getCreatureState } from '@/lib/game/state'
import { loadAccountProductState } from '@/lib/game/account-product-state'
import { CompanionCollection } from '@/components/game/CompanionCollection'
import { ItemDrawer } from '@/components/game/ItemDrawer'

export const metadata: Metadata = {
  title: 'Companions',
  description: 'Your owned companions, active progression, images, and activation controls.',
}

export const dynamic = 'force-dynamic'

export default async function CompanionsPage() {
  // Explicit null prevents the public archive from inheriting the site's
  // cached GitHub account. The account loader reads that cache only after it
  // proves the signed-in owner identity for the one-time legacy migration.
  const legacyState = getCreatureState(null)
  const accountProduct = await loadAccountProductState(legacyState)
  const productState = accountProduct.state
  const accountIsSignedIn = accountProduct.status !== 'signed-out'
  const gardenStats = legacyState.stats
  const gardenStatRows: { label: string; value: string }[] = [
    { label: 'Notes', value: gardenStats.noteCount.toLocaleString() },
    { label: 'Projects', value: gardenStats.projectCount.toLocaleString() },
    { label: 'Words', value: gardenStats.totalWords.toLocaleString() },
    { label: 'Links', value: gardenStats.resolvedWikilinks.toLocaleString() },
    { label: 'Backlinks', value: gardenStats.backlinksReceived.toLocaleString() },
    { label: 'Tags', value: gardenStats.tagCount.toLocaleString() },
  ]

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-12">
        <p className="font-data text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}>
          The archive
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">Companions</h1>
        <p className="font-prose text-base leading-relaxed max-w-2xl" style={{ color: 'var(--ink-muted)' }}>
          Your owned companion roster, current form, XP, and active selection. Browse the{' '}
          <Link href="/species" className="underline decoration-dotted underline-offset-2" style={{ color: 'var(--accent)' }}>species gallery</Link>{' '}
          or step through the{' '}
          <Link href="/preview" className="underline decoration-dotted underline-offset-2" style={{ color: 'var(--accent)' }}>interactive preview</Link>.
        </p>
      </div>

      {accountIsSignedIn && !productState && (
        <section className="mb-10 border-l-2 px-5 py-4" style={{ borderColor: 'var(--accent)', background: 'var(--paper-raised)' }} aria-label="Account condition">
          <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--accent)' }}>Account condition</p>
          <h2 className="font-ui mt-2 text-xl font-semibold tracking-tight">
            {accountProduct.status === 'missing' ? 'No synced condition yet' : 'Account condition unavailable'}
          </h2>
          <p className="font-prose mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {accountProduct.status === 'missing'
              ? 'Connect GitHub and complete a product sync before account-owned companions appear here.'
              : 'The account condition could not be read right now. No global garden archive is being presented as account XP.'}
          </p>
          {accountProduct.status === 'missing' && (
            <Link href="/github" className="font-ui mt-4 inline-block text-sm underline underline-offset-2" style={{ color: 'var(--accent)' }}>
              Open GitHub sync
            </Link>
          )}
        </section>
      )}

      {(!accountIsSignedIn || Boolean(productState)) && (
        <section className="mb-14">
          <CompanionCollection
            initialState={productState}
            signedIn={accountIsSignedIn}
            accountId={accountIsSignedIn ? accountProduct.githubId : undefined}
          />
        </section>
      )}

      <section className="mb-14">
        <p className="font-data mb-3 text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
          Garden signals
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4" style={{ borderTop: '1px solid var(--rule)', borderLeft: '1px solid var(--rule)' }}>
          {gardenStatRows.map((row) => (
            <div key={row.label} className="p-4" style={{ borderRight: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)' }}>
              <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>{row.label}</p>
              <p className="font-data text-xl font-semibold mt-1">{row.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-5">Item archive</h2>
        <ItemDrawer items={legacyState.items} />
      </section>
    </div>
  )
}
