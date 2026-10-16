'use client'

import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { SpriteScale } from '@/lib/game/types'
import Sprite from './Sprite'
import {
  hasRenderableLocalSprite,
  type CompanionAssetDescriptor,
} from '@/lib/game/companion-asset-descriptor'

export interface CompanionSpriteProps {
  /** A serializable descriptor produced at the asset boundary. */
  descriptor: CompanionAssetDescriptor
  /** Integer pixel scale. Defaults to 3. */
  scale?: SpriteScale
  /** Overrides the descriptor's accessible form label. */
  alt?: string
  className?: string
}

type FailureMode = 'static' | 'local'

function safeScale(value: SpriteScale | undefined): SpriteScale {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : 3
}

function safeHttpsUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function LocalCompanionSprite({
  descriptor,
  scale,
  label,
  className,
}: {
  descriptor: CompanionAssetDescriptor
  scale: SpriteScale
  label: string
  className?: string
}) {
  // Descriptors are normally constructed by the pure resolver. Keep this
  // guard at the rendering boundary as well: malformed restored data should
  // fail closed rather than hand invalid dimensions to the SVG renderer.
  if (!hasRenderableLocalSprite(descriptor)) return null
  return (
    <span
      className={className}
      data-companion-id={descriptor.companionId}
      data-companion-form={descriptor.formId}
      data-sprite-source="local"
    >
      <Sprite sprite={descriptor.local} scale={scale} alt={label} />
    </span>
  )
}

/**
 * Client-safe companion renderer. Remote animation is preferred, a still
 * provider asset is used for reduced motion and animation failure, and the
 * code-generated local sprite is the final fallback. No provider, filesystem,
 * or server cache module is reachable from this component.
 */
export function CompanionSprite({
  descriptor,
  scale: requestedScale = 3,
  alt,
  className,
}: CompanionSpriteProps) {
  const scale = safeScale(requestedScale)
  const label = alt?.trim() || descriptor.alt || descriptor.formName
  const remote = descriptor.remote
  const animatedUrl = safeHttpsUrl(remote?.animatedUrl)
  const staticUrl = safeHttpsUrl(remote?.staticUrl)
  const assetKey = [
    descriptor.companionId,
    descriptor.formId,
    animatedUrl ?? '',
    staticUrl ?? '',
  ].join(':')
  const [failed, setFailed] = useState<{ assetKey: string; mode: FailureMode } | null>(null)
  const failureMode = failed?.assetKey === assetKey ? failed.mode : null

  // An animated representation is only exposed when a static counterpart is
  // available. That makes the reduced-motion path safe even for a hand-built
  // descriptor that did not come through the resolver.
  const useAnimated = Boolean(animatedUrl && staticUrl && failureMode === null)
  const imageUrl = useAnimated ? animatedUrl : staticUrl

  if (!remote || !imageUrl || failureMode === 'local') {
    return (
      <LocalCompanionSprite
        descriptor={descriptor}
        scale={scale}
        label={label}
        className={className}
      />
    )
  }

  const width = Number.isInteger(remote.width) && remote.width > 0
    ? remote.width * scale
    : null
  const height = Number.isInteger(remote.height) && remote.height > 0
    ? remote.height * scale
    : null
  if (!width || !height) {
    return (
      <LocalCompanionSprite
        descriptor={descriptor}
        scale={scale}
        label={label}
        className={className}
      />
    )
  }

  const imageStyle: CSSProperties = {
    imageRendering: 'pixelated',
    filter:
      'drop-shadow(0 0 1px var(--sprite-halo)) drop-shadow(0 0 1px var(--sprite-halo))',
  }
  const nextFailureMode: FailureMode = useAnimated && staticUrl ? 'static' : 'local'

  return (
    <span
      className={className}
      data-companion-id={descriptor.companionId}
      data-companion-form={descriptor.formId}
      data-sprite-source={remote.source}
      data-sprite-motion={useAnimated ? 'animated' : 'static'}
    >
      <picture>
        {useAnimated && staticUrl && (
          <source srcSet={staticUrl} media="(prefers-reduced-motion: reduce)" />
        )}
        {/* Provider sprites are explicit-size GIF/PNG assets and must preserve
            GIF animation; next/image would require an unoptimized exception. */}
        <img
          src={imageUrl}
          width={width}
          height={height}
          alt={label}
          style={imageStyle}
          draggable={false}
          onError={() => setFailed({ assetKey, mode: nextFailureMode })}
        />
      </picture>
    </span>
  )
}

export default CompanionSprite

