/**
 * Renders the creature as a static SVG string for `/api/creature.svg`, the
 * README embed. Read `tasks/T7.md` before touching this file.
 *
 * WHY STATIC. GitHub proxies every README image through its camo cache,
 * which strips or ignores CSS animation and does not reliably run SMIL.
 * Shipping an animated SVG here and claiming it works would be a lie, so
 * this module never emits a `<style>` animation or more than one visible
 * frame. Frame 0 only, always.
 *
 * WHY LOCAL SPRITES, NOT POKEAPI. The PokeAPI adapter (`sprites/pokeapi.ts`)
 * returns a remote GIF url. Embedding an `<image href="https://...">` inside
 * this SVG would mean GitHub's camo proxy has to fetch that URL on every
 * view, camo does not reliably do that for images nested inside another
 * proxied image, and it leaks a request per view even when it works. The
 * local `SpriteData` sprites exist for exactly this: they are data, not
 * files, so they can be redrawn as SVG `<rect>` elements with zero external
 * requests. This module never references an external image URL.
 *
 * LIGHT / DARK APPROACH. GitHub serves one image to every reader regardless
 * of their site theme, so there is no way to detect the viewer's theme from
 * inside the SVG itself. Two things follow:
 *   1. A `theme` query param (`light` | `dark`, default `light`) lets a
 *      README author pick explicitly, including via the `<picture>` +
 *      `prefers-color-scheme` trick GitHub supports for README images (two
 *      `<source>` embeds, one per theme, switched by the reader's OS/GitHub
 *      theme).
 *   2. Whichever theme is chosen, this module always paints its own opaque
 *      background panel (never a transparent SVG background) using this
 *      site's actual `--paper-raised` / `--ink` token values for that theme.
 *      That means correctness never depends on guessing the host page's
 *      background: the badge carries its own light or dark card, so it
 *      reads correctly against a white README and a near-black one alike,
 *      as long as the right `theme` value was requested. Default is light
 *      because GitHub's own default rendering is light for logged-out /
 *      unconfigured viewers.
 *
 * SPRITE OUTLINE COLOR. The local sprite palettes (`sprites/creatures.ts`)
 * use the literal string `'var(--sprite-outline)'` for the outline index,
 * resolved by the site's own `globals.css` custom property at DOM render
 * time. This SVG is served standalone, outside that document, so the CSS
 * variable would not resolve. Rather than depend on `var()` support surviving
 * camo (untested and unnecessary risk), `resolveSpriteColor` below substitutes
 * the same concrete values `globals.css` defines per theme
 * (`#242420` light, `#d6d6cc` dark), so the outline is always a real color.
 *
 * XML SAFETY. Every user-controlled string (handle, repo name, error
 * message) goes through `escapeXml` before being interpolated into markup.
 */

import type { SpriteData, Stage } from './types'
import { frameToRuns } from './sprites/pixel-runs'

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type BadgeTheme = 'light' | 'dark'

interface ThemeColors {
  panelBg: string
  panelBorder: string
  ink: string
  inkMuted: string
  accent: string
  accentSoft: string
  spriteOutline: string
  spriteMountBg: string
}

/**
 * Mirrors `globals.css`'s `:root` / `.dark` token values. Duplicated rather
 * than imported: `globals.css` is not a module and is on T7's must-not-touch
 * list regardless, so these are read out by value once and kept in sync by
 * hand, the same "small, justified duplication" pattern `repo-creature.ts`
 * already uses for `computeCurrentStreak`.
 */
const THEME_COLORS: Record<BadgeTheme, ThemeColors> = {
  light: {
    panelBg: '#f8f8f6',
    panelBorder: '#d9d9d4',
    ink: '#141416',
    inkMuted: '#6b6b70',
    accent: '#2f4bd4',
    accentSoft: '#e6e9fb',
    spriteOutline: '#242420',
    // A fixed light mount behind the sprite regardless of theme, so the
    // near-black outline never has a chance to melt into a dark panel.
    spriteMountBg: '#eeeee6',
  },
  dark: {
    panelBg: '#1b1b1f',
    panelBorder: '#2b2b31',
    ink: '#e8e8e4',
    inkMuted: '#96969c',
    accent: '#8298ff',
    accentSoft: '#1c2140',
    spriteOutline: '#d6d6cc',
    spriteMountBg: '#eeeee6',
  },
}

export function resolveTheme(value: string | null): BadgeTheme {
  return value === 'dark' ? 'dark' : 'light'
}

// ---------------------------------------------------------------------------
// Sprite -> static SVG rects
// ---------------------------------------------------------------------------

/** Resolves the sprite's own palette entry to a concrete, theme-correct color. */
function resolveSpriteColor(rawColor: string, theme: BadgeTheme): string {
  if (rawColor === 'var(--sprite-outline)') {
    return THEME_COLORS[theme].spriteOutline
  }
  return rawColor
}

/**
 * Renders a `SpriteData`'s resting frame (frame 0 only, no animation) as a
 * translated/scaled `<g>` of `<rect>` elements, ready to inline into a
 * larger SVG document. Run-length conversion itself lives in
 * `sprites/pixel-runs.ts`, shared with `Sprite.tsx`'s DOM renderer; this
 * function only supplies the two things static-badge rendering needs that
 * the DOM renderer does not: lenient (non-throwing) character decoding,
 * since a README badge must always render something, and theme-aware color
 * resolution, since `var(--sprite-outline)` has no meaning outside the
 * site's own DOM.
 */
function renderSpriteGroup(
  sprite: SpriteData,
  x: number,
  y: number,
  scale: number,
  theme: BadgeTheme
): string {
  const frame = sprite.frames[0]
  if (!frame) return ''
  const runs = frameToRuns(frame, sprite.palette, {
    strict: false,
    resolveColor: (rawColor) => resolveSpriteColor(rawColor, theme),
  })
  const rects = runs
    .map(
      (run) =>
        `<rect x="${(run.x * scale).toFixed(2)}" y="${(run.y * scale).toFixed(2)}" width="${(run.length * scale).toFixed(2)}" height="${scale.toFixed(2)}" fill="${escapeXml(run.color)}" />`
    )
    .join('')
  return `<g transform="translate(${x}, ${y})" shape-rendering="crispEdges">${rects}</g>`
}

// ---------------------------------------------------------------------------
// Badge layout
// ---------------------------------------------------------------------------

export const BADGE_WIDTH = 400
export const BADGE_HEIGHT = 120

const SPRITE_BOX = 96
const SPRITE_BOX_X = 12
const SPRITE_BOX_Y = 12
const SPRITE_SCALE = 3 // 32 * 3 = 96, fills the mount exactly

export interface CreatureBadgeParams {
  sprite: SpriteData
  stage: Stage
  stageCount: number
  totalXp: number
  xpIntoStage: number
  xpForNextStage: number | null
  progress: number
  handle: string
  repo?: string | null
  degraded?: boolean
  theme: BadgeTheme
}

function xmlHeader(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>'
}

function svgOpen(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`
}

function panelRect(colors: ThemeColors, width: number, height: number): string {
  return `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${colors.panelBg}" stroke="${colors.panelBorder}" stroke-width="1" />`
}

/** Truncates to a max character length with a trailing ellipsis, before escaping. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

export function renderCreatureBadgeSvg(params: CreatureBadgeParams): string {
  const colors = THEME_COLORS[params.theme]
  const width = BADGE_WIDTH
  const height = BADGE_HEIGHT

  const name = escapeXml(truncate(params.stage.name, 24))
  const stageLabel = escapeXml(`Stage ${params.stage.index} of ${params.stageCount}`)
  const identity = escapeXml(
    truncate(params.repo ? `${params.handle}/${params.repo}` : params.handle, 34)
  )

  const barX = 124
  const barY = 78
  const barWidth = 264
  const barHeight = 10
  const clampedProgress = Math.max(0, Math.min(1, params.progress))
  const fillWidth = Math.max(2, barWidth * clampedProgress)

  const xpLabel =
    params.xpForNextStage === null
      ? `${params.totalXp} XP (max stage)`
      : `${params.xpIntoStage} / ${params.xpForNextStage} XP`

  const degradedNote = params.degraded
    ? `<text x="${width - 12}" y="16" text-anchor="end" font-family="ui-monospace, 'Geist Mono', monospace" font-size="9" fill="${colors.inkMuted}">degraded</text>`
    : ''

  const spriteGroup = renderSpriteGroup(
    params.sprite,
    SPRITE_BOX_X + (SPRITE_BOX - params.sprite.width * SPRITE_SCALE) / 2,
    SPRITE_BOX_Y + (SPRITE_BOX - params.sprite.height * SPRITE_SCALE) / 2,
    SPRITE_SCALE,
    params.theme
  )

  return [
    xmlHeader(),
    svgOpen(width, height),
    `<title>${escapeXml(`${params.stage.name}, ${stageLabel}, ${params.handle}`)}</title>`,
    panelRect(colors, width, height),
    `<rect x="${SPRITE_BOX_X}" y="${SPRITE_BOX_Y}" width="${SPRITE_BOX}" height="${SPRITE_BOX}" rx="8" fill="${colors.spriteMountBg}" />`,
    spriteGroup,
    degradedNote,
    `<text x="${barX}" y="34" font-family="ui-sans-serif, system-ui, sans-serif" font-size="19" font-weight="600" fill="${colors.ink}">${name}</text>`,
    `<text x="${barX}" y="54" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="${colors.inkMuted}">${stageLabel}</text>`,
    `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="5" fill="${colors.accentSoft}" />`,
    `<rect x="${barX}" y="${barY}" width="${fillWidth.toFixed(2)}" height="${barHeight}" rx="5" fill="${colors.accent}" />`,
    `<text x="${barX}" y="106" font-family="ui-monospace, 'Geist Mono', monospace" font-size="11" fill="${colors.inkMuted}">${escapeXml(xpLabel)}</text>`,
    `<text x="${barX}" y="120" font-family="ui-monospace, 'Geist Mono', monospace" font-size="10" fill="${colors.inkMuted}">@${identity}</text>`,
    '</svg>',
  ]
    .filter(Boolean)
    .join('')
}

// ---------------------------------------------------------------------------
// Compact message badge, for every failure case in the T7 failure table.
// Always a renderable SVG, never JSON, never a 500.
// ---------------------------------------------------------------------------

export function renderMessageSvg(message: string, theme: BadgeTheme = 'light'): string {
  const colors = THEME_COLORS[theme]
  const width = BADGE_WIDTH
  const height = 80
  const safeMessage = escapeXml(truncate(message, 60))

  return [
    xmlHeader(),
    svgOpen(width, height),
    `<title>${safeMessage}</title>`,
    panelRect(colors, width, height),
    `<text x="${width / 2}" y="${height / 2 + 5}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" fill="${colors.ink}">${safeMessage}</text>`,
    '</svg>',
  ].join('')
}
