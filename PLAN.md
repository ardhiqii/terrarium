# Implementation plan

Companion to `DESIGN.md`. That file says what to build and why. This one says who builds what, in what order, and how we know it is done.

**Every agent must read, in this order:** `AGENTS.md`, `DESIGN.md`, `src/lib/game/types.ts`, then the section below for its own track.

---

## Why the work splits this way

Three tracks touch disjoint sets of files, so they run in parallel with no merge conflicts:

| Track | Owns | Never touches |
|---|---|---|
| **A. Foundation** | `globals.css`, `layout.tsx`, existing components and pages | anything under `src/lib/game` or `src/components/game` |
| **B. XP engine** | `src/lib/game/*.ts` except `sprites/` | any `.tsx` file, `globals.css` |
| **C. Sprites** | `src/lib/game/sprites/`, `src/components/game/Sprite.tsx` | any existing file |

`src/lib/game/types.ts` is the seam. It is already written and **frozen**. No track may edit it. If a track believes the contract is wrong, it stops and reports rather than editing.

Tracks D and E depend on A, B, and C landing first, so they are sequential.

---

## Track A. Design foundation

Retheme the existing site to the specimen-archive system. No creature work.

**Files owned:** `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/{notes,projects,tags,search,graph}/**`, `src/components/**` except `src/components/game/`.

1. Replace the palette in `globals.css:5-45` with the tokens in DESIGN.md section 2.1. Keep the existing CSS-variable strategy and the `.dark` class hook, since `next-themes` already drives it.
2. Delete the Google Fonts `@import` on `globals.css:1`. Load Geist, Geist Mono, and EB Garamond through `next/font/google` in `layout.tsx`, exposed as CSS variables. The bundled Next 16 docs at `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` are the reference.
3. Apply the type roles from DESIGN.md section 2.2: Geist for UI and headings, EB Garamond for prose, Geist Mono for data and labels. Body measure caps at `65ch`.
4. Retheme every existing component and page against the new tokens. Remove hardcoded colours; everything goes through a variable.
5. Maturity renders as a neutral weight ramp plus a glyph, never as three hues.

**Done when:** `npm run build` passes, both light and dark render correctly on every route, no hardcoded hex outside `globals.css`, no `@import` of a font, and the pre-flight checklist in section 14 of the taste skill passes.

---

## Track B. XP engine

Pure computation. No React, no JSX, no styling.

**Files owned:** `src/lib/game/stats.ts`, `xp.ts`, `stages.ts`, `items.ts`, `state.ts`, plus tests.

1. **`stats.ts`** exports `getGardenStats(): GardenStats`. Builds on `getAllContent()`, `buildBacklinksMap()`, and `buildGraphData()`. Word counts come from body copy with frontmatter excluded.
2. **Maturity.** `FrontMatter` in `src/lib/types.ts` already carries an optional `maturity` field. Treat an absent value as `'seedling'` so all nine existing content files keep working untouched. Do not edit `src/lib/types.ts`.
3. **`xp.ts`** exports `computeGardenXp(stats): XpEntry[]` and `computeCommitXp(github): XpEntry[]`. Use `XP_RATES` and `COMMIT_XP_DAILY_CAP` from the contract; never inline a number. The commit cap applies **per day** before summing, not to the total.
4. **`stages.ts`** exports `resolveStage(totalXp): { stage, nextStage, xpIntoStage, xpForNextStage, progress }`. At max stage, `nextStage` is null, `xpForNextStage` is null, `progress` is exactly 1.
5. **`items.ts`** exports `ITEMS: ItemDef[]` implementing all seven items from DESIGN.md section 3.4, each with a working `unlocked` and `progress`. Items depending on GitHub data must return false and 0 when `ctx.github` is null rather than throwing.
6. **`state.ts`** exports `getCreatureState(github?: GithubStats | null): CreatureState`, assembling everything.

**Edge cases that must not throw:** empty garden (zero notes), a note with zero words, a wikilink to a nonexistent note, `github` being null.

**Done when:** `npx tsc --noEmit` passes, `getCreatureState()` returns sane values against the real nine content files, and every edge case above returns rather than throws.

---

## Track C. Sprite system

**Files owned:** `src/lib/game/sprites/**`, `src/components/game/Sprite.tsx`.

Pixel art is stored as data per the `SpriteData` contract, not as image files. This keeps it diffable, themeable across light and dark, and renderable to both DOM and SVG from one source, which the GitHub embed in Track E needs.

1. **`sprites/index.ts`** exports `getSprite(id: string): SpriteData | null` and `SPRITES: Record<string, SpriteData>`.
2. **Four creature sprites** at 32x32: `sporeling`, `mossling`, `bracken`, `heartwood`. Each needs 2 frames for a subtle idle. The line must read as a clear progression: small and simple, to leafy, to fern-like and complex, to a substantial woody form. Palette stays botanical; greens and browns live here and nowhere else in the product.
3. **Seven item sprites** at 32x32, single frame: `spore-jar`, `dew-vial`, `hand-lens`, `trowel`, `field-ledger`, `brass-compass`, `pressed-frond`.
4. **`Sprite.tsx`** is a server component by default. Renders via a CSS-grid or box-shadow technique, or inline SVG `<rect>` elements. Accepts `SpriteScale` only, never a percentage. Applies `image-rendering: pixelated` where a raster path is used. Idle animation is CSS-only, gated behind `@media (prefers-reduced-motion: no-preference)`.

**Validate every sprite:** each frame has exactly `height` strings, each exactly `width` characters, and every character indexes a real palette entry. Write a small script or test that asserts this across the registry; a malformed sprite must fail loudly at build, not render as garbage.

**Done when:** all 11 sprites validate, `Sprite.tsx` renders at scales 1 through 4 without blur, and idle animation collapses to static under reduced motion.

---

## Track D. Surfaces (after A, B, C)

`src/components/game/{SpecimenPlate,XpBar,ItemDrawer,XpLedger}.tsx`, the home page plate, and `/bestiary`.

Enforces DESIGN.md section 1: game UI never appears on a reading surface. Note and project pages get at most one quiet footer strip.

## Track E. GitHub layer and embed (after D)

`src/lib/game/github.ts` with build-time fetch and JSON cache, then `/api/creature.svg` rendering `CreatureState` plus a sprite to static SVG. Animation, if wanted, ships as a GIF instead, per DESIGN.md section 4.

## Track F. Variant traits (optional, last)

Sprite variants driven by graph shape rather than size.

---

## Standing rules for every track

- **Next 16 is not the Next.js you may remember.** Read the relevant guide in `node_modules/next/dist/docs/` before writing code that touches a framework API.
- `src/lib/game/types.ts` is frozen.
- Zero em-dashes in any user-visible string.
- One accent colour, one radius system, both themes tested.
- `min-h-[100dvh]`, never `h-screen`.
- No hand-rolled decorative SVG. Sprites are the product, not decoration, so they are the explicit exception.
- Run `npx tsc --noEmit` before reporting done.
