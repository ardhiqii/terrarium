# ardhiqi.garden - Design & System Spec

The single source of truth for how this site looks and how the creature system works.
Read this before changing visual tokens, adding a section, or touching XP math.

Design read: **personal digital garden for developers and curious readers, with a naturalist specimen-archive language, leaning toward Tailwind v4 + Geist/EB Garamond + restrained motion, with a pixel-art creature layer quarantined into dedicated surfaces.**

Dials: `DESIGN_VARIANCE: 6` · `MOTION_INTENSITY: 5` · `VISUAL_DENSITY: 4`

Editorial baseline (6/4/3), with motion nudged to 5 because the creature must read as alive, and density nudged to 4 because stat readouts need to be scannable.

---

## 1. The core idea

The creature is not a Pokemon visiting a blog. **The creature is the garden's growth made visible.**

Digital gardens already use a maturity convention: seedling, budding, evergreen. That is already an evolution chain. So the creature is not decoration bolted onto writing, it is a readout of something real: how much you have written, how densely you have connected it, how consistently you show up.

This reframe is what keeps the site from being "a blog with a distracting sprite in the corner."

### The specimen-archive frame

Notes are **observations**. Projects are **field studies**. The creature is a **documented species** with a specimen plate, a stage, and an observation count. The companions page is the archive. This frame lets a pixel sprite sit inside a serious reading site without tonal whiplash, because an archive is exactly the kind of place a specimen plate belongs.

### Surface separation (the rule that protects readability)

| Surface | Register |
|---|---|
| Note and project pages | Pure reading. Serif body, generous measure, no game chrome beyond a single quiet footer strip. |
| Home, `/companions` | Archive register. Specimen plates, stats, sprites, mono data. |
| GitHub embed | Game register. It is a badge, it can be louder. |

Game UI never intrudes on a reading surface. This is not negotiable; it is the thing that makes the concept work.

---

## 2. Visual system

### 2.1 Palette

One accent, locked across the whole page. Colour lives in the sprite art, not in the chrome.

```css
:root {
  --paper:      #f1f1ee;  /* neutral archival stock, deliberately NOT cream/beige */
  --paper-raised: #f8f8f6;
  --ink:        #141416;  /* neutral off-black, never #000 */
  --ink-muted:  #6b6b70;
  --rule:       #d9d9d4;  /* hairlines, specimen frames */
  --accent:     #2f4bd4;  /* archival ink blue - the single accent */
  --accent-soft:#e6e9fb;
}

.dark {
  --paper:      #131316;
  --paper-raised: #1b1b1f;
  --ink:        #e8e8e4;
  --ink-muted:  #96969c;
  --rule:       #2b2b31;
  --accent:     #8298ff;
  --accent-soft:#1c2140;
}
```

**Why blue, on a garden site.** Every digital garden reaches for green, and the current palette (`#fafaf9` paper, `#b55e3a` clay, `#92650a` ochre, `#1c1917` espresso) is the exact beige-and-brass family that reads as AI default. Ink blue is the colour of annotation and archival stamps, it is instantly distinguishing, and it leaves green free to mean something specific: green appears only in sprite art and living things, never in UI chrome.

**Maturity is not colour-coded.** Seedling, budding, and evergreen render as a neutral weight ramp (`--ink-muted` to `--ink`) plus a glyph, not three different hues. This keeps the accent lock intact and looks more like an archive than a status dashboard.

### 2.2 Type

Three roles, three families, no mixing within a single headline.

| Role | Family | Notes |
|---|---|---|
| Display / UI | **Geist** | `next/font/google`. Tight tracking on headlines, `tracking-tighter leading-[1.05]`. |
| Body / reading | **EB Garamond** | Justified by the brief: this is a publication and manuscript surface, and long-form reading is the primary job. Explicitly not Fraunces or Instrument Serif. |
| Data / labels / stats | **Geist Mono** | XP numbers, stage counters, specimen IDs, observation counts. |

Body measure caps at `65ch`. Never load fonts via a CSS `@import` of Google Fonts; `next/font/google` only, per Next 16.

### 2.3 Shape and materials

- **One radius system:** everything is `radius 0` except the specimen frame, which uses a 1px `--rule` border and no radius either. Sharp is the archive language. Interactive pills are the sole exception at full radius, and only in the creature HUD.
- **No cards by default.** Group with `border-t`, `divide-y`, and negative space. A card appears only for the specimen plate, where elevation communicates "this is a mounted object."
- **Shadows** tinted to background hue, never pure black.

### 2.4 Pixel art rendering

Sprites must land on exact integer scale factors or they turn to mush.

```css
.sprite {
  image-rendering: pixelated;
  /* only 1x, 2x, 3x, 4x - never 1.5x, never percentage widths */
}
```

Base sprite grid: **32x32**, displayed at 3x (96px) in the specimen plate and 2x (64px) in the footer strip.

---

## 3. Creature system

### 3.1 Original species, not Pokemon

PokeAPI serves its data freely, but Pokemon names, designs, and sprite sets are Nintendo, Game Freak, and Creatures IP. That is tolerable in a local prototype and genuinely risky on a public site under your own name, and riskier still embedded in a GitHub profile README where it functions as distribution.

**Decision:** use PokeAPI as a *mechanics reference only* (EXP curve shapes, stage thresholds, type-affinity ideas). Ship original creatures on the garden theme. Nothing from PokeAPI is vendored into this repo.

### 3.2 The evolution line

| Stage | Name | XP threshold | What it means |
|---|---|---|---|
| 1 | **Sporeling** | 0 | The garden exists. A few scattered notes. |
| 2 | **Mossling** | 1,500 | Notes are accumulating and starting to link. |
| 3 | **Bracken** | 5,000 | A real body of work with dense interconnection. |
| 4 | **Heartwood** | 12,000 | An established garden. |

`src/lib/game/types.ts` is the source of truth for these numbers. The table above is a
convenience copy, so if the two ever disagree, the code wins.

Thresholds are deliberately reachable. A garden that never evolves is a garden that stops being
fun to tend. They were raised from an initial 500 / 2,000 / 6,000 after the first real
measurement: the existing 9 notes computed to 2,060 XP, which landed the garden at stage 3 of 4
on day one. Starting near the top kills the progression just as surely as never evolving.

### 3.3 XP formula

All computed at build time from data that already exists. No database.

**From the garden** (extends `src/lib/content.ts`):

| Event | XP |
|---|---|
| Note published | 100 |
| Per 100 words of body copy | 10 |
| Outgoing wikilink that resolves to a real note | 15 |
| Backlink received | 10 |
| New tag introduced | 25 |
| Note promoted seedling to budding | 50 |
| Note promoted budding to evergreen | 150 |

The link rewards are the important ones. They make XP measure *connection*, not volume, which is the whole point of a garden over a blog. Word count is capped in effect by the small per-100 rate so that padding a note is a poor strategy.

**From GitHub** (fetched at build, cached to JSON):

| Event | XP |
|---|---|
| Commit to any public repo | 5, capped at 100 per day |
| Commit to this garden repo | 10, same daily cap |

The daily cap exists so that a scripted commit loop cannot farm the creature.

### 3.4 Items

Items are unlocked states, not inventory to manage. They render as a specimen drawer of small pixel objects.

| Item | Unlock |
|---|---|
| Spore Jar | Publish 5 notes |
| Dew Vial | 7 consecutive days with a commit or a note edit |
| Hand Lens | A single note reaches 5 backlinks |
| Trowel | Publish your first project |
| Field Ledger | Reach 25 notes |
| Brass Compass | Use 10 distinct tags |
| Pressed Frond | A note reaches evergreen |

### 3.5 Variant traits (phase 3, optional)

The sprite's appearance shifts based on the *shape* of the garden, not just its size. Highly interconnected graph produces a webbed variant. One dominant tag produces a specialised variant. This makes the creature specific to how you actually write, which is the detail that would make someone else want one.

---

## 4. GitHub embed

A route that renders the creature as an image, since README markdown strips scripts.

**Honest constraint:** GitHub proxies all README images through its camo cache. Static SVG is reliable. CSS animation inside an SVG is stripped or ignored, and SMIL is inconsistent through camo. Camo also caches aggressively, so a freshly updated creature can lag behind by hours.

Therefore:
- **Default:** static SVG at `/api/creature.svg`, reliable everywhere.
- **If animation is wanted:** generate an animated GIF instead. GIF animates through camo where SVG does not.
- Cache-bust with a query param on each deploy to fight camo staleness.

---

## 5. Build phases

1. **Foundation.** Replace the palette and type per section 2. Move fonts to `next/font`. Remove the Google Fonts `@import`. Retheme existing pages. No creature yet.
2. **XP engine.** `src/lib/xp.ts` computing garden XP from existing content, backlink, and graph libs. Surface the specimen plate on the home page.
3. **Companions and items.** `/companions` route, item drawer, unlock logic.
4. **GitHub layer.** Build-time commit fetch, cached JSON, combined XP.
5. **Embed.** `/api/creature.svg`, then GIF if animation is wanted.
6. **Variants.** Trait system driven by graph shape.

Sprite art is the one thing that cannot be generated from code. Four stages plus seven items plus variants is roughly 15 to 30 sprites at 32x32. That is the critical path for phases 2 and 3.

---

## 6. Standing rules

Enforced by `.agents/skills/design-taste-frontend`. The ones this project violates most easily:

- **Zero em-dashes** anywhere visible. Use a period, a comma, or a hyphen.
- **One accent colour** across every section. No teal badge in the footer.
- **Eyebrow budget:** at most one small uppercase label per three sections.
- **No decorative status dots**, no scroll cues, no locale or time strips, no version stamps.
- **No div-based fake screenshots.** Real images or none.
- **Both themes tested** before anything ships.
- **`min-h-[100dvh]`**, never `h-screen`.
