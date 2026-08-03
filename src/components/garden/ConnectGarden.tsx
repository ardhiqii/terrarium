'use client'

/**
 * Connect, disconnect, and render a garden read live from the user's own
 * disk. Everything below `handleConnect`/computeFromSource runs entirely in
 * the browser: `source.list()` reads file text via the File System Access
 * API, `parseGardenFiles` / `getGardenStatsFrom` / `detectClustersFrom` are
 * plain in-memory functions, and nothing here ever calls `fetch` with a
 * file's contents. A reviewer can grep this whole directory for `fetch(` and
 * find nothing that sends note text anywhere.
 *
 * Component reuse note (see the T23 report for the full explanation): `XpBar`
 * and `XpLedger` are reused verbatim, unmodified, since both are plain
 * presentational functions with no `async`/`fs` dependency. `SpecimenPlate`
 * and `CollectionGrid` could NOT be reused as-is: both are `async` Server
 * Components (React/Next.js do not support rendering an async component
 * inside a Client Component tree at all). `CreatureSprite` itself also
 * cannot be imported here for the same reason plus one more: it pulls in
 * `sprites/source.ts` -> `sprites/pokeapi.ts`, which imports `node:fs` for
 * its on-disk cache writer, and that import would break this whole 'use
 * client' bundle even if the fs code path were never called at runtime
 * (T25; this was the "home page shows Oddish, /garden shows the pixel
 * fallback" bug).
 *
 * The fix (T25): `sprites/pokeapi-pure.ts` is a client-safe module that
 * reads the *committed* `pokeapi-cache.json` as a plain data import -- no
 * fs, no network -- and resolves a stage to the same PokeAPI sprite the
 * server renders, falling back to the local sprite only when a stage truly
 * has no cached entry yet. `MiniCreature`/`ClusterTile` below render through
 * that plus `RemoteSprite`, the same hook-free rendering component
 * `CreatureSprite` uses server-side, so this really is the same renderer
 * and the same resolved sprite as the rest of the site, not a lookalike.
 */

import { useCallback, useEffect, useState } from 'react'
import { FsaGardenConnection } from '@/lib/garden-fs/fsa-source'
import EditorPane from './EditorPane'
import { loadHandle } from '@/lib/garden-fs/handle-store'
import type { GardenSource } from '@/lib/garden-fs/types'
import { parseGardenFiles } from '@/lib/garden-fs/parse'
import { getGardenStatsFrom } from '@/lib/game/stats-from-items'
// Import from `clusters-from-items`, NOT `clusters`: the latter imports
// `../backlinks`, which requires `fs` at module scope, and pulling that into a
// client bundle makes this page fail to render.
import {
  detectClustersFrom,
  type Cluster,
  CLUSTER_THRESHOLD,
} from '@/lib/game/clusters-from-items'
import { composeCreatureState, fallbackCreatureState } from '@/lib/game/repo-creature'
import type { CreatureState } from '@/lib/game/types'
import { resolvePureSpriteWithFallback } from '@/lib/game/sprites/pokeapi-pure'
import Sprite from '@/components/game/Sprite'
import RemoteSprite from '@/components/game/RemoteSprite'
import { XpBar } from '@/components/game/XpBar'
import { XpLedger } from '@/components/game/XpLedger'

const connection = new FsaGardenConnection()

type Phase =
  | { kind: 'checking' }
  | { kind: 'unsupported' }
  | { kind: 'disconnected' }
  | { kind: 'permission-denied' }
  | { kind: 'connecting' }
  | { kind: 'reading'; folderName: string }
  | {
      kind: 'ready'
      folderName: string
      noteCount: number
      totalFiles: number
      state: CreatureState
      clusters: Cluster[]
    }
  | { kind: 'error'; folderName: string; message: string }

function sectionLabel(text: string) {
  return (
    <p
      className="font-data text-xs font-semibold uppercase tracking-widest mb-3"
      style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
    >
      {text}
    </p>
  )
}

function MiniCreature({ state }: { state: CreatureState }) {
  const resolved = resolvePureSpriteWithFallback(state.stage.id)
  return (
    <div
      className="p-6 sm:p-8"
      style={{
        background: 'var(--paper-raised)',
        border: '1px solid var(--rule)',
        boxShadow: '0 2px 12px -4px rgba(20, 20, 22, 0.12)',
      }}
    >
      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 items-center sm:items-start">
        <div className="shrink-0 flex items-center justify-center">
          {resolved.kind === 'remote' ? (
            <RemoteSprite resolved={resolved} scale={3} alt={state.stage.name} stage={state.stage.id} />
          ) : (
            <Sprite sprite={resolved.data} scale={3} alt={state.stage.name} />
          )}
        </div>
        <div className="flex-1 w-full">
          <p
            className="font-data text-xs uppercase tracking-widest mb-1"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            Specimen {state.stage.index} of 4
          </p>
          <h2 className="font-ui text-2xl font-semibold tracking-tighter leading-[1.05] mb-2">
            {state.stage.name}
          </h2>
          <p className="font-prose text-sm leading-relaxed mb-5" style={{ color: 'var(--ink-muted)' }}>
            {state.stage.blurb}
          </p>
          <XpBar
            xpIntoStage={state.xpIntoStage}
            xpForNextStage={state.xpForNextStage}
            progress={state.progress}
          />
        </div>
      </div>
    </div>
  )
}

function ClusterTile({ cluster }: { cluster: Cluster }) {
  const resolved = resolvePureSpriteWithFallback(cluster.state.stage.id, cluster.speciesLine.id)
  return (
    <div
      className="relative flex flex-col items-center text-center gap-2 p-4"
      style={{
        background: 'var(--paper)',
        border: cluster.isNew ? '1px solid var(--accent)' : '1px solid var(--rule)',
      }}
    >
      {cluster.isNew && (
        <span
          className="absolute top-0 right-0 font-data text-[9px] uppercase tracking-widest px-1.5 py-0.5"
          style={{ background: 'var(--accent)', color: 'var(--paper)' }}
        >
          New
        </span>
      )}
      <div className="h-16 flex items-center justify-center">
        {resolved.kind === 'remote' ? (
          <RemoteSprite
            resolved={resolved}
            scale={2}
            alt={cluster.speciesLine.name}
            stage={cluster.state.stage.id}
          />
        ) : (
          <Sprite sprite={resolved.data} scale={2} alt={cluster.speciesLine.name} />
        )}
      </div>
      <p className="font-ui text-xs font-medium truncate w-full" title={cluster.tag}>
        #{cluster.tag}
      </p>
      <p className="font-data text-[10px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        {cluster.state.stage.name} · L{cluster.state.stage.index}
      </p>
      <p className="font-data text-[10px]" style={{ color: 'var(--ink-muted)' }}>
        {cluster.members.length} notes · {cluster.speciesLine.name}
      </p>
    </div>
  )
}

async function computeFromSource(
  source: GardenSource,
  onPhase: (phase: Phase) => void
): Promise<void> {
  onPhase({ kind: 'reading', folderName: source.name })
  try {
    const files = await source.list()

    if (files.length === 0) {
      onPhase({
        kind: 'ready',
        folderName: source.name,
        noteCount: 0,
        totalFiles: 0,
        state: fallbackCreatureState(false),
        clusters: [],
      })
      return
    }

    const items = parseGardenFiles(files)
    const stats = getGardenStatsFrom(items)
    // includeItems: false, isOwner: false -- this connection has no GitHub
    // data (nothing here ever calls the network for commit stats), and
    // items.ts's GARDEN_ITEMS predicates call getAllContent() (fs) when
    // isOwner is true, which would crash in the browser. Skipping the item
    // drawer entirely here is deliberate, not an oversight.
    const state = composeCreatureState(stats, null, { includeItems: false, isOwner: false })
    const clusters = detectClustersFrom(items)

    onPhase({
      kind: 'ready',
      folderName: source.name,
      noteCount: items.length,
      totalFiles: files.length,
      state,
      clusters,
    })
  } catch (err) {
    onPhase({
      kind: 'error',
      folderName: source.name,
      message: err instanceof Error ? err.message : 'Could not read this folder.',
    })
  }
}

/** Eyebrow + heading + one paragraph, shared by every non-workspace state
 *  (checking/unsupported/disconnected/permission-denied/connecting/reading/
 *  error). This is the "marketing" register (T25 problem 1): once
 *  connected, this copy disappears entirely and the writing surface takes
 *  over the whole screen. */
function Hero({ children }: { children: React.ReactNode }) {
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
      {children}
    </div>
  )
}

export function ConnectGarden() {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  // Held so the editor can write back to the same folder we read from. T23
  // computed from a local `source` and dropped it; T24 built the editor but
  // was not allowed to touch this file, so nothing wired the two together.
  const [source, setSource] = useState<GardenSource | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      if (!connection.isSupported()) {
        if (!cancelled) setPhase({ kind: 'unsupported' })
        return
      }

      const source = await connection.restore()
      if (cancelled) return

      if (source) {
        if (!cancelled) setSource(source)
        await computeFromSource(source, (p) => {
          if (!cancelled) setPhase(p)
        })
        return
      }

      // restore() returns null both when nothing was ever connected and when
      // a previously-granted permission has since been revoked (frozen
      // contract, garden-fs/types.ts). Check the stored handle directly to
      // tell those two apart for the copy shown below.
      const stored = await loadHandle()
      if (cancelled) return
      setPhase({ kind: stored ? 'permission-denied' : 'disconnected' })
    }

    init()
    return () => {
      cancelled = true
    }
  }, [])

  const handleConnect = useCallback(async () => {
    setPhase({ kind: 'connecting' })
    const source = await connection.connect()
    if (!source) {
      setPhase({ kind: 'disconnected' })
      return
    }
    setSource(source)
    await computeFromSource(source, setPhase)
  }, [])

  const handleDisconnect = useCallback(async () => {
    await connection.disconnect()
    setSource(null)
    setPhase({ kind: 'disconnected' })
  }, [])

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  if (phase.kind === 'checking') {
    return (
      <Hero>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          Checking for a previously connected garden…
        </p>
      </Hero>
    )
  }

  if (phase.kind === 'unsupported') {
    return (
      <Hero>
        <div className="mb-8">
          <p className="font-ui text-sm leading-relaxed max-w-xl" style={{ color: 'var(--ink-muted)' }}>
            This browser does not support the File System Access API, which
            today means anything outside Chromium (Chrome, Edge, Brave,
            Opera). Reading a folder of your own notes needs that API, so
            this page cannot show your garden here. Open this page in a
            Chromium browser to connect a folder, or visit the site's normal
            build for the commit-driven view of the creature.
          </p>
        </div>
        <MiniCreature state={fallbackCreatureState(false)} />
      </Hero>
    )
  }

  if (phase.kind === 'disconnected') {
    return (
      <Hero>
        <p className="font-ui text-sm leading-relaxed max-w-xl mb-6" style={{ color: 'var(--ink-muted)' }}>
          Point this at a folder of Markdown on your own disk: an Obsidian
          vault, a Logseq graph, or a plain folder of <code className="font-data text-xs">.md</code> files.
          Everything is read and computed in this browser tab. Nothing
          uploads.
        </p>
        <button
          onClick={handleConnect}
          className="font-ui text-sm font-medium px-5 py-2.5 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ink)', color: 'var(--paper)' }}
        >
          Connect garden folder
        </button>
      </Hero>
    )
  }

  if (phase.kind === 'permission-denied') {
    return (
      <Hero>
        <p className="font-ui text-sm leading-relaxed max-w-xl mb-6" style={{ color: 'var(--ink-muted)' }}>
          This browser previously had access to a garden folder, but that
          permission is no longer granted -- browsers can revoke folder
          access at any time, including after a restart. Reconnect to pick
          the folder again.
        </p>
        <button
          onClick={handleConnect}
          className="font-ui text-sm font-medium px-5 py-2.5 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ink)', color: 'var(--paper)' }}
        >
          Reconnect garden folder
        </button>
      </Hero>
    )
  }

  if (phase.kind === 'connecting') {
    return (
      <Hero>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          Waiting for folder selection…
        </p>
      </Hero>
    )
  }

  if (phase.kind === 'reading') {
    return (
      <Hero>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          Reading “{phase.folderName}”…
        </p>
      </Hero>
    )
  }

  if (phase.kind === 'error') {
    return (
      <Hero>
        <p className="font-ui text-sm leading-relaxed max-w-xl mb-4" style={{ color: 'var(--ink-muted)' }}>
          Something went wrong reading “{phase.folderName}”: {phase.message}
        </p>
        <button
          onClick={handleDisconnect}
          className="font-ui text-sm font-medium px-5 py-2.5 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ink)', color: 'var(--paper)' }}
        >
          Disconnect
        </button>
      </Hero>
    )
  }

  // phase.kind === 'ready': the hero disappears entirely. This is a
  // full-height workspace now, not a page with an editor stuck to it
  // (T25 problem 1). `min-h-[100dvh]` minus the navbar (`h-14` = 56px),
  // never `h-screen` per DESIGN.md 2.6 / the standing rule against it.
  if (phase.totalFiles === 0) {
    return (
      <Hero>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-8 pb-4 border-b" style={{ borderColor: 'var(--rule)' }}>
          <p className="font-ui text-base font-medium">{phase.folderName}</p>
          <button
            onClick={handleDisconnect}
            className="font-ui text-xs font-medium px-3 py-1.5 border transition-opacity hover:opacity-80"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
          >
            Disconnect
          </button>
        </div>
        <div className="border border-dashed p-12 text-center" style={{ borderColor: 'var(--rule)' }}>
          <p className="font-ui font-medium mb-1">No markdown here yet</p>
          <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
            This folder has no <code className="font-data text-xs">.md</code> or{' '}
            <code className="font-data text-xs">.mdx</code> files. Add some and reconnect.
          </p>
        </div>
      </Hero>
    )
  }

  return (
    <div className="flex flex-col" style={{ minHeight: 'calc(100dvh - 56px)' }}>
      {/* Thin status strip: folder name and disconnect. Everything else
          the old "connected" page showed (stats, companions) now lives
          below the workspace, reachable by scrolling, so the writing
          surface still owns the first screenful. */}
      <div
        className="flex items-center justify-between flex-wrap gap-2 px-4 sm:px-6 py-2 border-b"
        style={{ borderColor: 'var(--rule)' }}
      >
        <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
          {phase.folderName}
          <span className="ml-2">
            {phase.totalFiles} markdown {phase.totalFiles === 1 ? 'file' : 'files'}
          </span>
        </p>
        <button
          onClick={handleDisconnect}
          className="font-ui text-xs font-medium px-2 py-1 border transition-opacity hover:opacity-80"
          style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
        >
          Disconnect
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {source && <EditorPane source={source} creatureState={phase.state} />}
      </div>

      <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-16">
        <div className="grid sm:grid-cols-2 gap-8">
          <div>
            {sectionLabel('Observation log')}
            <XpLedger entries={phase.state.breakdown} total={phase.state.totalXp} />
          </div>
          <div>
            {sectionLabel('Folder stats')}
            <div className="font-data text-xs flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span style={{ color: 'var(--ink-muted)' }}>Notes read</span>
                <span>{phase.noteCount}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span style={{ color: 'var(--ink-muted)' }}>Words</span>
                <span>{phase.state.stats.totalWords.toLocaleString()}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span style={{ color: 'var(--ink-muted)' }}>Resolved links</span>
                <span>{phase.state.stats.resolvedWikilinks}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span style={{ color: 'var(--ink-muted)' }}>Backlinks</span>
                <span>{phase.state.stats.backlinksReceived}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span style={{ color: 'var(--ink-muted)' }}>Tags</span>
                <span>{phase.state.stats.tagCount}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12">
          {sectionLabel('Companions')}
          {phase.clusters.length === 0 ? (
            <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              No companions yet. A tag hatches one once it reaches {CLUSTER_THRESHOLD} notes.
            </p>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
            >
              {phase.clusters.map((cluster) => (
                <ClusterTile key={cluster.tag} cluster={cluster} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
