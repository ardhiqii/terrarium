import { ImageResponse } from 'next/og'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

const ACCENT = '#2f4bd4'
const PAPER = '#f1f1ee'

/**
 * iOS home-screen icon. Uses the 11x11 grid from `GardenMark`, not the
 * favicon's reduced 7x7, because at 180px there is plenty of room for the
 * detail and it should match the site logo exactly.
 */

const GRID = 11

// 'p' paper · 'm' muted paper · '.' background
// Matches GardenMark's grid exactly.
const PIXELS = [
  '....pp.....',
  '....pp.....',
  '.....p.....',
  '..mm.p.pp..',
  '.mmmmppppp.',
  '..mmmppp...',
  '.....p.....',
  '.....p.....',
  '.....p.....',
  '....ppp....',
  '..mmmmmmm..',
]

const FILL: Record<string, string> = { p: PAPER, m: PAPER }
const OPACITY: Record<string, number> = { p: 1, m: 0.65 }

export default function AppleIcon() {
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
          opacity={OPACITY[ch]}
        />
      )
      x += run
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: ACCENT,
        }}
      >
        <svg width="150" height="150" viewBox={`0 0 ${GRID} ${GRID}`}>
          {cells}
        </svg>
      </div>
    ),
    { ...size }
  )
}
