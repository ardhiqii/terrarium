import type { Metadata } from 'next'
import { ConnectGarden } from '@/components/garden/ConnectGarden'

export const metadata: Metadata = {
  title: 'Connect your garden',
  description:
    'Point this site at a folder of your own markdown notes and see your creature computed entirely in your browser. Nothing uploads.',
}

/**
 * Server Component shell around the actual work, which is all client-side
 * (`ConnectGarden`, T23): the File System Access API, IndexedDB, and every
 * stats/XP computation here run in the browser tab, never on this server.
 */
export default function GardenPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          Bring your own garden
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Connect a folder
        </h1>
        <p className="font-prose text-base leading-relaxed max-w-2xl" style={{ color: 'var(--ink-muted)' }}>
          Your notes stay on your own disk. This page reads a folder you
          choose, computes the same creature and companion logic this site
          runs at build time, and renders it here, in this tab, with nothing
          sent to any server.
        </p>
      </div>

      <ConnectGarden />
    </div>
  )
}
