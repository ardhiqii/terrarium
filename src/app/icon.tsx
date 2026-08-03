import { ImageResponse } from 'next/og'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

// ImageResponse renders via satori, which cannot read CSS custom properties,
// so the tokens from globals.css are inlined as literals.
const ACCENT = '#2f4bd4'
const PAPER = '#f1f1ee'

/**
 * Favicon: the same pixel sprout as `GardenMark`, reduced from 11x11 to 7x7.
 *
 * Same mark and same language as the site logo. Only the resolution changes,
 * because 11 cells across a 16px tab is 1.4px per cell, which is sub-pixel and
 * turns to mush. Seven cells give roughly 2.3px each and stay crisp.
 *
 * Paper on accent rather than ink on paper, since a pale square with a dark
 * mark is what made the earlier favicon read as a smudge, and this holds
 * contrast against both light and dark browser chrome.
 */

const GRID = 7

// 'p' paper · '.' background
const PIXELS = [
  '..p.p..',
  '.ppppp.',
  '.ppppp.',
  '...p...',
  '...p...',
  '...p...',
  '..ppp..',
]

export default function Icon() {
  const cells: React.ReactElement[] = []
  for (let y = 0; y < PIXELS.length; y++) {
    const row = PIXELS[y]
    let x = 0
    while (x < row.length) {
      if (row[x] !== 'p') {
        x++
        continue
      }
      let run = 1
      while (x + run < row.length && row[x + run] === 'p') run++
      cells.push(
        <rect key={`${x}-${y}`} x={x} y={y} width={run} height={1} fill={PAPER} />
      )
      x += run
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: ACCENT,
        }}
      >
        <svg width="28" height="28" viewBox={`0 0 ${GRID} ${GRID}`}>
          {cells}
        </svg>
      </div>
    ),
    { ...size }
  )
}
