import type { Metadata } from 'next'
import Link from 'next/link'
import { getSessionProvider } from '@/lib/sync/session'
import { getSyncStore } from '@/lib/sync/sqlite-store'
import { getFollowing } from '@/lib/sync/github-following'
import { buildLeaderboardEntries } from '@/lib/sync/leaderboard'
import { LeaderboardList } from '@/components/profile/LeaderboardList'
import UnverifiedXpNote from '@/components/profile/UnverifiedXpNote'

export const metadata: Metadata = {
  title: 'Leaderboard',
  description: 'Friends you follow on GitHub who have also synced a garden.',
}

// Every response depends on the caller's session and the current
// following/synced-user state, so this must never be statically cached.
export const dynamic = 'force-dynamic'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          Friends only
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Leaderboard
        </h1>
        <p className="font-prose text-base leading-relaxed max-w-[52ch]" style={{ color: 'var(--ink-muted)' }}>
          Scoped to people you follow on GitHub who have also synced a
          garden here. Never a global ranking: a public board over public
          commit data would be farmed within a week, and friend scope
          removes the incentive instead of trying to police it.
        </p>
      </div>
      {children}
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="py-16 text-center max-w-[46ch] mx-auto"
      style={{ borderTop: '1px solid var(--rule)' }}
    >
      <p className="font-ui text-base font-semibold mb-2 mt-8">{title}</p>
      <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        {body}
      </p>
    </div>
  )
}

export default async function LeaderboardPage() {
  const session = await getSessionProvider().current()

  if (!session) {
    return (
      <Shell>
        <EmptyState
          title="Sign in to see it"
          body="The leaderboard only makes sense next to people you actually follow. Sign in with GitHub to see which of them have synced a garden."
        />
      </Shell>
    )
  }

  const following = await getFollowing(session.handle, { token: process.env.GITHUB_TOKEN })
  const handles = Array.from(new Set([...following, session.handle.toLowerCase()]))
  const users = await getSyncStore().getMany(handles)
  const entries = buildLeaderboardEntries(users, session.handle)

  if (entries.length === 0) {
    return (
      <Shell>
        <EmptyState
          title="Nobody you follow has synced yet"
          body="Once someone you follow on GitHub connects a garden, their creature shows up here. Share your own profile and be the first."
        />
      </Shell>
    )
  }

  return (
    <Shell>
      <LeaderboardList entries={entries} />
      <UnverifiedXpNote className="mt-6" />
      <p className="font-ui text-sm mt-6">
        <Link href={`/u/${session.handle}`} className="hover:opacity-70 transition-opacity" style={{ color: 'var(--accent)' }}>
          View your own profile
        </Link>
      </p>
    </Shell>
  )
}
