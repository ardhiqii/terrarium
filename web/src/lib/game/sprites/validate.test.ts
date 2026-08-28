/**
 * `validate.ts` only ran as a manual script (`npx tsx .../validate.ts`)
 * before this file existed, so a malformed sprite failed nobody. This wraps
 * it in real assertions: every sprite in the live registry must pass, and
 * the validator must still fail loudly on the specific bad shapes it claims
 * to catch (wrong row count, wrong row length, unknown palette index,
 * `palette[0]` not `'transparent'`, a malformed colour string).
 */
import { describe, it, expect } from 'vitest'
import {
  validateSprite,
  validateAllSprites,
  SpriteValidationError,
} from './validate'
import { SPRITES } from './index'
import type { SpriteData } from '../types'

function baseSprite(overrides: Partial<SpriteData> = {}): SpriteData {
  return {
    id: 'fixture',
    width: 2,
    height: 2,
    palette: ['transparent', '#112233'],
    frames: [['01', '10']],
    ...overrides,
  }
}

describe('validateAllSprites (real registry)', () => {
  it('the live sprite registry passes validation as-is', () => {
    expect(() => validateAllSprites(SPRITES)).not.toThrow()
  })

  it('the registry is non-empty', () => {
    expect(Object.keys(SPRITES).length).toBeGreaterThan(0)
  })

  it('every registry key matches its sprite.id', () => {
    for (const [key, sprite] of Object.entries(SPRITES)) {
      expect(sprite.id).toBe(key)
    }
  })

  it('throws on an empty registry', () => {
    expect(() => validateAllSprites({})).toThrow(SpriteValidationError)
  })

  it('throws when a registry key does not match sprite.id', () => {
    const bad = { mismatched: baseSprite({ id: 'other-id' }) }
    expect(() => validateAllSprites(bad)).toThrow(SpriteValidationError)
  })
})

describe('validateSprite: valid input', () => {
  it('accepts a well-formed sprite', () => {
    expect(() => validateSprite(baseSprite())).not.toThrow()
  })

  it('accepts a var(--...) palette entry alongside hex entries', () => {
    const sprite = baseSprite({
      palette: ['transparent', '#112233', 'var(--sprite-outline)'],
      frames: [['01', '20']],
    })
    expect(() => validateSprite(sprite)).not.toThrow()
  })

  it('accepts 3, 4, 6, and 8 digit hex colours', () => {
    const sprite = baseSprite({
      palette: ['transparent', '#abc', '#abcd', '#aabbcc', '#aabbccdd'],
      // One frame, two rows, using palette indices 0-4 across both rows so
      // every non-transparent palette entry above is actually referenced.
      frames: [['01', '23'], ['40', '12']],
    })
    expect(() => validateSprite(sprite)).not.toThrow()
  })
})

describe('validateSprite: malformed input fails loudly', () => {
  it('rejects a frame with the wrong row count', () => {
    const sprite = baseSprite({ height: 2, frames: [['01']] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
    expect(() => validateSprite(sprite)).toThrow(/rows/)
  })

  it('rejects a frame with the wrong row length', () => {
    const sprite = baseSprite({ width: 2, frames: [['0', '10']] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
    expect(() => validateSprite(sprite)).toThrow(/length/)
  })

  it('rejects a character that does not index a real palette entry', () => {
    // palette has 2 entries (indices 0-1); 'z' decodes to index 35.
    const sprite = baseSprite({ frames: [['0z', '10']] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects a character one past the end of the palette', () => {
    // palette has exactly 2 entries (indices 0-1); '2' decodes to index 2,
    // which is out of range by exactly one. Off-by-one regression guard.
    const sprite = baseSprite({ frames: [['02', '10']] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it("rejects palette[0] not being the string 'transparent'", () => {
    const sprite = baseSprite({ palette: ['#000000', '#112233'] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
    expect(() => validateSprite(sprite)).toThrow(/transparent/)
  })

  it('rejects a malformed colour string', () => {
    const sprite = baseSprite({ palette: ['transparent', 'not-a-color'] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects a colour string missing the var() wrapper', () => {
    const sprite = baseSprite({ palette: ['transparent', '--sprite-outline'] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects a hex colour with an invalid digit count', () => {
    const sprite = baseSprite({ palette: ['transparent', '#12345'] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects an empty palette', () => {
    const sprite = baseSprite({ palette: [] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects an empty frames array', () => {
    const sprite = baseSprite({ frames: [] })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects a non-integer width', () => {
    const sprite = baseSprite({ width: 2.5 })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects a zero or negative width', () => {
    expect(() => validateSprite(baseSprite({ width: 0 }))).toThrow(SpriteValidationError)
    expect(() => validateSprite(baseSprite({ width: -1 }))).toThrow(SpriteValidationError)
  })

  it('rejects a non-integer height', () => {
    const sprite = baseSprite({ height: 1.2 })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })

  it('rejects a zero or negative height', () => {
    expect(() => validateSprite(baseSprite({ height: 0 }))).toThrow(SpriteValidationError)
    expect(() => validateSprite(baseSprite({ height: -3 }))).toThrow(SpriteValidationError)
  })

  it('checks every frame, not just the first', () => {
    const sprite = baseSprite({
      frames: [
        ['01', '10'],
        ['0z', '10'], // second frame has the bad character
      ],
    })
    expect(() => validateSprite(sprite)).toThrow(SpriteValidationError)
  })
})
