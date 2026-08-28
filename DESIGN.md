# ardhiqi.garden - Design & System Spec

The visual source of truth for this site and its companion surfaces. Read
[`PRODUCT.md`](PRODUCT.md) for business rules, [`PLAN.md`](PLAN.md) for the
implementation sequence, and this file before changing visual tokens or adding
a section.

Design read: **personal digital garden for developers and curious readers, with a naturalist specimen-archive language, leaning toward Tailwind v4 + Geist/EB Garamond + restrained motion, with a pixel-art creature layer quarantined into dedicated surfaces.**

Dials: `DESIGN_VARIANCE: 6` · `MOTION_INTENSITY: 5` · `VISUAL_DENSITY: 4`

Editorial baseline (6/4/3), with motion nudged to 5 because the creature must read as alive, and density nudged to 4 because stat readouts need to be scannable.

---

## 1. The core idea

The companion is a local-first feedback layer for real work. It is not a mascot
visiting a blog and it is not a productivity score. Notes, links, commits, pull
requests, releases, and other evidence feed one chosen companion. The companion
turns that history into a visible collection, progression, and record.

The user chooses a companion, not an abstract focus. The active companion receives
new XP; every companion keeps its own history when the user switches.

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

## 3. Companion system

The complete product rules live in [`PRODUCT.md`](PRODUCT.md). The visual system
only needs to preserve the following principles:

### 3.1 One active companion

The collection can contain many companions. One is active at a time, and all new
activity XP goes to it. Switching is always allowed and never deletes or moves
another companion's XP. The interface should make the active choice obvious
without turning the collection into a dashboard.

### 3.2 Encounters

Encounters are earned from a separate, quiet progress meter. Activity fills it;
reaching a threshold produces one persisted random result. The result is weighted
by simple work evidence such as languages, file types, note tags, links, and
activity shape. It is not selected by an AI judge.

Duplicates are valid collection results. They become family-specific Essence,
which gives duplicates a useful destination without requiring a user to complete
the entire collection. There are no paid rolls in the prototype.

### 3.3 XP

XP is event-based and explainable. The initial playtest rates are:

> These are the target rates for the new event-ledger model. The checked-in
> runtime still contains the legacy aggregate snapshot engine until the
> migration in `PLAN.md` is complete.

| Event | XP |
|---|---:|
| Qualifying active day | 10 |
| Work session, maximum two per source/day | 10 |
| New note | 25 |
| 100 net new words | 5 |
| New resolved wikilink | 3 |
| Merged pull request | 25 |
| Published release | 40 |
| Closed linked issue | 10 |
| Successful CI on merged pull request | 10 |

Stable event IDs, baselines, daily caps, and source verification prevent refreshes
and scripted volume from farming XP. Empty commits and unchanged saves score zero.
AI-assisted work is neither detected nor penalized; outcomes and public evidence
are what matter.

### 3.4 Evolution and forms

Application XP milestones are not automatically Pokémon evolution steps. A
provider configuration must declare the family, valid evolution path, forms,
asset URLs, and fallback behavior. A family with three real stages has three
evolution steps. A final mastery form may be used only when it is explicitly a
form or cosmetic state, not mislabeled as a canonical evolution.

The current PokeAPI adapter reads authoritative Pokémon and species metadata,
including form names, static or animated sprite URLs, and evolution-chain IDs.
PokeAPI is prototype-only; commercial marketplace art must be licensed original
work. Nothing from PokeAPI is vendored into this repository.

### 3.5 Items and variants

Items remain quiet milestone rewards and are not a second economy. Variants may
later describe the shape of a companion's history, but they must be derived from
transparent rules and never replace the evidence ledger.

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

The implementation sequence is maintained in [`PLAN.md`](PLAN.md) and the
status in [`ROADMAP.md`](ROADMAP.md). The important order is:

1. Guest shell and local profile.
2. Event ledger and basic XP.
3. Provider-backed companion catalog, forms, and real evolution paths.
4. Built-in editor and recursive Markdown mounting.
5. GitHub verification, sign-in, and derived-state sync.
6. Collection, encounters, public profiles, and extension integration.
7. Licensed marketplace providers and original art.

The game layer must remain provider-agnostic so PokeAPI can be removed without
rewriting XP, encounters, collection, or sync.

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
