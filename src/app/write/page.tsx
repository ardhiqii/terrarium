import type { Metadata } from 'next'
import { ConnectGarden } from '@/components/garden/ConnectGarden'

// One name in all three places. This route used to call itself "Garden" in
// the nav, "Connect your garden" in its title, and "Connect a folder" in its
// own h1, which is three names for one destination.
export const metadata: Metadata = {
  title: 'Write',
  description:
    'Write and edit notes in a folder of your own markdown, entirely in your browser. Nothing uploads.',
}

/**
 * Server Component shell around the actual work, which is all client-side
 * (`ConnectGarden`, T23): the File System Access API, IndexedDB, and every
 * stats/XP computation here run in the browser tab, never on this server.
 *
 * No wrapper padding/max-width here (T25): `ConnectGarden` owns its own
 * container per phase now, since the connected state is a full-bleed,
 * full-height workspace and the disconnected/marketing states are a
 * centered column -- two different shapes that can't share one fixed
 * wrapper.
 */
export default function GardenPage() {
  return <ConnectGarden />
}
