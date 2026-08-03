/**
 * Run-length pixel-to-rect conversion, shared by `Sprite.tsx` (the DOM/SVG
 * inline renderer) and `svg-render.ts` (the static README-badge renderer).
 * Both used to carry an independent copy of this; this module is the single
 * implementation both import, so a change to sprite rendering only has to
 * happen once. Output is unchanged from both previous copies: same run
 * boundaries, same coordinates, same colors for the same inputs.
 *
 * The two callers differ in exactly two ways, both exposed as options:
 *   - `Sprite.tsx` throws on an out-of-palette character (a malformed
 *     `SpriteData` is a bug worth surfacing loudly in the DOM render path);
 *     `svg-render.ts` must never throw (a README badge must always render
 *     something, never a 500), so it treats an unknown character as
 *     transparent (palette index 0) instead. That is `strict`.
 *   - `svg-render.ts` resolves each raw palette color through a theme-aware
 *     function (`var(--sprite-outline)` has no meaning outside the site's
 *     own DOM, so it is swapped for a concrete hex value); `Sprite.tsx`
 *     renders inside the real DOM, so it uses the raw palette color
 *     unchanged and lets the CSS variable resolve normally. That is the
 *     optional `resolveColor` callback.
 */

export interface PixelRun {
  x: number
  y: number
  length: number
  color: string
}

const CHAR_ZERO = '0'.charCodeAt(0)
const CHAR_NINE = '9'.charCodeAt(0)
const CHAR_A = 'a'.charCodeAt(0)
const CHAR_Z = 'z'.charCodeAt(0)

export interface CharToIndexOptions {
  /** Throw on an out-of-palette character instead of treating it as index 0. */
  strict?: boolean
}

export function charToIndex(ch: string, options: CharToIndexOptions = {}): number {
  const code = ch.charCodeAt(0)
  if (code >= CHAR_ZERO && code <= CHAR_NINE) return code - CHAR_ZERO
  if (code >= CHAR_A && code <= CHAR_Z) return 10 + (code - CHAR_A)
  if (options.strict) {
    throw new Error(`Sprite: character ${JSON.stringify(ch)} is not a valid palette index`)
  }
  return 0
}

export interface FrameToRunsOptions {
  /** See `charToIndex`. Defaults to false (lenient, never throws). */
  strict?: boolean
  /** Applied to each resolved palette color before it lands on a run. */
  resolveColor?: (rawColor: string) => string
}

/** Collapses each row's runs of identical, non-transparent pixels into rects. */
export function frameToRuns(
  frame: string[],
  palette: string[],
  options: FrameToRunsOptions = {}
): PixelRun[] {
  const { strict = false, resolveColor = (c: string) => c } = options
  const runs: PixelRun[] = []

  frame.forEach((row, y) => {
    let runStart = -1
    let runColor = ''

    const flush = (endX: number) => {
      if (runStart === -1) return
      runs.push({ x: runStart, y, length: endX - runStart, color: runColor })
      runStart = -1
    }

    for (let x = 0; x < row.length; x++) {
      const paletteIndex = charToIndex(row[x], { strict })
      const isTransparent = paletteIndex === 0
      const color = resolveColor(palette[paletteIndex] ?? 'transparent')

      if (isTransparent) {
        flush(x)
        continue
      }
      if (runStart !== -1 && color === runColor) continue
      flush(x)
      runStart = x
      runColor = color
    }
    flush(row.length)
  })

  return runs
}
