/**
 * The sprite registry. Every creature and item sprite in the product is
 * looked up through here; nothing outside `apps/web/src/lib/game/sprites` should
 * construct `SpriteData` directly.
 */
import type { SpriteData } from '../types'
import { CREATURE_SPRITES } from './creatures'
import { ITEM_SPRITES } from './items'

export const SPRITES: Record<string, SpriteData> = {
  ...CREATURE_SPRITES,
  ...ITEM_SPRITES,
}

export function getSprite(id: string): SpriteData | null {
  return SPRITES[id] ?? null
}
