import type { ReactNode } from 'react'
import type { Stage } from '@/lib/game/types'

/**
 * The full evolution line, reached and unreached stages alike. Composed as a
 * grid of self-bordered cells (each cell owns its own border, following the
 * fix ItemDrawer already applied) rather than a shared-gap mesh, so the cell
 * count always equals `stages.length` and there is never a phantom trailing
 * tile. `auto-fill` also means this keeps working unchanged if the line ever
 * grows past four stages.
 *
 * Locked stages must not read as locked by colour alone (colour-blind users
 * cannot rely on it), so each locked cell carries three independent,
 * non-colour cues: a dashed border instead of solid, a desaturated and
 * dimmed sprite via `filter`, and an explicit "Not yet reached" label.
 *
 * Uses `auto-fit`, not `auto-fill`: `STAGES` is a small, known-length list
 * (4), so on a wide viewport there is no reason to reserve empty tracks.
 * `auto-fit` collapses tracks with nothing in them and lets the real cells
 * stretch to fill the row, so the line spans the section edge to edge
 * instead of hugging the left with dead space on the right. `auto-fill`
 * stays correct for `ItemDrawer`, whose count is expected to grow (T9) and
 * whose columns are meant to stay a fixed width rather than stretch.
 */
export interface StageLineProps {
  stages: readonly Stage[]
  /** `state.stage.index`, 1-based. */
  currentStageIndex: number
  /** Pre-rendered sprite for each stage, same order as `stages`. */
  sprites: ReactNode[]
}

export function StageLine({ stages, currentStageIndex, sprites }: StageLineProps) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}
    >
      {stages.map((stage, i) => {
        const reached = stage.index <= currentStageIndex
        const isCurrent = stage.index === currentStageIndex

        return (
          <div
            key={stage.id}
            className="flex flex-col items-center text-center gap-3 p-6"
            style={{
              border: isCurrent ? '2px solid var(--accent)' : '1px solid var(--rule)',
              background: isCurrent ? 'var(--paper-raised)' : 'var(--paper)',
            }}
          >
            {isCurrent && (
              <span
                className="font-data text-[10px] uppercase tracking-widest"
                style={{ color: 'var(--accent)', letterSpacing: '0.15em' }}
              >
                Current stage
              </span>
            )}

            {/* Fixed-height mount, `[&_img]:...` caps any oversized child.
                Code-generated sprites are always <=96px at this scale and
                never need it, but CreatureSprite's remote PokeAPI sprites
                vary per-Pokemon (a raw GIF up to 78x80 at scale 3 is
                240x240), and without this an oversized one overflows the
                box and paints over the stage name below it rather than
                being contained. `object-fit: contain` + `w-auto`/`h-auto`
                shrinks to fit while keeping the sprite's own aspect ratio,
                using the intrinsic size from its width/height attributes. */}
            <div
              className="h-24 flex items-center justify-center [&_img]:max-h-full [&_img]:max-w-full [&_img]:w-auto [&_img]:h-auto [&_img]:object-contain"
              style={
                reached
                  ? undefined
                  : { filter: 'grayscale(1) brightness(0.75)', opacity: 0.35 }
              }
            >
              {sprites[i]}
            </div>

            <h3 className="font-ui text-base font-semibold">{stage.name}</h3>
            <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
              {stage.threshold.toLocaleString()} xp
            </p>

            {reached ? (
              <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                {stage.blurb}
              </p>
            ) : (
              <p
                className="font-data text-[10px] uppercase tracking-wide px-2 py-1"
                style={{ border: '1px dashed var(--rule)', color: 'var(--ink-muted)' }}
              >
                Not yet reached
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
