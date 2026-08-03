interface GardenMarkProps {
  /** Rendered width in px. Height matches, the grid is square. */
  size?: number
  className?: string
}

/**
 * The garden mark: a sprout drawn on an 11x11 pixel grid.
 *
 * Pixel art rather than smooth vector, because the whole product is pixel
 * creatures. A rounded bezier leaf next to a 32x32 sprite reads as two
 * different products. This also survives being tiny: the cells land on whole
 * pixels instead of turning to mush.
 *
 * Colour comes from theme tokens, so it inverts correctly in dark mode. The
 * bud is the single accent, matching the rule that colour lives in the
 * creature sprites and not the site chrome.
 */

const GRID = 11

// '.' transparent · 'i' ink · 'm' muted · 'a' accent
const PIXELS = [
  '....aa.....',
  '....aa.....',
  '.....i.....',
  '..mm.i.ii..',
  '.mmmmiiiii.',
  '..mmmiii...',
  '.....i.....',
  '.....i.....',
  '.....i.....',
  '....iii....',
  '..mmmmmmm..',
] as const

const FILL: Record<string, string> = {
  i: 'var(--ink)',
  m: 'var(--ink-muted)',
  a: 'var(--accent)',
}

export default function GardenMark({ size = 40, className }: GardenMarkProps) {
  const cells: React.ReactElement[] = []

  for (let y = 0; y < PIXELS.length; y++) {
    const row = PIXELS[y]
    let x = 0
    while (x < row.length) {
      const ch = row[x]
      if (ch === '.') {
        x++
        continue
      }
      // Merge horizontal runs of the same colour into one rect, so the mark
      // stays a handful of nodes rather than 121 of them.
      let run = 1
      while (x + run < row.length && row[x + run] === ch) run++
      cells.push(
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={run}
          height={1}
          fill={FILL[ch]}
        />
      )
      x += run
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GRID} ${GRID}`}
      className={className}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {cells}
    </svg>
  )
}
