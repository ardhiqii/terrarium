/**
 * The seven item sprites. Single frame each: items are unlocked states, not
 * animated inventory.
 *
 * Deliberately kept out of the botanical green/brown family that belongs to
 * the creature line; these read as collected specimen-drawer objects (glass,
 * brass, paper, pressed sepia) rather than more plant matter.
 */
import type { SpriteData } from '../types'
import {
  blankGrid,
  fillEllipse,
  fillRect,
  gridToFrame,
  outlineFrom,
  setPixel,
} from './grid'

const SIZE = 32

// ---------------------------------------------------------------------------
// Spore Jar - Publish 5 notes
// ---------------------------------------------------------------------------

const sporeJar: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 12, 7, 8, 4, '3') // lid
  fillRect(grid, 13, 10, 6, 4, '2') // neck
  fillEllipse(grid, 16, 14, 6, 2, '2') // shoulder
  fillRect(grid, 10, 14, 12, 13, '2') // body
  fillEllipse(grid, 16, 27, 6, 2, '2') // base curve
  // scattered spores inside
  setPixel(grid, 13, 20, '4')
  setPixel(grid, 18, 22, '4')
  setPixel(grid, 15, 24, '4')
  setPixel(grid, 19, 18, '4')
  setPixel(grid, 12, 16, '5')
  outlineFrom(grid, '1')
  return {
    id: 'spore-jar',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#7fb8c2', // glass
      '#9a7b3f', // brass lid
      '#d8b25a', // spore, gold
      '#f0d98a', // spore, pale gold
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Dew Vial - 7 consecutive days with a commit or a note edit
// ---------------------------------------------------------------------------

const dewVial: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 13, 7, 6, 4, '3') // cork
  fillRect(grid, 14, 11, 4, 15, '2') // glass tube
  fillEllipse(grid, 16, 26, 2, 2, '2') // rounded base
  fillRect(grid, 14, 19, 4, 7, '4') // dew fill, lower portion
  fillEllipse(grid, 16, 19, 2, 1, '4')
  setPixel(grid, 15, 13, '5') // glass highlight
  setPixel(grid, 15, 15, '5')
  outlineFrom(grid, '1')
  return {
    id: 'dew-vial',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#bcd6da', // glass
      '#8a6242', // cork
      '#6fa9c9', // dew, blue
      '#e4f1f4', // glass highlight
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Hand Lens - a single note reaches 5 backlinks
// ---------------------------------------------------------------------------

const handLens: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 19, 20, 3, 10, '3') // handle
  fillEllipse(grid, 14, 14, 9, 9, '2') // brass rim
  fillEllipse(grid, 14, 14, 7, 7, '4') // glass
  setPixel(grid, 11, 11, '5') // glass glint
  setPixel(grid, 12, 11, '5')
  setPixel(grid, 11, 12, '5')
  outlineFrom(grid, '1')
  return {
    id: 'hand-lens',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#a9793f', // brass rim
      '#8a6242', // handle wood
      '#bfe3ea', // glass
      '#eef8fa', // glint
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Trowel - publish your first project
// ---------------------------------------------------------------------------

const trowel: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 11, 5, 8, 6, '3') // wood grip
  fillRect(grid, 13, 11, 4, 3, '4') // ferrule
  // tapered blade, widest below the ferrule, narrowing to a point
  fillRect(grid, 12, 14, 6, 3, '2')
  fillRect(grid, 13, 17, 4, 3, '2')
  fillRect(grid, 14, 20, 2, 3, '2')
  setPixel(grid, 15, 23, '2')
  setPixel(grid, 13, 15, '5') // blade highlight
  outlineFrom(grid, '1')
  return {
    id: 'trowel',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#9aa0a6', // steel blade
      '#8a6242', // wood grip
      '#c8ccd0', // ferrule
      '#dfe3e6', // blade highlight
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Field Ledger - reach 25 notes
// ---------------------------------------------------------------------------

const fieldLedger: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 8, 8, 16, 20, '2') // cover
  fillRect(grid, 9, 9, 12, 18, '3') // pages
  fillRect(grid, 21, 9, 1, 18, '4') // page edge
  fillRect(grid, 8, 8, 2, 20, '5') // spine
  fillRect(grid, 12, 13, 6, 1, '1') // ruled line
  fillRect(grid, 12, 17, 6, 1, '1')
  fillRect(grid, 12, 21, 6, 1, '1')
  outlineFrom(grid, '1')
  return {
    id: 'field-ledger',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline / rule
      '#6b4a2c', // cover
      '#e8e0c8', // pages
      '#d8cfae', // page edge
      '#4a3320', // spine
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Brass Compass - use 10 distinct tags
// ---------------------------------------------------------------------------

const brassCompass: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillEllipse(grid, 16, 16, 10, 10, '2') // case
  fillEllipse(grid, 16, 16, 8, 8, '3') // face
  fillRect(grid, 15, 9, 1, 6, '4') // needle, north (red)
  fillRect(grid, 15, 17, 1, 6, '5') // needle, south (blue)
  setPixel(grid, 16, 16, '6') // pin
  outlineFrom(grid, '1')
  return {
    id: 'brass-compass',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#a9793f', // brass case
      '#e8ddb8', // dial face
      '#b5573f', // needle, red
      '#3f6fa8', // needle, blue
      '#2a2418', // centre pin
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Pressed Frond - a note reaches evergreen
// ---------------------------------------------------------------------------

const pressedFrond: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 15, 4, 2, 24, '2') // stem
  const leaflets: Array<[number, number, 'left' | 'right']> = [
    [7, 1, 'left'],
    [10, 1, 'right'],
    [13, 1, 'left'],
    [16, 1, 'right'],
    [19, 1, 'left'],
    [22, 1, 'right'],
  ]
  for (const [y, w, side] of leaflets) {
    const x = side === 'left' ? 15 - w * 3 : 17
    fillRect(grid, x, y, w * 3, 2, '3')
  }
  fillEllipse(grid, 16, 5, 2, 3, '4') // tip
  outlineFrom(grid, '1')
  return {
    id: 'pressed-frond',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#7a5a3a', // stem, sepia
      '#a9814f', // leaflet, sepia
      '#c9a56b', // tip, pale sepia
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Ember Trail - a commit streak, GitHub data only
// ---------------------------------------------------------------------------

const emberTrail: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 15, 24, 2, 4, '2') // wick base
  fillEllipse(grid, 16, 20, 5, 6, '3') // outer flame
  fillEllipse(grid, 16, 21, 3, 4, '4') // inner flame
  fillEllipse(grid, 16, 22, 2, 2, '5') // core
  setPixel(grid, 15, 12, '4') // ember spark, trailing up
  setPixel(grid, 18, 10, '5')
  setPixel(grid, 20, 14, '4')
  outlineFrom(grid, '1')
  return {
    id: 'ember-trail',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#6b4a2c', // wick, sepia
      '#b5573f', // outer flame
      '#d8834a', // inner flame
      '#f0c463', // core, pale gold
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Field Burst - a single day above N commits
// ---------------------------------------------------------------------------

const fieldBurst: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillEllipse(grid, 16, 18, 8, 7, '2') // burst core disc
  // radiating spikes
  fillRect(grid, 15, 4, 2, 6, '3')
  fillRect(grid, 15, 24, 2, 6, '3')
  fillRect(grid, 4, 17, 6, 2, '3')
  fillRect(grid, 24, 17, 6, 2, '3')
  fillRect(grid, 8, 8, 4, 2, '3')
  fillRect(grid, 22, 24, 4, 2, '3')
  fillRect(grid, 22, 8, 4, 2, '3')
  fillRect(grid, 8, 24, 4, 2, '3')
  fillEllipse(grid, 16, 18, 4, 4, '4') // hot centre
  outlineFrom(grid, '1')
  return {
    id: 'field-burst',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#a9793f', // burst disc, brass
      '#d8b25a', // spikes, gold
      '#f0d98a', // hot centre, pale gold
    ],
    frames: [gridToFrame(grid)],
  }
})()

// ---------------------------------------------------------------------------
// Survey Stake - cumulative commits reach a threshold
// ---------------------------------------------------------------------------

const surveyStake: SpriteData = (() => {
  const grid = blankGrid(SIZE, SIZE)
  fillRect(grid, 15, 6, 2, 22, '2') // stake shaft
  setPixel(grid, 15, 27, '2')
  setPixel(grid, 16, 27, '2')
  fillRect(grid, 14, 27, 4, 2, '2') // driven point, wide base
  fillRect(grid, 10, 9, 12, 6, '3') // marker flag
  fillRect(grid, 12, 11, 3, 1, '5') // flag rule marks
  fillRect(grid, 12, 13, 3, 1, '5')
  outlineFrom(grid, '1')
  return {
    id: 'survey-stake',
    width: SIZE,
    height: SIZE,
    palette: [
      'transparent',
      'var(--sprite-outline)', // outline
      '#8a6242', // stake, wood
      '#a9793f', // flag, brass
      '#4a3320', // unused
      '#e8ddb8', // flag rule marks, pale
    ],
    frames: [gridToFrame(grid)],
  }
})()

export const ITEM_SPRITES: Record<string, SpriteData> = {
  'spore-jar': sporeJar,
  'dew-vial': dewVial,
  'hand-lens': handLens,
  trowel,
  'field-ledger': fieldLedger,
  'brass-compass': brassCompass,
  'pressed-frond': pressedFrond,
  'ember-trail': emberTrail,
  'field-burst': fieldBurst,
  'survey-stake': surveyStake,
}
