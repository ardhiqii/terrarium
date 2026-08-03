import type { StageId, SpriteScale } from '@/lib/game/types'
import { STAGES } from '@/lib/game/types'
import { resolveWithFallback } from '@/lib/game/sprites/source'
import { DEFAULT_SPECIES_LINE_ID } from '@/lib/game/sprites/species'
import Sprite from './Sprite'
import RemoteSprite from './RemoteSprite'

/**
 * Drop-in creature renderer sitting in front of `SpriteSource`. Resolves the
 * PokeAPI sprite for the stage when available, animated GIF and all, and
 * falls back to the existing code-generated `Sprite` when it is not (no
 * network, a 404, a malformed cache entry). `resolveWithFallback` never
 * throws, so this component never throws either.
 *
 * Server component: fetching/caching happens at build time via the sprite
 * source, so there is no client-side data dependency here.
 */
export interface CreatureSpriteProps {
  stage: StageId
  /** Default 3. */
  scale?: SpriteScale
  /** Accessible label. Defaults to the stage name. */
  alt?: string
  /**
   * Which species line's PokeAPI ids to resolve against. Defaults to
   * `grass`, the GARDEN creature's line. Repo creatures pass their own
   * assigned line id (see `species-assign.ts`) so the collection actually
   * looks like a collection instead of a pile of identical creatures.
   */
  speciesLineId?: string
}

export async function CreatureSprite({
  stage,
  scale = 3,
  alt,
  speciesLineId = DEFAULT_SPECIES_LINE_ID,
}: CreatureSpriteProps): Promise<React.ReactElement> {
  const label = alt ?? STAGES.find((s) => s.id === stage)?.name ?? stage
  const resolved = await resolveWithFallback(stage, undefined, speciesLineId)

  if (resolved.kind === 'data') {
    return <Sprite sprite={resolved.data} scale={scale} alt={label} />
  }

  // Rendering delegated to `RemoteSprite`, the same hook-free component the
  // client-side `/garden` workspace renders through (see ConnectGarden.tsx),
  // so both surfaces produce identical markup for the same resolved sprite.
  return <RemoteSprite resolved={resolved} scale={scale} alt={label} stage={stage} />
}
