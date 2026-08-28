import { getAllContent, getAllTags } from '@/lib/content'
import ContentCard from '@/components/ContentCard'
import GardenLogo from '@/components/GardenLogo'
import { siteConfig } from '@/lib/site-config'
import { SpecimenPlate } from '@/components/game/SpecimenPlate'
import { XpLedger } from '@/components/game/XpLedger'
import { ItemDrawer } from '@/components/game/ItemDrawer'
import { getCreatureState } from '@/lib/game/state'
import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: siteConfig.title,
  description: siteConfig.description,
}

export default function HomePage() {
  const allContent = getAllContent()
  const tags = getAllTags()

  const noteCount = allContent.filter((i) => i.type === 'note').length
  const projectCount = allContent.filter((i) => i.type === 'project').length

  // No GitHub data exists yet (T5 lands it later); the creature must render
  // correctly from garden data alone, so `null` here is correct and expected.
  const creatureState = getCreatureState(null)

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
            href="/projects"
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

      {/* Creature: the garden's growth made visible. Archive register. */}
      <section className="py-12">
        <SpecimenPlate state={creatureState} />

        <div className="grid sm:grid-cols-2 gap-8 mt-8">
          <div>
            <h3
              className="font-data text-xs font-semibold uppercase tracking-widest mb-3"
              style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
            >
              Observation log
            </h3>
            <XpLedger entries={creatureState.breakdown} total={creatureState.totalXp} />
          </div>

          <div>
            <h3
              className="font-data text-xs font-semibold uppercase tracking-widest mb-3"
              style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
            >
              Specimen drawer
            </h3>
            <ItemDrawer items={creatureState.items} />
          </div>
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
              Add your first note to <code className="font-data text-xs">content/notes/</code> or project to{' '}
              <code className="font-data text-xs">content/projects/</code>
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
