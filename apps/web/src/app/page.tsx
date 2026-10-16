import { getAllContent, getAllTags } from '@/lib/content'
import ContentCard from '@/components/ContentCard'
import GardenLogo from '@/components/GardenLogo'
import { siteConfig } from '@/lib/site-config'
import { ItemDrawer } from '@/components/game/ItemDrawer'
import { HomeCompanionSurface } from '@/components/game/HomeCompanionSurface'
import { getCreatureState } from '@/lib/game/state'
import { loadAccountProductState } from '@/lib/game/account-product-state'
import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: siteConfig.title,
  description: siteConfig.description,
}

export default async function HomePage() {
  const allContent = getAllContent()
  const tags = getAllTags()

  const noteCount = allContent.filter((i) => i.type === 'note').length
  const projectCount = allContent.filter((i) => i.type === 'project').length

  // Keep the public/garden evidence path independent from the site's cached
  // GitHub owner data. Account hydration handles owner-only migration below.
  const legacyState = getCreatureState(null)
  const accountProduct = await loadAccountProductState(legacyState)
  const accountScoped = accountProduct.status !== 'signed-out'
  const accountNamespace = accountScoped ? `github-${accountProduct.githubId}` : undefined

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6">

      {/* Hero */}
      <section className="flex flex-col items-center text-center pt-20 pb-16">
        <GardenLogo markSize={80} className="mb-6" />

        <p
          className="font-ui text-base leading-relaxed max-w-md mt-4"
          style={{ color: 'var(--ink-muted)' }}
        >
          {siteConfig.tagline}
        </p>

        {/* Stats */}
        <div className="font-data flex items-center flex-wrap justify-center mt-8 text-sm uppercase tracking-wide">
          <Link
            href="/notes"
            className="px-4 py-2 border-l first:border-l-0 hover:opacity-70 transition-opacity"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
          >
            {noteCount} notes
          </Link>

          <Link
            href="/notes#projects"
            className="px-4 py-2 border-l hover:opacity-70 transition-opacity"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
          >
            {projectCount} projects
          </Link>

          <Link
            href="/tags"
            className="px-4 py-2 border-l hover:opacity-70 transition-opacity"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
          >
            {tags.length} tags
          </Link>

          <Link
            href="/graph"
            className="px-4 py-2 border-l hover:opacity-70 transition-opacity"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
          >
            explore graph
          </Link>
        </div>
      </section>

      {/* Divider */}
      <div className="border-t" style={{ borderColor: 'var(--rule)' }} />

      {/* Active companion: the product projection is the only companion/XP surface. */}
      <section className="py-12">
        <HomeCompanionSurface
          initialState={accountProduct.state}
          accountScoped={accountScoped}
          namespace={accountNamespace}
        />

        <div className="mt-8">
          <h3
            className="font-data text-xs font-semibold uppercase tracking-widest mb-3"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            Specimen drawer
          </h3>
          <ItemDrawer items={legacyState.items} />
        </div>
      </section>

      {/* Divider */}
      <div className="border-t" style={{ borderColor: 'var(--rule)' }} />

      {/* Feed */}
      <section className="py-12">
        <h2
          className="font-data text-xs font-semibold uppercase tracking-widest mb-6"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          Recent
        </h2>

        {allContent.length === 0 ? (
          <div
            className="border border-dashed p-12 text-center"
            style={{ borderColor: 'var(--rule)' }}
          >
            <p className="font-ui font-medium mb-1">The garden is empty</p>
            <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
              Add your first note to <code className="font-data text-xs">apps/web/content/notes/</code> or project to{' '}
              <code className="font-data text-xs">apps/web/content/projects/</code>
            </p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-[color:var(--rule)]">
            {allContent.map((item) => (
              <ContentCard key={item.href} item={item} />
            ))}
          </div>
        )}
      </section>

    </div>
  )
}
