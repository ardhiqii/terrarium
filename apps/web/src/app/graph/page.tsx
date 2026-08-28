import { buildGraphData } from '@/lib/graph'
import GardenGraph from '@/components/graph/GardenGraph'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Graph',
  description: 'Visual map of all notes and projects and how they connect.',
}

export default function GraphPage() {
  const graphData = buildGraphData()

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-8">
        <h1 className="font-ui text-2xl font-semibold mb-2">
          Graph
        </h1>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          {graphData.nodes.length} nodes, {graphData.links.length} connections. Click a node to navigate.
        </p>
      </div>

      <GardenGraph data={graphData} />
    </div>
  )
}
