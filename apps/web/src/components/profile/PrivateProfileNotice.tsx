import Link from 'next/link'
import { CreatureSprite } from '@/components/game/CreatureSprite'

export interface PrivateProfileNoticeProps {
  handle: string
  /** True when the signed-in viewer is looking at their own profile. */
  isOwner?: boolean
}

/**
 * `/u/<handle>` for an account that has synced but has NOT opted in to a
 * public profile.
 *
 * This is deliberately NOT a 404 and deliberately shows nothing about the
 * account: the whole point of the privacy policy is that a hidden profile
 * leaks neither its creature nor its counts. The viewer only learns that a
 * choice exists, never what the choice is hiding.
 *
 * An owner sees the same page but with a route to change the setting, because
 * otherwise their own profile would look broken to them.
 */
export async function PrivateProfileNotice({ handle, isOwner = false }: PrivateProfileNoticeProps) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 sm:py-20 text-center">
      <div className="flex justify-center mb-6 opacity-30 grayscale">
        <CreatureSprite stage="sporeling" scale={3} alt="A private companion" />
      </div>

      <p
        className="font-data text-xs uppercase tracking-widest mb-2"
        style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
      >
        Private profile
      </p>
      <h1 className="font-ui text-2xl sm:text-3xl font-semibold tracking-tighter leading-[1.05] mb-4">
        @{handle}
        {' '}keeps their companion private
      </h1>
      <p
        className="font-prose text-base leading-relaxed mb-8 max-w-[52ch] mx-auto"
        style={{ color: 'var(--ink-muted)' }}
      >
        {isOwner
          ? 'Your companion is not public. Only you can see this page until you turn a public profile on.'
          : 'They have synced a garden, but a public profile is opt-in here. Nothing about their companion, progress, or notes is shown.'}
      </p>

      <div className="flex items-center justify-center gap-3 flex-wrap">
        {isOwner ? (
          <Link
            href="/github"
            className="font-ui text-sm px-4 py-2 transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--paper)' }}
          >
            Manage my profile visibility
          </Link>
        ) : (
          <Link
            href="/guide"
            className="font-ui text-sm px-4 py-2 transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--paper)' }}
          >
            See how it works
          </Link>
        )}
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
