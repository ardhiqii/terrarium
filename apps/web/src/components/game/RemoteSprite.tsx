/**
 * Renders a resolved PokeAPI sprite (`kind: 'remote'`) as an animated `<img>`
 * with a `prefers-reduced-motion` still-image swap. Deliberately a plain,
 * hook-free function component with no `node:fs` in its import graph, so it
 * can be shared verbatim between `CreatureSprite` (an async Server
 * Component, used on the home page and elsewhere) and `ConnectGarden` (a
 * `'use client'` component, used in the `/garden` workspace). That sharing
 * is the point: it is what guarantees the two surfaces render pixel-identical
 * markup for the same resolved sprite, rather than two hand-maintained
 * copies drifting apart.
 */
import type { CSSProperties } from 'react'

export interface RemoteSpriteResolved {
  url: string
  staticUrl: string | null
  width: number
  height: number
  animated: boolean
}

export interface RemoteSpriteProps {
  resolved: RemoteSpriteResolved
  /** Integer scale factor only, per DESIGN.md 2.4. */
  scale: number
  alt: string
  /** Stage id, stamped onto `data-sprite-stage` for tests/debugging. */
  stage: string
}

export default function RemoteSprite({ resolved, scale, alt, stage }: RemoteSpriteProps) {
  // Integer scaling only, per DESIGN.md 2.4: fractional or percentage
  // scaling turns pixel art to mush.
  const width = resolved.width * scale
  const height = resolved.height * scale

  const imgStyle: CSSProperties = {
    imageRendering: 'pixelated',
    // Dark-mode-only halo (T14): these are PokeAPI GIFs with the outline
    // baked into the pixels, so unlike local sprites (which flip via
    // --sprite-outline) the color can't be changed. A drop-shadow traces
    // the alpha silhouette rather than the bounding box, so it doesn't blur
    // the raster or shift layout. Two stacked shadows even out coverage on
    // thin leaf tips; --sprite-halo resolves to `transparent` in light
    // mode, so this is a no-op there.
    filter:
      'drop-shadow(0 0 1px var(--sprite-halo)) drop-shadow(0 0 1px var(--sprite-halo))',
  }

  // A CSS media query cannot pause a GIF: once the browser starts decoding
  // an animated GIF it keeps playing regardless of any `@media` rule, so
  // `prefers-reduced-motion: reduce` needs an actual different image, not a
  // style override. `<picture>` picks a source declaratively based on a
  // `media` condition before the browser ever requests the GIF, so a
  // reduced-motion visitor never downloads or decodes the animated asset at
  // all.
  return (
    <picture>
      {resolved.animated && resolved.staticUrl && (
        <source srcSet={resolved.staticUrl} media="(prefers-reduced-motion: reduce)" />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- animated GIF;
          next/image would need `unoptimized` to avoid stripping the
          animation, and a plain <img> with explicit dimensions is simpler
          and just as safe against layout shift. */}
      <img
        src={resolved.url}
        width={width}
        height={height}
        alt={alt}
        style={imgStyle}
        data-sprite-source="pokeapi"
        data-sprite-stage={stage}
      />
    </picture>
  )
}
