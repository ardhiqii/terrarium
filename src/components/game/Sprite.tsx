import type { CSSProperties } from 'react'
import type { SpriteData, SpriteScale } from '@/lib/game/types'
import { frameToRuns } from '@/lib/game/sprites/pixel-runs'

/**
 * Renders a `SpriteData` as inline SVG. Server component by default: there is
 * no interactivity here, only markup and CSS, so it never needs 'use client'.
 *
 * Pixels are drawn as `<rect>` elements with `shape-rendering="crispEdges"`
 * rather than a raster image, which keeps the art diffable at the data layer
 * and lets the same `SpriteData` back both this DOM renderer and the future
 * static-SVG GitHub embed. `scale` only ever accepts an integer factor
 * (1|2|3|4) per DESIGN.md 2.4: fractional or percentage scaling turns pixel
 * art to mush.
 *
 * A two-frame sprite gets a CSS-only idle animation: two full frames are
 * stacked and their opacity is flipped on opposite phases of a stepped
 * keyframe animation, so exactly one frame is ever visible and there is no
 * pixel bleed between poses. The animation only runs under
 * `@media (prefers-reduced-motion: no-preference)`; otherwise frame 0 is
 * static.
 */

interface SpriteProps {
  sprite: SpriteData
  scale: SpriteScale
  /** Accessible label. Defaults to the sprite id when omitted. */
  alt?: string
  className?: string
}

export default function Sprite({ sprite, scale, alt, className }: SpriteProps) {
  const { width, height, palette, frames, frameDurationMs } = sprite
  const pixelWidth = width * scale
  const pixelHeight = height * scale
  const label = alt ?? sprite.id
  // strict: true preserves this component's original behaviour of throwing
  // loudly on a malformed SpriteData rather than silently rendering a gap.
  const runsByFrame = frames.map((frame) => frameToRuns(frame, palette, { strict: true }))
  const isAnimated = runsByFrame.length > 1

  return (
    <svg
      role="img"
      aria-label={label}
      width={pixelWidth}
      height={pixelHeight}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      className={className}
      style={{ imageRendering: 'pixelated' }}
      data-sprite-id={sprite.id}
    >
      {isAnimated && (
        <style>{`
          .sprite-frame-0 { opacity: 1; }
          .sprite-frame-1 { opacity: 0; }
          @media (prefers-reduced-motion: no-preference) {
            .sprite-frame-0 {
              animation: sprite-flip-0 var(--sprite-duration, 900ms) steps(1, end) infinite;
            }
            .sprite-frame-1 {
              animation: sprite-flip-1 var(--sprite-duration, 900ms) steps(1, end) infinite;
            }
          }
          @keyframes sprite-flip-0 {
            0%, 50% { opacity: 1; }
            50.001%, 100% { opacity: 0; }
          }
          @keyframes sprite-flip-1 {
            0%, 50% { opacity: 0; }
            50.001%, 100% { opacity: 1; }
          }
        `}</style>
      )}
      {runsByFrame.map((runs, frameIndex) => (
        <g
          key={frameIndex}
          className={isAnimated ? `sprite-frame-${frameIndex}` : undefined}
          style={isAnimated ? ({ '--sprite-duration': `${frameDurationMs ?? 900}ms` } as CSSProperties) : undefined}
        >
          {runs.map((run, runIndex) => (
            <rect
              key={runIndex}
              x={run.x}
              y={run.y}
              width={run.length}
              height={1}
              fill={run.color}
            />
          ))}
        </g>
      ))}
    </svg>
  )
}
