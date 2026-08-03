/**
 * Pixel grid helpers used to author `SpriteData` frames programmatically.
 *
 * Hand-typing 32 rows of 32 characters is error-prone, so every sprite in
 * this module is built from a small set of primitives (rectangles,
 * ellipses, mirroring, auto-outlining) and only converted to the final
 * `string[]` frame shape at the end. The output still satisfies the
 * `SpriteData` contract exactly; this file is purely an authoring aid, not
 * a runtime dependency of the contract itself.
 */

/** Mutable working grid: `grid[y][x]` is a single palette-index character. */
export type Grid = string[][]

export function blankGrid(width: number, height: number): Grid {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => '0'),
  )
}

export function cloneGrid(grid: Grid): Grid {
  return grid.map((row) => [...row])
}

export function setPixel(grid: Grid, x: number, y: number, ch: string): void {
  if (y < 0 || y >= grid.length) return
  const row = grid[y]
  if (x < 0 || x >= row.length) return
  row[x] = ch
}

export function fillRect(
  grid: Grid,
  x: number,
  y: number,
  w: number,
  h: number,
  ch: string,
): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      setPixel(grid, col, row, ch)
    }
  }
}

/** Fills an axis-aligned ellipse centred on (cx, cy) with radii (rx, ry). */
export function fillEllipse(
  grid: Grid,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  ch: string,
): void {
  const height = grid.length
  const width = grid[0]?.length ?? 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) setPixel(grid, x, y, ch)
    }
  }
}

/**
 * Mirrors columns `0..axis-1` onto their reflection across the grid's
 * vertical centre line, for perfectly symmetric silhouettes.
 */
export function mirrorHorizontal(grid: Grid, axis: number): void {
  const width = grid[0]?.length ?? 0
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < axis; x++) {
      const mirroredX = width - 1 - x
      if (mirroredX >= 0 && mirroredX < width) {
        grid[y][mirroredX] = grid[y][x]
      }
    }
  }
}

/**
 * Stamps `outlineCh` onto every transparent pixel that is orthogonally
 * adjacent to a filled pixel. Run this last, after all fills, so every
 * sprite gets a crisp one-pixel edge regardless of how many shapes went
 * into it.
 */
export function outlineFrom(grid: Grid, outlineCh: string): void {
  const height = grid.length
  const width = grid[0]?.length ?? 0
  const base = cloneGrid(grid)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (base[y][x] !== '0') continue
      const neighbors = [
        base[y - 1]?.[x],
        base[y + 1]?.[x],
        base[y]?.[x - 1],
        base[y]?.[x + 1],
      ]
      if (neighbors.some((n) => n && n !== '0')) {
        grid[y][x] = outlineCh
      }
    }
  }
}

export function gridToFrame(grid: Grid): string[] {
  return grid.map((row) => row.join(''))
}
