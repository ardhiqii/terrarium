import type { Metadata } from 'next'
import { getSyncStore } from '@/lib/sync/store'
import { ProfileSpecimen } from '@/components/profile/ProfileSpecimen'
import { NeverSyncedFunnel } from '@/components/profile/NeverSyncedFunnel'

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

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16">
      <ProfileSpecimen user={user} />
    </div>
  )
}
