import type { Metadata } from 'next'
import { getSyncStore } from '@/lib/sync/store'
import { getSessionProvider } from '@/lib/sync/session'
import { getProfileVisibilityStore } from '@/lib/sync/profile-visibility-store'
import { isProfilePublic } from '@/lib/sync/profile-visibility'
import { ProfileSpecimen } from '@/components/profile/ProfileSpecimen'
import { NeverSyncedFunnel } from '@/components/profile/NeverSyncedFunnel'
import { PrivateProfileNotice } from '@/components/profile/PrivateProfileNotice'

interface Props {
  params: Promise<{ handle: string }>
}

// Handles register at any time via sync, so this route cannot be statically
// enumerated or cached the way notes/projects are.
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params
  return {
    title: `@${handle}`,
    description: `${handle}'s Terrarium companion.`,
  }
}

export default async function ProfilePage({ params }: Props) {
  const { handle } = await params
  const user = await getSyncStore().get(handle)

  if (!user) {
    return <NeverSyncedFunnel handle={handle} />
  }

  // PRIVACY GATE. A public profile is opt-in (PRODUCT.md): the default is
  // private, and a hidden profile reveals nothing at all — not the creature,
  // not the counts. The check is keyed by the immutable GitHub id, never the
  // mutable handle. The signed-in owner can always see their own profile so
  // the page does not look broken to them.
  const session = await getSessionProvider().current()
  const isOwner = session !== null && session.githubId === user.githubId

  if (!isOwner) {
    const policy = await getProfileVisibilityStore().get(user.githubId)
    if (!isProfilePublic(policy)) {
      return <PrivateProfileNotice handle={handle} />
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16">
      <ProfileSpecimen user={user} />
    </div>
  )
}
