import type { Metadata } from 'next'
import { getCreatureState } from '@/lib/game/state'
import { STAGES } from '@/lib/game/types'
import { getOwnerCollection, getClusterCollection } from '@/lib/game/collection'
import { CreatureSprite } from '@/components/game/CreatureSprite'
import { StageLine } from '@/components/game/StageLine'
import { ItemDrawer } from '@/components/game/ItemDrawer'
import { CollectionGrid } from '@/components/game/CollectionGrid'

const OWNER_LOGIN = process.env.GITHUB_LOGIN
const TOKEN = process.env.GITHUB_TOKEN

export const metadata: Metadata = {
  title: 'Companions',
  description:
    'The full evolution line and item archive for the garden creature, including stages and items not yet reached.',
}

export default async function CompanionsPage() {
  // No argument: getCreatureState reads the cached GitHub stats automatically
  // (see src/lib/game/state.ts), and renders correctly when that cache is
  // absent, since garden data alone is enough to compute a stage.
  const state = getCreatureState()

  // CreatureSprite is an async server component (PokeAPI-backed), so each
  // stage's sprite is resolved up front and handed to StageLine as a plain
  // node. Every stage renders its real sprite, reached or not: the locked
  // ones are dimmed and desaturated by StageLine, not swapped for a mystery
  // box, so the goal stays legible.
  const stageSprites = await Promise.all(
    STAGES.map((stage) => CreatureSprite({ stage: stage.id, scale: 3 }))
  )

  // The collection: one creature per repo, each species-assigned by
  // language/age/size (species-assign.ts), never the same four Pokemon
  // repeated. Never throws; an empty array just renders the empty state in
  // CollectionGrid, so a missing token or a GitHub outage degrades the page
  // rather than breaking it.
  const repoCollection = OWNER_LOGIN
    ? await getOwnerCollection({ login: OWNER_LOGIN, token: TOKEN })
    : []

  // Cluster companions (T22): one per tag with five or more notes, each
  // inheriting its cluster's own XP rather than starting at stage 1 (see
  // clusters.ts). Notes-only and synchronous, so this never depends on
  // GitHub reachability. Listed first: they are native to this garden's own
  // content, where repo creatures are commit-driven.
  const clusterCollection = getClusterCollection()
  const collection = [...clusterCollection, ...repoCollection]

  const stats = state.stats
  const statRows: { label: string; value: string }[] = [
    { label: 'Total XP', value: state.totalXp.toLocaleString() },
    { label: 'Stage', value: `${state.stage.name} (${state.stage.index}/${STAGES.length})` },
    { label: 'Notes', value: stats.noteCount.toLocaleString() },
    { label: 'Projects', value: stats.projectCount.toLocaleString() },
    { label: 'Words', value: stats.totalWords.toLocaleString() },
    { label: 'Links', value: stats.resolvedWikilinks.toLocaleString() },
    { label: 'Backlinks', value: stats.backlinksReceived.toLocaleString() },
    { label: 'Tags', value: stats.tagCount.toLocaleString() },
  ]

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
      {/* Header */}
      <div className="mb-12">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          The archive
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Companions
        </h1>
        <p
          className="font-prose text-base leading-relaxed max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          Every stage the creature can reach and every item it can carry,
          documented whether or not the garden has gotten there yet.
        </p>
      </div>

      {/* Stats summary */}
      <section className="mb-14">
        {/*
          Fixed Tailwind columns, not auto-fill/auto-fit: statRows is a
          known-length list (8), but auto-fit only collapses a track that is
          empty across every row it spans. At this page's actual content
          width (capped by max-w-5xl, ~976px), minmax(140px, 1fr) fits 6
          columns, so 8 items split 6 + 2. Row 1 fills all 6 tracks, which
          keeps them "in use" for row 2 too, so auto-fit could not collapse
          the leftover 4 tracks in that short second row, only reserved
          per-row emptiness collapses. grid-cols-2 sm:grid-cols-4 divides 8
          evenly at every breakpoint (4x2 or 2x4), so there is never a
          partial row to leave dead space in.
        */}
        <div
          className="grid grid-cols-2 sm:grid-cols-4"
          style={{
            borderTop: '1px solid var(--rule)',
            borderLeft: '1px solid var(--rule)',
          }}
        >
          {statRows.map((row) => (
            <div
              key={row.label}
              className="p-4"
              style={{ borderRight: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)' }}
            >
              <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
                {row.label}
              </p>
              <p className="font-data text-xl font-semibold mt-1">{row.value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Evolution line */}
      <section className="mb-14">
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-5">
          Evolution line
        </h2>
        <StageLine stages={STAGES} currentStageIndex={state.stage.index} sprites={stageSprites} />
      </section>

      {/* Item archive */}
      <section className="mb-14">
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-5">
          Item archive
        </h2>
        <ItemDrawer items={state.items} />
      </section>

      {/*
        The collection. A separate section, deliberately never merged into
        the evolution line above: the garden creature (driven by notes plus
        all commits) is the main one, and everything below is the collection
        that grows around it. See CollectionGrid's header comment.
      */}
      <section>
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-2">
          Collection
        </h2>
        <p
          className="font-prose text-sm leading-relaxed mb-5 max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          A tag that reaches five notes hatches its own companion, themed by
          what the cluster is about and already grown from that cluster&apos;s
          own words, links, and backlinks. Every repo also creates its own
          creature from that repo&apos;s own commit activity, species-assigned
          by primary language, so the collection actually looks like a
          collection.
        </p>
        <CollectionGrid entries={collection} />
      </section>
    </div>
  )
}
