/**
 * Validates every sprite in the registry against the `SpriteData` contract.
 * A malformed sprite must fail loudly, not render as garbage.
 *
 * Run directly with `npx tsx src/lib/game/sprites/validate.ts`, or import
 * `validateSprite` / `validateAllSprites` for use elsewhere (e.g. a test).
 */
import { SPRITES } from './index'
import type { SpriteData } from '../types'

export class SpriteValidationError extends Error {}

export function validateSprite(sprite: SpriteData): void {
  const { id, width, height, palette, frames } = sprite

  if (!Number.isInteger(width) || width <= 0) {
    throw new SpriteValidationError(`${id}: width must be a positive integer, got ${width}`)
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new SpriteValidationError(`${id}: height must be a positive integer, got ${height}`)
  }
  if (palette.length === 0) {
    throw new SpriteValidationError(`${id}: palette must not be empty`)
  }
  if (palette[0] !== 'transparent') {
    throw new SpriteValidationError(
      `${id}: palette[0] must be the string 'transparent', got ${JSON.stringify(palette[0])}`,
    )
  }
  for (let i = 1; i < palette.length; i++) {
    const entry = palette[i]
    if (!isValidColorEntry(entry)) {
      throw new SpriteValidationError(
        `${id}: palette[${i}] is not a valid colour, got ${JSON.stringify(entry)}. ` +
          `Expected a hex colour (e.g. '#3a2f1a') or a CSS custom property reference (e.g. 'var(--sprite-outline)')`,
      )
    }
  }
  if (frames.length === 0) {
    throw new SpriteValidationError(`${id}: must have at least one frame`)
  }

  frames.forEach((frame, frameIndex) => {
    if (frame.length !== height) {
      throw new SpriteValidationError(
        `${id}: frame ${frameIndex} has ${frame.length} rows, expected ${height}`,
      )
    }
    frame.forEach((row, rowIndex) => {
      if (row.length !== width) {
        throw new SpriteValidationError(
          `${id}: frame ${frameIndex} row ${rowIndex} has length ${row.length}, expected ${width}`,
        )
      }
      for (let col = 0; col < row.length; col++) {
        const ch = row[col]
        const paletteIndex = charToIndex(ch)
        if (paletteIndex === null || paletteIndex >= palette.length) {
          throw new SpriteValidationError(
            `${id}: frame ${frameIndex} row ${rowIndex} col ${col} has character ${JSON.stringify(
              ch,
            )}, which does not index a real palette entry (palette has ${palette.length} entries)`,
          )
        }
      }
    })
  })
}

/** Matches #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Matches a single CSS custom property reference, e.g. 'var(--sprite-outline)'. */
const CSS_VAR_RE = /^var\(--[a-zA-Z0-9-]+\)$/

/**
 * A non-transparent palette entry must be either a literal hex colour or a
 * `var(--...)` reference into the theme's CSS custom properties (used so
 * sprite outlines can be theme-aware, see globals.css `--sprite-outline`).
 * Anything else is malformed data and must fail loudly rather than silently
 * rendering as `currentColor` or an invalid SVG fill.
 */
function isValidColorEntry(entry: string): boolean {
  return HEX_COLOR_RE.test(entry) || CSS_VAR_RE.test(entry)
}

/** Decodes one sprite character (0-9 then a-z) to a palette index. */
function charToIndex(ch: string): number | null {
  if (ch.length !== 1) return null
  const code = ch.charCodeAt(0)
  const zero = '0'.charCodeAt(0)
  const nine = '9'.charCodeAt(0)
  const a = 'a'.charCodeAt(0)
  const z = 'z'.charCodeAt(0)
  if (code >= zero && code <= nine) return code - zero
  if (code >= a && code <= z) return 10 + (code - a)
  return null
}

export function validateAllSprites(sprites: Record<string, SpriteData>): void {
  const ids = Object.keys(sprites)
  if (ids.length === 0) {
    throw new SpriteValidationError('sprite registry is empty')
  }
  for (const id of ids) {
    const sprite = sprites[id]
    if (sprite.id !== id) {
      throw new SpriteValidationError(
        `registry key ${JSON.stringify(id)} does not match sprite.id ${JSON.stringify(sprite.id)}`,
      )
    }
    validateSprite(sprite)
  }
}

function main(): void {
  try {
    validateAllSprites(SPRITES)
    const ids = Object.keys(SPRITES)
    console.log(`OK: ${ids.length} sprites validated (${ids.join(', ')})`)
  } catch (err) {
    if (err instanceof SpriteValidationError) {
      console.error(`SPRITE VALIDATION FAILED: ${err.message}`)
    } else {
      console.error('SPRITE VALIDATION FAILED with an unexpected error:', err)
    }
    process.exit(1)
  }
}

// Only run when executed directly (`npx tsx validate.ts`), not on import.
if (require.main === module) {
  main()
}
