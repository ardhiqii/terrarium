/**
 * The four creature sprites: sporeling, mossling, bracken, heartwood.
 *
 * Each stage reuses the same 32x32 canvas and a small potted-specimen motif
 * (soil or ground, a stem or trunk, foliage on top) so the line reads as one
 * continuous growth rather than four unrelated icons. What changes stage to
 * stage is silhouette width, height, and mass: a single round blob barely
 * above the pot, then a fuller rounder mass, then tall complex fern fronds,
 * then a wide woody canopy over a real trunk. Two frames per creature give a
 * subtle idle: an up bob for the young stages, a side sway for the older,
 * taller ones whose top-heavy mass reads better swaying than bobbing.
 *
 * Botanical greens and browns are deliberately confined to this file. They
 * do not appear anywhere else in the product.
 */
import type { SpriteData } from '../types'
import {
  blankGrid,
  fillEllipse,
  fillRect,
  gridToFrame,
  outlineFrom,
} from './grid'

const SIZE = 32

// ---------------------------------------------------------------------------
// Sporeling - small, simple, a single sprout. Reads as barely-begun.
// ---------------------------------------------------------------------------

const SPORELING_PALETTE = [
  'transparent',
  'var(--sprite-outline)', // outline
  '#6b4a35', // pot body
  '#8a6245', // pot rim
  '#4a7c3f', // stem
  '#7cbf6b', // spore-leaf body
  '#a9e08f', // spore-leaf highlight
]

function buildSporeling(bob: number): string[] {
  const grid = blankGrid(SIZE, SIZE)
  // pot
  fillRect(grid, 12, 27, 8, 4, '2')
  fillRect(grid, 11, 26, 10, 1, '3')
  // stem, short
  fillRect(grid, 15, 20 + bob, 2, 7 - bob, '4')
  // single round leaf/spore head
  fillEllipse(grid, 16, 17 + bob, 4, 4, '5')
  fillEllipse(grid, 14, 15 + bob, 2, 2, '6')
  outlineFrom(grid, '1')
  return gridToFrame(grid)
}

const sporeling: SpriteData = {
  id: 'sporeling',
  width: SIZE,
  height: SIZE,
  palette: SPORELING_PALETTE,
  frames: [buildSporeling(0), buildSporeling(2)],
  frameDurationMs: 900,
}

// ---------------------------------------------------------------------------
// Mossling - leafier, rounder, clearly more substance.
// ---------------------------------------------------------------------------

const MOSSLING_PALETTE = [
  'transparent',
  'var(--sprite-outline)', // outline
  '#6b4a35', // pot body
  '#8a6245', // pot rim
  '#3f7a4a', // stem
  '#63a86b', // moss mid
  '#9cd98f', // moss light
  '#c8f2b0', // moss highlight
]

function buildMossling(bob: number): string[] {
  const grid = blankGrid(SIZE, SIZE)
  // pot, a size wider than the sporeling's
  fillRect(grid, 11, 27, 10, 4, '2')
  fillRect(grid, 10, 26, 12, 1, '3')
  // stem
  fillRect(grid, 15, 21 - bob, 2, 6 + bob, '4')
  // rounder, fuller foliage mass built from overlapping lobes
  fillEllipse(grid, 16, 16 - bob, 6, 6, '5')
  fillEllipse(grid, 10, 18 - bob, 3, 3, '6')
  fillEllipse(grid, 22, 18 - bob, 3, 3, '6')
  fillEllipse(grid, 13, 12 - bob, 2, 2, '7')
  outlineFrom(grid, '1')
  return gridToFrame(grid)
}

const mossling: SpriteData = {
  id: 'mossling',
  width: SIZE,
  height: SIZE,
  palette: MOSSLING_PALETTE,
  frames: [buildMossling(0), buildMossling(2)],
  frameDurationMs: 900,
}

// ---------------------------------------------------------------------------
// Bracken - fern-like, more complex silhouette, taller.
// ---------------------------------------------------------------------------

const BRACKEN_PALETTE = [
  'transparent',
  'var(--sprite-outline)', // outline
  '#6b4a35', // pot body
  '#8a6245', // pot rim
  '#5c4227', // woody stem
  '#2f6b3a', // frond dark
  '#4f9d55', // frond mid
  '#86cf78', // frond tip / highlight
]

function buildBracken(sway: number): string[] {
  const grid = blankGrid(SIZE, SIZE)
  // pot
  fillRect(grid, 11, 27, 10, 4, '2')
  fillRect(grid, 10, 26, 12, 1, '3')
  // tall central stem
  fillRect(grid, 15, 14, 2, 13, '4')
  // fronds: three contiguous tiers (no gap rows between them, unlike the
  // old 1px-gap bands) so the silhouette reads as one dense mass rather
  // than stacked stripes. Bands taper shorter toward the top and each pair
  // ends in a rounded lobe, borrowing mossling's overlapping-ellipse trick
  // for extra fill without losing the fern's radiating-frond read.
  fillRect(grid, 6, 20, 9, 3, '5')
  fillRect(grid, 17, 20, 9, 3, '5')
  fillEllipse(grid, 6, 21, 2, 2, '5')
  fillEllipse(grid, 25, 21, 2, 2, '5')
  fillRect(grid, 7 + sway, 17, 8, 3, '6')
  fillRect(grid, 17 + sway, 17, 8, 3, '6')
  fillEllipse(grid, 7 + sway, 18, 2, 2, '6')
  fillEllipse(grid, 24 + sway, 18, 2, 2, '6')
  fillRect(grid, 9 + sway, 14, 7, 3, '6')
  fillRect(grid, 16 + sway, 14, 7, 3, '6')
  fillEllipse(grid, 9 + sway, 15, 2, 2, '6')
  fillEllipse(grid, 22 + sway, 15, 2, 2, '6')
  // fern tip, larger and fuller than the old single small ellipse
  fillEllipse(grid, 16 + sway, 11, 4, 5, '7')
  outlineFrom(grid, '1')
  return gridToFrame(grid)
}

const bracken: SpriteData = {
  id: 'bracken',
  width: SIZE,
  height: SIZE,
  palette: BRACKEN_PALETTE,
  frames: [buildBracken(0), buildBracken(2)],
  frameDurationMs: 1100,
}

// ---------------------------------------------------------------------------
// Heartwood - substantial and woody, the established form.
// ---------------------------------------------------------------------------

const HEARTWOOD_PALETTE = [
  'transparent',
  'var(--sprite-outline)', // outline
  '#4a3320', // ground / roots
  '#6b4a2c', // trunk mid
  '#8a6242', // trunk highlight
  '#2f5c34', // canopy dark
  '#4f8a4a', // canopy mid
  '#7fbf6d', // canopy light
  '#b3e69c', // canopy highlight
]

function buildHeartwood(sway: number): string[] {
  const grid = blankGrid(SIZE, SIZE)
  // ground mound, no pot: this stage is planted, not potted
  fillEllipse(grid, 16, 29, 10, 3, '2')
  // trunk, thick and woody
  fillRect(grid, 13, 16, 6, 14, '3')
  fillRect(grid, 14, 16, 1, 14, '4')
  // wide canopy built from three overlapping lobes plus shade and highlight
  fillEllipse(grid, 16, 10, 11, 7, '5')
  fillEllipse(grid, 8 + sway, 13, 5, 5, '6')
  fillEllipse(grid, 24 + sway, 13, 5, 5, '6')
  fillEllipse(grid, 20 - sway, 14, 4, 3, '5')
  fillEllipse(grid, 12 + sway, 8, 3, 3, '8')
  fillEllipse(grid, 21 - sway, 9, 3, 3, '7')
  outlineFrom(grid, '1')
  return gridToFrame(grid)
}

const heartwood: SpriteData = {
  id: 'heartwood',
  width: SIZE,
  height: SIZE,
  palette: HEARTWOOD_PALETTE,
  frames: [buildHeartwood(0), buildHeartwood(2)],
  frameDurationMs: 1200,
}

export const CREATURE_SPRITES: Record<string, SpriteData> = {
  sporeling,
  mossling,
  bracken,
  heartwood,
}
