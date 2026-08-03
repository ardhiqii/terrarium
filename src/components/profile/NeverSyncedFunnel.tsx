import Link from 'next/link'
import { CreatureSprite } from '@/components/game/CreatureSprite'

export interface NeverSyncedFunnelProps {
  handle: string
}

/**
 * `/u/<handle>` for a handle that has never synced. This is the COMMON
 * case, not an error: almost nobody has run a sync yet, and this page is
 * the only funnel a friend's shared profile link generates. A 404 or an
 * empty shell here wastes the one piece of organic traffic this feature
 * produces, so it explains what Terrarium is and gives a way in, rather
 * than reporting a failure.
 *
 * A dimmed Sporeling stands in for "no creature yet": every garden starts
 * there, so it previews the first stage without claiming this handle has
 * actually reached it.
 */
export async function NeverSyncedFunnel({ handle }: NeverSyncedFunnelProps) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 sm:py-20 text-center">
      <div className="flex justify-center mb-6 opacity-40 grayscale">
        <CreatureSprite stage="sporeling" scale={3} alt="An ungrown Sporeling" />
      </div>

      <p
        className="font-data text-xs uppercase tracking-widest mb-2"
        style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
      >
        Not synced yet
      </p>
      <h1 className="font-ui text-2xl sm:text-3xl font-semibold tracking-tighter leading-[1.05] mb-4">
        @{handle}
        {' '}hasn&apos;t connected a garden here
      </h1>
      <p
        className="font-prose text-base leading-relaxed mb-8 max-w-[52ch] mx-auto"
        style={{ color: 'var(--ink-muted)' }}
      >
        Terrarium turns a folder of markdown notes into a creature that
        grows as the writing does. Notes stay on the writer&apos;s own
        device; only a small summary, stage, total XP, and companion count,
        ever leaves it, and only once someone chooses to sync.
      </p>
      <p
        className="font-prose text-sm leading-relaxed mb-10 max-w-[52ch] mx-auto"
        style={{ color: 'var(--ink-muted)' }}
      >
        If @{handle}
        {' '}sent you here, they just haven&apos;t synced a garden
        under this handle yet. This page will show their creature the
        moment they do.
      </p>

      <div className="flex items-center justify-center gap-3 flex-wrap">
        <Link
          href="/guide"
          className="font-ui text-sm px-4 py-2 transition-colors"
          style={{ background: 'var(--accent)', color: 'var(--paper)' }}
        >
          See how it works
        </Link>
        <Link
          href="/"
          className="font-ui text-sm px-4 py-2 border transition-colors hover:opacity-70"
          style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
        >
          Visit the garden
        </Link>
      </div>
    </div>
  )
}
