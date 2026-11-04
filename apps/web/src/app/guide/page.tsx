import type { Metadata } from 'next'
import Link from 'next/link'
import {
  STAGES,
  XP_RATES,
  COMMIT_XP_DAILY_CAP,
} from '@/lib/game/types'
import { GARDEN_ITEMS, COMMIT_ITEMS } from '@/lib/game/items'
import { VARIANT_DEFS } from '@/lib/game/variants'
import { CLUSTER_THRESHOLD } from '@/lib/game/clusters-from-items'
import { CreatureSprite } from '@/components/game/CreatureSprite'
import TableOfContents from '@/components/layout/TableOfContents'
import type { TocEntry } from '@/lib/mdx'
import { RelatedLinks } from '@/components/ui/RelatedLinks'
import { COPY, GUIDE_ANCHORS } from '@/lib/copy'

export const metadata: Metadata = {
  title: 'Guide',
  description:
    'How the primary companion works: XP sources, the evolution line, companions, and items, generated from the rules in the code.',
}

// Copy only. Every number rendered next to a row here is read from XP_RATES
// at render time, never retyped, so a retuned rate updates this table for
// free instead of drifting the way DESIGN.md once did.
const XP_RATE_ROWS: { label: string; unit: string; rate: number }[] = [
  { label: 'Note or project published', unit: 'once', rate: XP_RATES.notePublished },
  { label: 'Per 100 words of body copy', unit: 'per 100 words', rate: XP_RATES.perHundredWords },
  { label: 'Outgoing wikilink that resolves to a real note', unit: 'per link', rate: XP_RATES.resolvedWikilink },
  { label: 'Backlink received', unit: 'per backlink', rate: XP_RATES.backlinkReceived },
  { label: 'New tag introduced', unit: 'per tag', rate: XP_RATES.newTag },
  { label: 'Note promoted seedling to budding', unit: 'once', rate: XP_RATES.promotedToBudding },
  { label: 'Note promoted budding to evergreen', unit: 'once', rate: XP_RATES.promotedToEvergreen },
  { label: 'Commit to any public repo', unit: 'per commit', rate: XP_RATES.commit },
  { label: 'Commit to this Terrarium repo', unit: 'per commit', rate: XP_RATES.commitToGarden },
]

const TOC_ENTRIES: TocEntry[] = [
  { id: 'how-xp-works', text: 'How XP works', level: 2 },
  { id: 'the-four-stages', text: 'The four stages', level: 2 },
  { id: 'variants', text: 'Variants', level: 2 },
  { id: 'companions', text: 'Companions', level: 2 },
  { id: 'items', text: 'Items', level: 2 },
  { id: 'where-xp-comes-from', text: 'Where XP comes from', level: 2 },
  { id: GUIDE_ANCHORS.condition, text: 'Condition', level: 2 },
  { id: GUIDE_ANCHORS.githubSync, text: 'GitHub sync', level: 2 },
  { id: GUIDE_ANCHORS.privacy, text: 'Privacy', level: 2 },
  { id: GUIDE_ANCHORS.leaderboard, text: 'Leaderboard', level: 2 },
]

/**
 * The condition layer's rules, in one table. Surfaces show only a meter and, when
 * a need is low, what would help (`DESIGN.md` §7); the full rule lives here.
 */
const CONDITION_ROWS: { need: string; drops: string; restores: string }[] = [
  { need: 'Hunger', drops: 'A quarter a day with no meal and no work', restores: 'A meal, or a day of work' },
  { need: 'Energy', drops: 'Late-night sessions and long streaks', restores: 'A rest' },
  { need: 'Health', drops: 'Your default branch CI is red', restores: 'Medicine' },
  { need: 'Cleanliness', drops: 'Your own pull requests sit open', restores: 'Merging or closing them' },
  { need: 'Diet', drops: 'Only one kind of work this week', restores: 'A quarter per kind of work, up to four' },
]

export default async function GuidePage() {
  // CreatureSprite is a server component (async, resolves against PokeAPI
  // with a code-generated fallback), so each stage's sprite is awaited up
  // front, same pattern as /companions.
  const stageSprites = await Promise.all(
    STAGES.map((stage) => CreatureSprite({ stage: stage.id, scale: 2 }))
  )

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
      {/* Header */}
      <div className="mb-12 max-w-[65ch]">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          The rules
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Guide
        </h1>
        <p className="font-prose text-base leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Every rule behind your companion, read from the code that runs it.
        </p>
        {/* The sidebar contents list is desktop-only; small screens get it inline. */}
        <RelatedLinks
          label="On this page"
          className="mt-2 lg:hidden"
          links={TOC_ENTRIES.map((entry) => ({ href: `#${entry.id}`, label: entry.text }))}
        />
      </div>

      <div className="lg:grid lg:grid-cols-[1fr_200px] lg:gap-12">
        {/* Main column: long-form article, not a stat dashboard. This is the
            deliberate departure from /companions, which is a full-width
            archive of bordered stat cells and card grids. This page reads
            top to bottom like a note, with a sticky table of contents beside
            it, the same reading-surface convention notes and projects use. */}
        <article className="min-w-0">
          <section id="how-xp-works" className="mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              How XP works
            </h2>
            <div className="max-w-[65ch] font-prose text-base leading-relaxed mb-6" style={{ color: 'var(--ink)' }}>
              <p className="mb-3">
                XP rewards <em>connection</em>, not volume. Wikilinks and
                backlinks score well because they are evidence that a note
                found its place in the garden. Raw word count deliberately
                does not, so padding a note out is a poor strategy: the
                per-100-word rate below is small on purpose.
              </p>
              <p>
                Commits are capped per day so that a scripted commit loop
                cannot farm the creature. The cap holds regardless of how the
                commits split between this repo and everywhere else.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full font-data text-sm border-collapse">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                    <th className="text-left font-medium py-2 pr-4" style={{ color: 'var(--ink-muted)' }}>
                      Event
                    </th>
                    <th className="text-left font-medium py-2 pr-4" style={{ color: 'var(--ink-muted)' }}>
                      Unit
                    </th>
                    <th className="text-right font-medium py-2" style={{ color: 'var(--ink-muted)' }}>
                      XP
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {XP_RATE_ROWS.map((row) => (
                    <tr key={row.label} style={{ borderBottom: '1px solid var(--rule)' }}>
                      <td className="py-2 pr-4" style={{ color: 'var(--ink)' }}>
                        {row.label}
                      </td>
                      <td className="py-2 pr-4" style={{ color: 'var(--ink-muted)' }}>
                        {row.unit}
                      </td>
                      <td className="py-2 text-right font-medium" style={{ color: 'var(--ink)' }}>
                        {row.rate.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="max-w-[65ch] font-prose text-sm leading-relaxed mt-4" style={{ color: 'var(--ink-muted)' }}>
              Commit XP, from either row above, is capped at{' '}
              <strong style={{ color: 'var(--ink)' }} className="font-data font-semibold">
                {COMMIT_XP_DAILY_CAP.toLocaleString()}
              </strong>{' '}
              XP per calendar day, combined across both rates.
            </p>
          </section>

          <section id="the-four-stages" className="mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              The four stages
            </h2>
            <p className="max-w-[65ch] font-prose text-base leading-relaxed mb-6" style={{ color: 'var(--ink-muted)' }}>
              Every stage is reachable from total XP alone. Reaching one says
              something specific about the state of the garden, not just that
              a number got bigger.
            </p>

            {/* A vertical list of rows, each self-bordered top-only, rather
                than /companions' grid of bordered cards: same data, a
                different shape, so the two pages do not read as the same
                template with different words dropped in. */}
            <div style={{ borderTop: '1px solid var(--rule)' }}>
              {STAGES.map((stage, i) => (
                <div
                  key={stage.id}
                  className="flex items-center gap-5 py-5"
                  style={{ borderBottom: '1px solid var(--rule)' }}
                >
                  <div className="shrink-0 w-16 h-16 flex items-center justify-center [&_img]:max-h-full [&_img]:max-w-full [&_img]:w-auto [&_img]:h-auto [&_img]:object-contain">
                    {stageSprites[i]}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <h3 className="font-ui text-base font-semibold">
                        {stage.index}. {stage.name}
                      </h3>
                      <span className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {stage.threshold.toLocaleString()} xp
                      </span>
                    </div>
                    <p className="font-prose text-sm leading-relaxed mt-1" style={{ color: 'var(--ink-muted)' }}>
                      {stage.blurb}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section id="variants" className="mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              Variants
            </h2>
            <div className="max-w-[65ch] font-prose text-base leading-relaxed mb-6" style={{ color: 'var(--ink-muted)' }}>
              <p className="mb-3">
                Stage says how much. Variant says how the work is shaped.
                Every threshold below is a ratio, never a raw count, so a
                nine-note garden and a nine-hundred-note garden can both
                qualify for the same one. Most gardens qualify for none of
                the four: these thresholds were picked to sit past what a
                typical garden reaches, not to hand one out on arrival.
              </p>
              <p>
                A creature earns at most one. When a garden clears more than
                one threshold at once, the most specific signal wins:{' '}
                <span className="font-data text-sm">
                  var. deep {'>'} var. woven {'>'} var. broad {'>'} var. steady
                </span>
                . No sprite changes and no glow; the variant renders as its
                name, in the accent colour, next to the stage name above.
              </p>
            </div>

            <div style={{ borderTop: '1px solid var(--rule)' }}>
              {VARIANT_DEFS.map((def) => (
                <div key={def.id} className="py-4" style={{ borderBottom: '1px solid var(--rule)' }}>
                  <h3
                    className="font-data text-sm font-semibold mb-1"
                    style={{ color: 'var(--accent)' }}
                  >
                    {def.label}
                  </h3>
                  <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink)' }}>
                    {def.blurb}
                  </p>
                  <p className="font-data text-xs mt-1" style={{ color: 'var(--ink-muted)' }}>
                    {def.requirement}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section id="companions" className="mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              Companions
            </h2>
            <div className="max-w-[65ch] font-prose text-base leading-relaxed" style={{ color: 'var(--ink)' }}>
              <p className="mb-3">
                Companions hatch from bodies of work; activity earns their
                XP. A GitHub repo past its own threshold hatches a repo
                companion. A tag reaching{' '}
                <strong className="font-data font-semibold">{CLUSTER_THRESHOLD}</strong>{' '}
                notes hatches a cluster companion, themed by what that cluster
                is about.
              </p>
              <p className="mb-3">
                A single note, or a tag with fewer than {CLUSTER_THRESHOLD}{' '}
                notes, is a seed: it earns XP through the main garden
                creature and hatches nothing on its own. It may still grow
                into a cluster later as more notes join its tag.
              </p>
              <p>
                A hatched companion does not start over at stage one. It
                inherits its cluster&apos;s own accumulated XP, computed from
                that cluster&apos;s own words, links, and backlinks, so a
                dense body of work shows up already grown. See{' '}
                <Link href="/companions" className="underline" style={{ color: 'var(--accent)' }}>
                  Companions
                </Link>{' '}
                for the full, currently-hatched collection.
              </p>
              <p className="mt-3">
                {COPY.dailyCompanion} You can dress a companion onto one of your
                repositories, and each companion goes on exactly one.
              </p>
            </div>
          </section>

          <section id="items" className="mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              Items
            </h2>
            <p className="max-w-[65ch] font-prose text-base leading-relaxed mb-6" style={{ color: 'var(--ink-muted)' }}>
              Items are unlocked states, not inventory. Garden items read
              this site&apos;s own notes and projects, so they only ever
              apply to the site owner. Commit items read public GitHub
              activity alone, so they apply to any handle or repo.
            </p>

            <div className="mb-6">
              <p className="font-data text-xs uppercase tracking-wide mb-2" style={{ color: 'var(--ink-muted)' }}>
                Garden items, owner only
              </p>
              <div className="overflow-x-auto">
                <table className="w-full font-data text-sm border-collapse">
                  <tbody>
                    {GARDEN_ITEMS.map((item) => (
                      <tr key={item.id} style={{ borderTop: '1px solid var(--rule)' }}>
                        <td className="py-2 pr-4 whitespace-nowrap font-ui" style={{ color: 'var(--ink)' }}>
                          {item.name}
                        </td>
                        <td className="py-2 text-sm" style={{ color: 'var(--ink-muted)' }}>
                          {item.requirement}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <p className="font-data text-xs uppercase tracking-wide mb-2" style={{ color: 'var(--ink-muted)' }}>
                Commit items, any handle or repo
              </p>
              <div className="overflow-x-auto">
                <table className="w-full font-data text-sm border-collapse">
                  <tbody>
                    {COMMIT_ITEMS.map((item) => (
                      <tr key={item.id} style={{ borderTop: '1px solid var(--rule)' }}>
                        <td className="py-2 pr-4 whitespace-nowrap font-ui" style={{ color: 'var(--ink)' }}>
                          {item.name}
                        </td>
                        <td className="py-2 text-sm" style={{ color: 'var(--ink-muted)' }}>
                          {item.requirement}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section id="where-xp-comes-from" className="scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              Where XP comes from
            </h2>
            <div className="max-w-[65ch] font-prose text-base leading-relaxed" style={{ color: 'var(--ink)' }}>
              <p className="mb-3">
                Two sources, combined. Notes and projects contribute the
                garden side of the table above, computed at build time from
                this repo&apos;s own content. GitHub contributes the commit
                side, fetched at build time and cached to disk.
              </p>
              <p>
                Honestly: without a <code className="font-data text-sm">GITHUB_TOKEN</code>{' '}
                configured, the unauthenticated path undercounts commits by
                roughly 10x, because GitHub&apos;s public events API no
                longer returns per-push commit counts and can only count one
                commit per push it sees.
              </p>
            </div>
          </section>

          <section id={GUIDE_ANCHORS.condition} className="mt-14 mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              Condition
            </h2>
            <p className="max-w-[65ch] font-prose text-base leading-relaxed mb-6" style={{ color: 'var(--ink)' }}>
              {COPY.conditionIsRecoverable} After a week with nothing going in,
              the companion goes dormant; one day of work wakes it.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full font-data text-sm border-collapse">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                    <th className="text-left font-medium py-2 pr-4" style={{ color: 'var(--ink-muted)' }}>Need</th>
                    <th className="text-left font-medium py-2 pr-4" style={{ color: 'var(--ink-muted)' }}>Drops when</th>
                    <th className="text-left font-medium py-2" style={{ color: 'var(--ink-muted)' }}>Restored by</th>
                  </tr>
                </thead>
                <tbody>
                  {CONDITION_ROWS.map((row) => (
                    <tr key={row.need} style={{ borderBottom: '1px solid var(--rule)' }}>
                      <td className="py-2 pr-4 font-ui" style={{ color: 'var(--ink)' }}>{row.need}</td>
                      <td className="py-2 pr-4" style={{ color: 'var(--ink-muted)' }}>{row.drops}</td>
                      <td className="py-2" style={{ color: 'var(--ink-muted)' }}>{row.restores}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id={GUIDE_ANCHORS.githubSync} className="mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              GitHub sync
            </h2>
            <ul className="max-w-[65ch] font-prose text-base leading-relaxed list-disc pl-5 space-y-2" style={{ color: 'var(--ink)' }}>
              <li>
                <strong>Approved</strong> means GitHub lets Terrarium read a repo.{' '}
                <strong>Tracked</strong> means its future activity can move your companion.
                Only tracked repos count, and repository contents and code are never read.
              </li>
              <li>
                The first sync of a repo sets a baseline. Old history is not awarded, so
                connecting a ten-year-old account does not hand out ten years of XP.
              </li>
              <li>
                A meaningful commit wakes an active workday and a session; the commit count
                itself is not an unlimited XP faucet. Every signal goes to your active
                companion and is capped by its activity window.
              </li>
              <li>Activity from private repos stays visible only to you.</li>
              <li>
                Automatic sync runs only while the GitHub page is open, and pauses before
                your hourly GitHub request limit is spent.
              </li>
              <li>
                Disconnecting stops tracking and removes the stored GitHub token. Earned XP,
                your companion, and your repo choices are kept. Signing out is not
                disconnecting.
              </li>
            </ul>
          </section>

          <section id={GUIDE_ANCHORS.privacy} className="mb-14 scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              Privacy
            </h2>
            <ul className="max-w-[65ch] font-prose text-base leading-relaxed list-disc pl-5 space-y-2" style={{ color: 'var(--ink)' }}>
              <li>
                Notes stay on your own device. Connecting a folder reads it in the browser tab
                and computes your creature there.
              </li>
              <li>
                Only a small summary (stage, total XP, and companion count) ever leaves your
                device, and only once you choose to sync.
              </li>
              <li>A public profile is opt-in. Until you turn it on, only you can see yours.</li>
              <li>
                Totals on profiles are as reported by each garden. Commit activity can be
                checked against public GitHub data, but note activity cannot, since notes
                never leave the writer&apos;s own device.
              </li>
            </ul>
          </section>

          <section id={GUIDE_ANCHORS.leaderboard} className="scroll-mt-20">
            <h2 className="font-ui text-xl font-semibold tracking-tighter mb-4">
              Leaderboard
            </h2>
            <p className="max-w-[65ch] font-prose text-base leading-relaxed" style={{ color: 'var(--ink)' }}>
              The leaderboard only shows people you follow on GitHub who have synced a
              garden here. It is never a global ranking: a public board over public commit
              data would be farmed within a week, and friend scope removes the incentive
              instead of trying to police it.
            </p>
          </section>
        </article>

        {/* Sidebar: TOC, the same component and position notes use, not the
            full-width stat header /companions opens with. */}
        <aside className="hidden lg:block">
          <div className="sticky top-20">
            <TableOfContents entries={TOC_ENTRIES} />
          </div>
        </aside>
      </div>
    </div>
  )
}
