'use client'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useEffect, useState, useRef, useCallback } from 'react'
import type { GraphData, GraphNode } from '@/lib/types'

const ForceGraph2D = dynamic(
  () => import('react-force-graph-2d').then((m) => m.default),
  { ssr: false }
)

interface GardenGraphProps {
  data: GraphData
}

export default function GardenGraph({ data }: GardenGraphProps) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [mounted, setMounted] = useState(false)
  const [hovered, setHovered] = useState<GraphNode | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: Math.max(500, entry.contentRect.width * 0.65),
        })
      }
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  const isDark = resolvedTheme === 'dark'

  const nodeColor = useCallback(
    (node: object) => {
      const n = node as GraphNode
      return n.type === 'project'
        ? isDark ? '#e8906e' : '#b55e3a'   // terracotta
        : isDark ? '#7cbf8e' : '#4a7c59'   // moss green
    },
    [isDark]
  )

  const handleNodeClick = useCallback(
    (node: object) => {
      const n = node as GraphNode
      router.push(n.href)
    },
    [router]
  )

  const handleNodeHover = useCallback((node: object | null) => {
    setHovered(node ? (node as GraphNode) : null)
    if (containerRef.current) {
      containerRef.current.style.cursor = node ? 'pointer' : 'default'
    }
  }, [])

  if (!mounted) {
    return (
      <div className="flex items-center justify-center" style={{ height: 500 }}>
        <p style={{ color: 'var(--muted)' }}>Loading graph…</p>
      </div>
    )
  }

  if (data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height: 300 }}>
        <p style={{ color: 'var(--muted)' }}>No content to graph yet.</p>
      </div>
    )
  }

  const bgColor = isDark ? '#0c0a09' : '#fafaf9'
  const linkColor = isDark ? 'rgba(250,250,249,0.25)' : 'rgba(28,25,23,0.2)'
  const labelColor = isDark ? '#e7e5e4' : '#1c1917'

  return (
    <div
      ref={containerRef}
      className="relative rounded-xl border overflow-hidden"
      style={{ borderColor: 'var(--border)', background: bgColor }}
    >
      {hovered && (
        <div
          className="absolute top-3 left-3 z-10 px-3 py-1.5 rounded-lg text-sm font-medium pointer-events-none"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        >
          {hovered.label}
          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
            {hovered.type}
          </span>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 flex gap-3 text-xs" style={{ color: 'var(--muted)' }}>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: nodeColor({ type: 'note', id: '', label: '', href: '' }) }} />
          note
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: nodeColor({ type: 'project', id: '', label: '', href: '' }) }} />
          project
        </span>
      </div>

      <ForceGraph2D
        graphData={data}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor={bgColor}
        nodeLabel="label"
        nodeColor={nodeColor}
        nodeRelSize={5}
        linkColor={() => linkColor}
        linkWidth={1}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        nodeCanvasObjectMode={() => 'after'}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as GraphNode & { x?: number; y?: number }
          if (!n.x || !n.y) return
          const label = n.label
          const fontSize = Math.max(10, 12 / globalScale)
          ctx.font = `${fontSize}px Inter, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillStyle = labelColor
          ctx.fillText(label, n.x, n.y + 8)
        }}
        enableZoomInteraction
        enablePanInteraction
        cooldownTicks={100}
      />
    </div>
  )
}
