import type { Metadata } from 'next'
import Link from 'next/link'
import { getCreatureState } from '@/lib/game/state'
import { STAGES } from '@/lib/game/types'
import { slotLabel } from '@/lib/game/stages'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { restoreProductStateFromSnapshot } from '@/lib/sync/product-snapshot'
import type { ProductState } from '@/lib/game/product-state'
import { getProductStore } from '@/lib/sync/product-store'
import { trustStoredProductSnapshot } from '@/lib/sync/trusted-product-snapshot'
import { getSessionProvider } from '@/lib/sync/session'
import { CreatureSprite } from '@/components/game/CreatureSprite'
import { StageLine } from '@/components/game/StageLine'
import { ItemDrawer } from '@/components/game/ItemDrawer'
import { OwnedCompanionGrid } from '@/components/game/OwnedCompanionGrid'
import { ProductActivityPanel } from '@/components/game/ProductActivityPanel'

export const metadata: Metadata = {
  title: 'Companions',
  description:
    'The full evolution line and item archive for the primary companion, including stages and items not yet reached.',
}

// The account-specific product condition changes per request and must never be
// served from a static page cache. The legacy garden archive below remains
// useful when no account condition exists, but it is not a substitute for the
// verified product-sync state.
export const dynamic = 'force-dynamic'

type AccountProductResult =
  | { status: 'signed-out'; state: null }
  | { status: 'missing' | 'unavailable'; state: null }
  | { status: 'available'; state: ProductState }

async function loadAccountProductState(): Promise<AccountProductResult> {
  const session = await getSessionProvider().current()
  if (!session) return { status: 'signed-out', state: null }

  try {
    const record = await getProductStore().getRecord(session.githubId, session.handle)
    if (!record) return { status: 'missing', state: null }
    const snapshot = trustStoredProductSnapshot(record.snapshot, session.githubId)
    const fallbackProfile = createGuestProfile({
      guestId: snapshot.guestId,
      starterCompanionId: snapshot.activeCompanionId,
      now: snapshot.createdAt,
    })
    return {
      status: 'available',
      state: restoreProductStateFromSnapshot(
        snapshot,
        fallbackProfile,
        PROTOTYPE_COMPANION_CATALOG,
      ),
    }
  } catch {
    // A broken or unavailable product row must not take down the public
    // archive. The page reports that account state separately instead of
    // presenting the global legacy GitHub cache as if it were this account.
    return { status: 'unavailable', state: null }
  }
}

// The profile key is resolved in the client by `useViewerProfileKey`, from
// `/api/auth/session`. This page is a Server Component but the profile lives in the
// browser, so the key has to be resolved client-side regardless, and one resolver
// shared by every surface is what stops them disagreeing again.

export default async function CompanionsPage() {
  const accountProduct = await loadAccountProductState()
  const productState = accountProduct.state
  const accountIsSignedIn = accountProduct.status !== 'signed-out'
  // No argument: getCreatureState reads the cached GitHub stats automatically
  // (see apps/web/src/lib/game/state.ts), and renders correctly when that cache is
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

    // The repository and cluster archive moved to /repos. It used to be built
    // here and rendered under a "Garden collection" heading, which read as the
    // user's own collection; it is a view over where activity came from, not over
    // what the user owns. Building it here now would also mean an unnecessary
    // GitHub listing request on every page load.

  const stats = state.stats
  const gardenStatRows: { label: string; value: string }[] = [
    { label: 'Notes', value: stats.noteCount.toLocaleString() },
    { label: 'Projects', value: stats.projectCount.toLocaleString() },
    { label: 'Words', value: stats.totalWords.toLocaleString() },
    { label: 'Links', value: stats.resolvedWikilinks.toLocaleString() },
    { label: 'Backlinks', value: stats.backlinksReceived.toLocaleString() },
    { label: 'Tags', value: stats.tagCount.toLocaleString() },
  ]
  const legacyStatRows: { label: string; value: string }[] = [
    { label: 'Total XP', value: state.totalXp.toLocaleString() },
    { label: 'Stage', value: `${state.stage.name} (${state.stage.index}/${STAGES.length})` },
    ...gardenStatRows,
  ]
  const statRows = productState || accountIsSignedIn ? gardenStatRows : legacyStatRows
  /**
   * True when this block is showing the VISITOR's garden and that garden is empty, which is
   * every signed-out first visit.
   *
   * WHY IT EXISTS: the home page renders the owner's built-in garden and this page renders the
   * viewer's. A signed-out stranger saw `/` say "4 notes / 1,550 xp / Mossling" and this page
   * say "0 / 0 / Sporeling", a scroll apart, with nothing saying they were two different
   * gardens. Side by side, one of them reads as broken. This flag drives a label, not a hiding.
   */
  const emptyViewerGarden = !productState && !accountIsSignedIn

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
          documented whether or not the garden has gotten there yet. See the
          full sprite set line by line in the{' '}
          <Link
            href="/species"
            className="underline decoration-dotted underline-offset-2 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--accent)' }}
          >
            species gallery
          </Link>
          , or step through a single creature interactively in the{' '}
          <Link
            href="/preview"
            className="underline decoration-dotted underline-offset-2 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--accent)' }}
          >
            preview
          </Link>
          . Your own rank and milestones live under{' '}
          <Link
            href="/progression"
            className="underline decoration-dotted underline-offset-2 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--accent)' }}
          >
            progression
          </Link>
          .
        </p>
      </div>

      {productState && (
        <section className="mb-10" aria-label="Synced product condition">
          <ProductActivityPanel state={productState} sourceLabel="Synced product condition" />
        </section>
      )}
      {accountIsSignedIn && !productState && (
        <section
          className="mb-10 border-l-2 px-5 py-4"
          style={{ borderColor: 'var(--accent)', background: 'var(--paper-raised)' }}
          aria-label="Synced product condition"
        >
          <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
            Account condition
          </p>
          <h2 className="font-ui mt-2 text-xl font-semibold tracking-tight">
            {accountProduct.status === 'missing' ? 'No synced condition yet' : 'Account condition unavailable'}
          </h2>
          <p className="font-prose mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {accountProduct.status === 'missing'
              ? 'The garden archive below is local. Connect GitHub and complete a product sync before account XP appears here.'
              : 'The account condition could not be read right now. The garden archive below is local and does not represent account XP.'}
          </p>
          {accountProduct.status === 'missing' && (
            <Link href="/github" className="font-ui mt-4 inline-block text-sm underline underline-offset-2" style={{ color: 'var(--accent)' }}>
              Open GitHub sync
            </Link>
          )}
        </section>
      )}

      {/* Stats summary */}
      <section className="mb-14">
        {accountIsSignedIn && (
          <p className="font-data mb-3 text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
            Garden signals
          </p>
        )}
        {/*
          Fixed Tailwind columns keep the six garden metrics (or the eight
          legacy metrics for a signed-out visitor) evenly distributed at every
          breakpoint. Product XP is deliberately rendered by the synced
          condition above rather than the legacy github-cache aggregate.
        */}
        {/*
          WHOSE GARDEN THESE NUMBERS ARE.

          The home page renders the owner's built-in garden; this block renders the VIEWER's.
          For a signed-out stranger that meant `/` said "4 notes / 1,550 xp / Mossling" and this
          page said "0 / 0 / Sporeling", a scroll apart, with nothing saying they were two
          different gardens. The label removes the contradiction without pretending the numbers
          are the same, and the second line tells them what to do about it.
        */}
        <p
          className="font-data text-xs uppercase tracking-widest mb-3"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          {emptyViewerGarden ? 'Your garden · nothing connected on this device' : 'Your garden'}
        </p>
        {emptyViewerGarden && (
          <p
            className="font-prose text-sm leading-relaxed mb-4 max-w-2xl"
            style={{ color: 'var(--ink-muted)' }}
          >
            The figures on the home page are the site owner&apos;s garden, not yours. Connect
            a folder under{' '}
            <Link
              href="/write"
              className="underline decoration-dotted underline-offset-2 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--accent)' }}
            >
              Write
            </Link>{' '}
            to start your own.
          </p>
        )}
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

      {!accountIsSignedIn && (
        <>
          {/* Evolution line: only the signed-out owner archive uses the legacy cache. */}
          <section className="mb-14">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-1">Progression</h2>
            <p className="font-prose text-sm leading-relaxed mb-5 max-w-2xl" style={{ color: 'var(--ink-muted)' }}>
              The first three stages are evolutions; the final stage is the family&apos;s mastery form ({slotLabel(STAGES[STAGES.length - 1])}).
            </p>
            <StageLine stages={STAGES} currentStageIndex={state.stage.index} sprites={stageSprites} />
          </section>

          {/* Item archive */}
          <section className="mb-14">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-5">Item archive</h2>
            <ItemDrawer items={state.items} />
          </section>
        </>
      )}

      {/*
        The user's own companions.

        This section used to render one generated creature per GitHub repository
        under the heading "Garden collection", and a user with 24 repositories
        read those 24 tiles as 24 companions they already owned. They owned one.
        The repo creatures were never wrong, but presenting them as the
        collection was, so they moved to /repos and this shows what the user
        actually owns.
      */}
      <section>
        <h2 className="font-ui text-xl font-semibold tracking-tighter mb-2">
          Your companions
        </h2>
        <p
          className="font-prose text-sm leading-relaxed mb-5 max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          One companion is granted when you first arrive, and another for every
          day you come back. A companion can be dressed onto one of your
          repositories, and each one is spent on exactly one. The repository
          archive lives in <Link href="/repos" className="underline decoration-dotted underline-offset-2" style={{ color: 'var(--accent)' }}>Repos</Link>.
        </p>
        <OwnedCompanionGrid sprite={await CreatureSprite({ stage: 'sporeling', scale: 2 })} />
      </section>
    </div>
  )
}
