import type { Metadata } from 'next'
import Link from 'next/link'
import { getOwnerCollection, getClusterCollection } from '@/lib/game/collection'
import { CollectionGrid } from '@/components/game/CollectionGrid'
import { CompanionPicker } from '@/components/game/CompanionPicker'

const OWNER_LOGIN = process.env.GITHUB_LOGIN

export const metadata: Metadata = {
  title: 'Repos',
  description:
    'One creature per repository, and one per tag cluster, generated from that source of activity.',
}

/**
 * `/repos` — the repository and cluster archive.
 *
 * WHY THIS IS NOT CALLED "COLLECTION" AND DOES NOT LIVE ON /companions: these
 * creatures are generated per repository (one each, species-assigned by primary
 * language) and per tag cluster. They are a view over where the activity came
 * from, not the companions the user owns, but the two were presented under one
 * heading with the same word and a user reasonably read 24 generated tiles as 24
 * companions. Keeping the two apart by name and by route is the fix; the
 * generation itself was never wrong.
 *
 * Server-rendered and cached like the rest of the archive pages: it depends on
 * the repository listing, not on the viewer.
 */
export default async function ReposPage() {
  const repoCollection = OWNER_LOGIN
    ? await getOwnerCollection({ login: OWNER_LOGIN, token: process.env.GITHUB_TOKEN })
    : []
  const clusterCollection = getClusterCollection()

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-12">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          The archive
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Repos
        </h1>
        <p
          className="font-prose text-base leading-relaxed max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          One creature per repository, species-assigned by its primary language,
          plus one for every tag that reaches five notes. These are generated from
          where the activity came from, not companions you own. Your companions
          live under{' '}
          <Link
            href="/companions"
            className="underline decoration-dotted underline-offset-2 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--accent)' }}
          >
            Companions
          </Link>
          .
        </p>
      </div>

      <section className="mb-16">
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-2">
          Dress a repository
        </h2>
        <p
          className="font-prose text-sm leading-relaxed mb-5 max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          Pick which of your companions appears on which repository. Each companion
          is spent on exactly one, so you can dress as many repositories as you own
          companions.
        </p>
        <CompanionPicker />
      </section>

      {/*
        TWO SECTIONS, DELIBERATELY NOT ONE GRID.

        This page used to render both collections as a single grid, clusters first, so a
        tag-cluster card appeared directly under the dress section's "No tracked
        repositories yet" message: two statements that are each true but read as a
        contradiction, because nothing said the card was a cluster rather than a
        repository, and the card did not state the count that earned it. The owner looked at
        the page and asked "why is this here". Splitting the lists means the repository
        message stands beside repositories only.
      */}

      <section className="mb-16">
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-2">
          Repositories
        </h2>
        <p
          className="font-prose text-sm leading-relaxed mb-5 max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          One creature per repository, species-assigned by its primary language.
          These come from GitHub activity rather than from the companions you own,
          and you dress a companion onto one in the section above.
        </p>
        <CollectionGrid
          entries={repoCollection}
          emptyMessage="No repository creatures yet."
        />
      </section>

      <section className="mb-16">
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-2">
          Tag clusters
        </h2>
        <p
          className="font-prose text-sm leading-relaxed mb-5 max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          One creature for every tag that reaches five notes, assigned by theme. A
          cluster is something to open and read, not something to dress onto a
          repository, which is why it is listed apart from the repositories above.
        </p>
        <CollectionGrid
          entries={clusterCollection}
          emptyMessage="No tag has reached five notes yet."
        />
      </section>
    </div>
  )
}
