'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'

/**
 * One serializable sprite slot for the interactive preview: either a remote
 * PokeAPI sprite or null (code-generated local fallback). The server resolves
 * every line x stage once, serializes into this shape, and hands it down.
 * See /preview/page.tsx.
 */
export interface PreviewSprite {
  /** Remote animated/static sprite URLs. Null when the local fallback is used. */
  url: string | null
  staticUrl: string | null
  width: number
  height: number
  animated: boolean
  /** The National Dex id for this line+stage, e.g. 191. */
  pokemonId: number
}

export interface PreviewLine {
  id: string
  name: string
  theme: string
  /** Ordered by stage index 1..4. */
  stages: PreviewSprite[]
}

export interface PreviewStage {
  id: string
  name: string
  index: number
}

interface PreviewStageProps {
  lines: PreviewLine[]
  stages: PreviewStage[]
}

const STAGE_BY_ID: Record<string, number> = {
  sporeling: 1,
  mossling: 2,
  bracken: 3,
  heartwood: 4,
}

/**
 * Interactive creature preview. One character in a framed container, with a
 * species-line picker and an evolution-stage selector (buttons 1..4, labelled
 * sporeling..heartwood). Selecting a stage swaps the displayed sprite. Sprite
 * animation is a PokeAPI idle GIF; walk/run/sleep states do not exist in this
 * sprite set, so the only dimension of change is evolution (and line).
 *
 * Optional `?line=<id>&stage=<id>` query params set the starting selection,
 * so a CollectionGrid tile can deep-link "preview this creature at its stage".
 *
 * Purely presentational: no game state, no XP, no fs. All sprite data arrives
 * via props, resolved once server-side.
 */
export default function PreviewStage({ lines, stages }: PreviewStageProps) {
  const searchParams = useSearchParams()
  const paramLine = searchParams.get('line')
  const paramStage = searchParams.get('stage')

  const [activeLineId, setActiveLineId] = useState(
    paramLine && lines.some((l) => l.id === paramLine) ? paramLine : (lines[0]?.id ?? '')
  )
  const [activeStageIndex, setActiveStageIndex] = useState(
    paramStage && STAGE_BY_ID[paramStage] ? STAGE_BY_ID[paramStage] : 1
  )

  const activeLine =
    lines.find((l) => l.id === activeLineId) ?? lines[0]
  // stages is ordered by index 1..4, so a plain array pick is correct.
  const activeSprite = activeLine?.stages[activeStageIndex - 1]

  return (
    <div className="flex flex-col gap-8">
      {/* The framed specimen — the "container" the character lives in. */}
      <div
        className="flex flex-col items-center justify-center gap-6 p-8 sm:p-12"
        style={{
          background: 'var(--paper-raised)',
          border: '1px solid var(--rule)',
          boxShadow: '0 2px 12px -4px rgba(20, 20, 22, 0.12)',
          minHeight: 320,
        }}
      >
        <div
          className="h-40 flex items-center justify-center [&_img]:max-h-full [&_img]:max-w-full [&_img]:w-auto [&_img]:h-auto [&_img]:object-contain"
        >
          {activeSprite?.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- PokeAPI GIF
            <img
              src={activeSprite.url}
              width={activeSprite.width * 4}
              height={activeSprite.height * 4}
              alt={`${activeLine?.name ?? ''} stage ${activeStageIndex}`}
              style={{ imageRendering: 'pixelated' }}
              draggable={false}
            />
          ) : (
            <p className="font-data text-sm" style={{ color: 'var(--ink-muted)' }}>
              local sprite
            </p>
          )}
        </div>

        <div className="text-center">
          {activeLine && (
            <h2 className="font-ui text-2xl font-semibold tracking-tighter mb-1">
              {activeLine.name}
            </h2>
          )}
          <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
            Stage {activeStageIndex} of {stages.length}
            {activeSprite && (
              <span style={{ color: 'var(--accent)' }}> · #{activeSprite.pokemonId}</span>
            )}
          </p>
        </div>
      </div>

      {/* Evolution selector: 1..4 */}
      <div>
        <p className="font-data text-xs uppercase tracking-widest mb-3" style={{ color: 'var(--ink-muted)' }}>
          Evolution stage
        </p>
        <div className="flex flex-wrap gap-2">
          {stages.map((stage) => {
            const selected = stage.index === activeStageIndex
            return (
              <button
                key={stage.id}
                type="button"
                onClick={() => setActiveStageIndex(stage.index)}
                aria-pressed={selected}
                className="ui-row font-ui px-4 py-2 text-sm rounded"
                style={{
                  border: selected ? '1px solid var(--accent)' : '1px solid var(--rule)',
                  background: selected ? 'var(--paper-raised)' : 'var(--paper)',
                  color: selected ? 'var(--ink)' : 'var(--ink-muted)',
                  fontWeight: selected ? 500 : 400,
                }}
              >
                {stage.index}
              </button>
            )
          })}
        </div>
      </div>

      {/* Line picker */}
      <div>
        <p className="font-data text-xs uppercase tracking-widest mb-3" style={{ color: 'var(--ink-muted)' }}>
          Species line
        </p>
        <div className="flex flex-wrap gap-2">
          {lines.map((line) => {
            const selected = line.id === activeLineId
            return (
              <button
                key={line.id}
                type="button"
                onClick={() => setActiveLineId(line.id)}
                aria-pressed={selected}
                className="ui-row font-ui px-3 py-2 text-sm rounded"
                style={{
                  border: selected ? '1px solid var(--accent)' : '1px solid var(--rule)',
                  background: selected ? 'var(--paper-raised)' : 'var(--paper)',
                  color: selected ? 'var(--ink)' : 'var(--ink-muted)',
                  fontWeight: selected ? 500 : 400,
                }}
              >
                {line.name}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
