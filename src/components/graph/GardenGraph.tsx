'use client'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { GraphData, GraphNode } from '@/lib/types'

const ForceGraph2D = dynamic(
  () => import('react-force-graph-2d').then((m) => m.default),
  { ssr: false }
)

interface GardenGraphProps {
  data: GraphData
}

// Canvas cannot resolve CSS custom properties directly, so the palette is
// read from computed styles at runtime instead of hardcoded here. This keeps
// the graph theme-correct without duplicating hex values from globals.css.
interface ResolvedPalette {
  paper: string
  ink: string
  inkMuted: string
  rule: string
  accent: string
  fontSans: string
}

function readPalette(): ResolvedPalette {
  const styles = getComputedStyle(document.documentElement)
  const get = (name: string) => styles.getPropertyValue(name).trim()
  return {
    paper: get('--paper'),
    ink: get('--ink'),
    inkMuted: get('--ink-muted'),
    rule: get('--rule'),
    accent: get('--accent'),
    fontSans: get('--font-sans') || 'sans-serif',
  }
}

// Blends two "#rrggbb" hex colours. Used to render budding notes as the
// midpoint of the seedling -> evergreen weight ramp, per DESIGN.md 2.1
// (maturity is a neutral weight ramp, never a third hue).
function mixHex(a: string, b: string, t: number): string {
  const pa = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(a.trim())
  const pb = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(b.trim())
  if (!pa || !pb) return a
  const ch = (i: number) => {
    const va = parseInt(pa[i], 16)
    const vb = parseInt(pb[i], 16)
    return Math.round(va + (vb - va) * t)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${ch(1)}${ch(2)}${ch(3)}`
}

// Converts "#rrggbb" to an rgba() string so link/node presence (weight,
// hover dimming) can be expressed as alpha without introducing a second hue.
function hexToRgba(hex: string, alpha: number): string {
  const p = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!p) return hex
  const r = parseInt(p[1], 16)
  const g = parseInt(p[2], 16)
  const b = parseInt(p[3], 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// react-force-graph mutates link.source/target in place, replacing the
// string id with the resolved node object, once the force engine has
// initialised. This works whichever form is currently present so
// weight/hover lookups never assume timing.
function endpointId(x: unknown): string | undefined {
  if (!x) return undefined
  if (typeof x === 'string') return x
  return (x as GraphNode).id
}

const MIN_RADIUS = 3
const MAX_RADIUS = 12
const LABEL_PX = 11
// Below this globalScale (zoomed further out), only hub nodes and the
// hovered node get a persistent label. Above it, the view is zoomed in
// enough that every label has room to breathe without colliding.
const ALL_LABELS_ZOOM = 2.4

// Presence tuning. Kept restrained per DESIGN.md 6: one accent, neutrals,
// no glow soup. Particles are the "living network" cue and nothing else
// animates, so this is the only place motion is introduced.
const DIMMED_ALPHA = 0.28
const PARTICLE_SPEED = 0.006
// react-force-graph divides the rendered photon radius by sqrt(globalScale),
// so this needs to be well above the visual target size to survive a close
// zoomToFit on a small graph. Tuned against an actual render, not a guess.
const PARTICLE_WIDTH = 3.4

export default function GardenGraph({ data }: GardenGraphProps) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [mounted, setMounted] = useState(false)
  const [hovered, setHovered] = useState<GraphNode | null>(null)
  const [palette, setPalette] = useState<ResolvedPalette | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const composedRef = useRef(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Particles are the only motion in this component; kill them entirely
  // when the user has asked for reduced motion, and stay in sync if the
  // OS-level preference changes mid-session.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (!mounted) return
    setPalette(readPalette())
  }, [mounted, resolvedTheme])

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

  // Hub set: nodes whose backlink count clears half the busiest node's
  // count (minimum 2). These keep their label rendered at every zoom level,
  // so hierarchy reads at a glance instead of after hovering every node.
  const hubIds = useMemo(() => {
    const maxBacklinks = data.nodes.reduce(
      (max, n) => Math.max(max, n.backlinkCount ?? 0),
      0
    )
    const threshold = Math.max(2, Math.ceil(maxBacklinks * 0.5))
    return new Set(
      data.nodes.filter((n) => (n.backlinkCount ?? 0) >= threshold).map((n) => n.id)
    )
  }, [data.nodes])

  const maxBacklinks = useMemo(
    () => Math.max(1, ...data.nodes.map((n) => n.backlinkCount ?? 0)),
    [data.nodes]
  )

  // Static id -> backlink count, independent of whether react-force-graph
  // has (yet) mutated a given link's source/target from a string id into
  // the resolved node object. Link-derived values (strength, particle
  // count) must not depend on that timing: react-force-graph caches
  // linkDirectionalParticles' photon count once per prop identity change,
  // so if strength were read off a not-yet-resolved link the very first
  // time and nothing forces a recompute afterwards, particles stay stuck
  // at zero forever even though linkColor/linkWidth (read fresh every
  // frame) look correct.
  const backlinkById = useMemo(() => {
    const map = new Map<string, number>()
    for (const n of data.nodes) map.set(n.id, n.backlinkCount ?? 0)
    return map
  }, [data.nodes])

  // Direct-neighbour lookup for hover: which nodes light up when a given
  // node is hovered. Built once per data set, not per frame.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const n of data.nodes) map.set(n.id, new Set())
    for (const l of data.links) {
      const s = endpointId((l as { source: unknown }).source)
      const t = endpointId((l as { target: unknown }).target)
      if (!s || !t) continue
      map.get(s)?.add(t)
      map.get(t)?.add(s)
    }
    return map
  }, [data.nodes, data.links])

  // A link's "weight" is how hub-connected it is: a link between two hubs
  // reads strong, a link out to a leaf reads faint, so the eye follows the
  // dense core instead of every hairline reading the same.
  const linkStrength = useCallback(
    (link: object) => {
      const l = link as { source: unknown; target: unknown }
      const sid = endpointId(l.source)
      const tid = endpointId(l.target)
      // `sid && get(sid)` would widen to `string | number` when the id is an
      // empty string, so branch explicitly to keep both sides numeric.
      const sb = sid ? backlinkById.get(sid) ?? 0 : 0
      const tb = tid ? backlinkById.get(tid) ?? 0 : 0
      // A garden with no backlinks at all would divide by zero.
      if (maxBacklinks <= 0) return 0
      return (sb + tb) / (2 * maxBacklinks)
    },
    [backlinkById, maxBacklinks]
  )

  const isLinkActive = useCallback(
    (link: object) => {
      if (!hovered) return true
      const l = link as { source: unknown; target: unknown }
      return endpointId(l.source) === hovered.id || endpointId(l.target) === hovered.id
    },
    [hovered]
  )

  const isNodeActive = useCallback(
    (id: string) => {
      if (!hovered) return true
      if (hovered.id === id) return true
      return adjacency.get(hovered.id)?.has(id) ?? false
    },
    [hovered, adjacency]
  )

  const nodeRadius = useCallback((n: GraphNode) => {
    const backlinks = n.backlinkCount ?? 0
    return Math.min(MAX_RADIUS, MIN_RADIUS + Math.sqrt(backlinks) * 2.6)
  }, [])

  const nodeFill = useCallback(
    (n: GraphNode) => {
      if (!palette) return '#000000'
      if (n.type === 'project') return palette.accent
      // Notes: neutral weight ramp by maturity, absent reads as seedling.
      if (n.maturity === 'evergreen') return palette.ink
      if (n.maturity === 'budding') return mixHex(palette.inkMuted, palette.ink, 0.55)
      return palette.inkMuted
    },
    [palette]
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

  // Fires once the pre-warmed simulation reaches its cooldown (immediately,
  // since cooldownTicks is 0 below). Frames the whole graph with no
  // animation so the page opens already composed instead of visibly
  // drifting into place. Runs once per data/mount cycle.
  const handleEngineStop = useCallback(() => {
    if (composedRef.current) return
    composedRef.current = true
    fgRef.current?.zoomToFit(0, 40)
  }, [])

  if (!mounted || !palette) {
    return (
      <div className="flex items-center justify-center" style={{ height: 500 }}>
        <p className="font-ui" style={{ color: 'var(--ink-muted)' }}>Loading graph.</p>
      </div>
    )
  }

  if (data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height: 300 }}>
        <p className="font-ui" style={{ color: 'var(--ink-muted)' }}>No content to graph yet.</p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative border overflow-hidden"
      style={{
        borderColor: 'var(--rule)',
        backgroundColor: 'var(--paper)',
        // Barely-there dot grid so the canvas reads as a space rather than
        // a blank sheet. Uses the existing hairline token via color-mix so
        // it stays exactly as subtle as --rule already is; no new palette
        // value. The canvas itself is transparent (see backgroundColor
        // below) so this shows through.
        backgroundImage:
          'radial-gradient(color-mix(in srgb, var(--rule) 85%, transparent) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      {hovered && (
        <div
          className="font-ui absolute top-3 left-3 z-10 px-3 py-1.5 text-sm font-medium pointer-events-none"
          style={{ background: 'var(--paper-raised)', border: '1px solid var(--rule)', color: 'var(--ink)' }}
        >
          {hovered.label}
          <span className="font-data ml-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
            {hovered.type === 'note' ? (hovered.maturity ?? 'seedling') : hovered.type}
            {' · '}
            {hovered.backlinkCount ?? 0} backlink{(hovered.backlinkCount ?? 0) === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* Legend. The ring, not colour, carries the note/project distinction,
          so it still reads with hue removed; size legend explains hierarchy. */}
      <div className="font-data absolute bottom-3 left-3 z-10 flex flex-wrap gap-4 text-xs uppercase" style={{ color: 'var(--ink-muted)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true">&#9679;</span> note
        </span>
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--accent)' }}>
          <span aria-hidden="true">&#9678;</span> project
        </span>
        <span>size = backlinks</span>
      </div>

      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="transparent"
        nodeLabel={() => ''}
        nodeVal={(node: object) => ((node as GraphNode).backlinkCount ?? 0) + 1}
        // Curved links read as an organic network instead of a wireframe of
        // straight struts, per DESIGN.md-adjacent brief T21.
        linkCurvature={0.22}
        linkColor={(link) => {
          const strength = linkStrength(link)
          // Base hue ramps from hairline to ink with weight, same
          // neutral-ramp language as note maturity: presence via weight,
          // never a second hue.
          const base = mixHex(palette.rule, palette.ink, strength)
          const active = isLinkActive(link)
          let alpha = 0.22 + strength * 0.62
          if (hovered) alpha = active ? Math.min(1, alpha + 0.3) : alpha * 0.15
          return hexToRgba(base, alpha)
        }}
        linkWidth={(link) => {
          const strength = linkStrength(link)
          const w = 0.5 + strength * 2.4
          return hovered && isLinkActive(link) ? w + 0.8 : w
        }}
        // Restrained directional particles: the single strongest "living
        // network" cue. Count scales with link strength so it stays rare
        // at 100 nodes (few hub-hub links), and hover both amplifies the
        // active neighbourhood and silences everything else.
        linkDirectionalParticles={
          reducedMotion
            ? 0
            : (link) => {
                const strength = linkStrength(link)
                if (hovered) return isLinkActive(link) ? (strength > 0.6 ? 2 : 1) : 0
                if (strength < 0.15) return 0
                return strength > 0.6 ? 2 : 1
              }
        }
        linkDirectionalParticleSpeed={PARTICLE_SPEED}
        linkDirectionalParticleWidth={PARTICLE_WIDTH}
        linkDirectionalParticleColor={() => hexToRgba(palette.accent, 0.55)}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as GraphNode & { x?: number; y?: number }
          if (n.x === undefined || n.y === undefined) return
          const r = nodeRadius(n)
          const isProject = n.type === 'project'
          const isHovered = hovered?.id === n.id
          const isHub = hubIds.has(n.id)
          const active = isNodeActive(n.id)
          const alpha = active ? 1 : DIMMED_ALPHA

          // Hub halo: a thin ring one step beyond the fill, in the node's
          // own hue at low opacity, so hubs read as objects with depth
          // rather than flat discs. Echoes the fill colour rather than
          // introducing a stroke hue of its own.
          if (isHub && !isHovered) {
            const ringR = r + 4 / globalScale
            ctx.beginPath()
            ctx.arc(n.x, n.y, ringR, 0, 2 * Math.PI)
            ctx.lineWidth = 1.4 / globalScale
            ctx.strokeStyle = hexToRgba(isProject ? palette.accent : palette.ink, active ? 0.45 : 0.15)
            ctx.stroke()
          }

          // Everything is a circle. Squares were tried for projects and read as
          // a rendering glitch rather than a category: in a force layout the
          // whole scene is organic and in motion, so a hard-edged shape looks
          // broken next to it. Sharp corners stay the language of the site
          // chrome, not of the graph.
          ctx.beginPath()
          ctx.arc(n.x, n.y, r, 0, 2 * Math.PI)
          ctx.fillStyle = hexToRgba(nodeFill(n), alpha)
          ctx.fill()

          // Projects carry a tight outline ring instead. Still a non-colour
          // signal, so the note/project split survives for a colour-blind
          // reader, but the silhouette language stays consistent.
          if (isProject) {
            ctx.beginPath()
            ctx.arc(n.x, n.y, r + 2.5 / globalScale, 0, 2 * Math.PI)
            ctx.lineWidth = 1.6 / globalScale
            ctx.strokeStyle = hexToRgba(palette.accent, active ? 0.9 : 0.2)
            ctx.stroke()
          }

          if (isHovered) {
            ctx.lineWidth = 1.5 / globalScale
            ctx.strokeStyle = palette.accent
            ctx.stroke()
          }

          // Label collision control: always show for the hovered node, its
          // direct neighbours (lighting up the neighbourhood on hover), and
          // hubs (high backlink count); otherwise only once zoomed in past
          // ALL_LABELS_ZOOM, where screen-space node spacing is wide enough
          // that labels no longer overlap on load.
          const isNeighborOfHovered = hovered ? (adjacency.get(hovered.id)?.has(n.id) ?? false) : false
          const showLabel = isHovered || isHub || isNeighborOfHovered || globalScale >= ALL_LABELS_ZOOM
          if (!showLabel) return

          const fontSize = LABEL_PX / globalScale
          const labelY = n.y + r + 3 / globalScale
          ctx.font = `${isHovered ? 600 : 400} ${fontSize}px ${palette.fontSans}, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'

          // Halo behind the label so it survives being drawn over a link,
          // standard in node-link diagrams. Font/size/casing untouched.
          ctx.lineWidth = 3 / globalScale
          ctx.lineJoin = 'round'
          ctx.strokeStyle = hexToRgba(palette.paper, active ? 0.9 : 0.6)
          ctx.strokeText(n.label, n.x, labelY)

          ctx.fillStyle = hexToRgba(isHovered ? palette.ink : palette.inkMuted, active ? 1 : DIMMED_ALPHA + 0.2)
          ctx.fillText(n.label, n.x, labelY)
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as GraphNode & { x?: number; y?: number }
          if (n.x === undefined || n.y === undefined) return
          const r = nodeRadius(n) + 2
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x, n.y, r, 0, 2 * Math.PI)
          ctx.fill()
        }}
        enableZoomInteraction
        enablePanInteraction
        // Pre-warm: run the physics settlement synchronously before the
        // first paint, then stop. The graph opens already composed instead
        // of visibly untangling on screen, which also satisfies
        // prefers-reduced-motion for free since nothing animates either way.
        warmupTicks={100}
        cooldownTicks={0}
        onEngineStop={handleEngineStop}
      />
    </div>
  )
}
