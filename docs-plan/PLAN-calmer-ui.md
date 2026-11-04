# Plan: a calmer UI (less text, same meaning)

> Status: **All four phases implemented, uncommitted** (2026-11-04). Rules R1–R7 are
> in `docs/DESIGN.md` §7, and per-phase notes are in `docs/ROADMAP.md`.
> Across the 18 working-surface files (all except `/guide`), copy went from 2,437 to
> 1,662 words (-32%). That count includes text now folded into disclosures, so the
> text visible by default dropped much further. `/guide` grew from 566 to 905 words,
> as intended, because it holds what moved. `Chip` was dropped: removing the
> reassurance captions made it unnecessary.
> Created 2026-11-04. Once the open questions in §9 are answered, the copy rules
> in §4 move into `docs/DESIGN.md` and the phases into `docs/PLAN.md` /
> `docs/ROADMAP.md`.

## 1. Why

Users say the UI feels **overwhelming because there is too much text**. The
product itself is not complicated: pick a companion, connect a source, watch it
grow. But almost every section explains itself in a full paragraph, and the same
reassurances are repeated across several surfaces. The meaning is right, but
there is too much of it on screen.

Goal: **cut visible copy on the main surfaces by about 60%** without losing any
information a user actually needs. The detail does not go away. It moves one
click deeper (into a disclosure) or one page deeper (into `/guide`).

| In scope | Out of scope |
|---|---|
| Visible copy on all pages and game/garden components | Visual identity (palette, type, specimen-archive frame) |
| A small set of shared primitives for progressive disclosure | New features or new data |
| Restructuring the GitHub panel into clear states | Changing XP, care, or sync logic |
| A copy budget written into `DESIGN.md` | Adding a component library or icon dependency |

## 2. What we measured

Visible words per file, counted from JSX text and user-facing strings. The
counter is described in §8 and is how progress is tracked.

| Surface | Words | What makes it heavy |
|---|---:|---|
| `/github` → `GitHubSourcePanel.tsx` | **762** | Intro, three reassurance bullets, two explanatory paragraphs above the repo list, long multi-clause sync results, recovery flows written as prose |
| `/guide` | 566 | Expected to be long, but it is one continuous wall with no way to jump around |
| `/companions` (page + `CareHouse` + grid + panel) | **~540** | A 3-link prose intro, a "how granting works" sentence repeated 3 times, a caption under every meter, a footnote saying "condition never removes XP" |
| `ConnectGarden.tsx` (`/write`) | 251 | A 45-word privacy paragraph, plus browser-API and permission explanations shown as prose |
| `/repos` | 168 | Three paragraphs that each explain the difference between repo creatures and owned companions |
| `/leaderboard` | 118 | The anti-farming rationale is shown to every visitor |
| `/species`, `/preview`, `/progression` | 50–90 each | Implementation detail ("PokeAPI idle set", "Generation-V set") in the intros |

For comparison, the home page has 25 words and reads calm. That shows the target
is reachable.

## 3. Root causes (patterns, not one-offs)

1. **The UI argues its case.** Many sentences answer an objection nobody raised
   yet: *"never a global ranking: a public board … would be farmed within a
   week"*, *"the commit count itself is not an unlimited XP faucet"*, *"neglect
   changes how yours is doing, not what it earned"*. This is design rationale.
   It belongs in `/guide` or `docs/`, not on the working surface.
2. **The same reassurance appears in many places.**
   - "One companion is granted when you first arrive, and another every day you
     come back": `companions/page.tsx`, `OwnedCompanionGrid.tsx`,
     `CareHouse.tsx`.
   - "Nothing uploads / stays on your disk / nothing sent to any server":
     `ConnectGarden` (twice), `/write`, `/progression`, `ProgressionView`,
     `NeverSyncedFunnel`.
   - "Earned XP is kept": GitHub disconnect (twice), CareHouse (twice).
3. **Every section opens with a paragraph.** Heading → muted paragraph → content
   is the default rhythm, even when the heading already says it all ("Item
   archive", "Your companions").
4. **Navigation hidden in prose.** The `/companions` intro carries three links
   (species, preview, progression) inside a sentence. `/repos` links back to
   companions the same way. Users have to read to navigate.
5. **Status messages carry internal vocabulary.** Sync results stitch 3–4
   clauses together (*baseline, receipts, checkpoint, scan window, account
   backup*). Example (line 1146):
   `Baseline recorded for 3 repositories · no old history awarded. 2 more will be read by the next sync; repositories without a baseline go first. The scan window ended before … Account backup committed successfully.`
6. **Captions on everything.** Each CareHouse meter has a sentence caption.
   Each room object has a label plus a hint. Each reassurance bullet is a full
   sentence.

## 4. Copy rules (go into `DESIGN.md` as a new "Copy budget" section)

**R1 — Three tiers of information.**

| Tier | Where | What goes there |
|---|---|---|
| T1 · always visible | On the surface | Name, the number, current state, the one primary action |
| T2 · one click | `<InfoDisclosure>` / `<details>` beside the thing | How it works, why, edge cases |
| T3 · one page | `/guide#anchor` | Rules, formulas, rationale, privacy model |

A sentence is T1 only if a user **cannot act correctly** without it.

**R2 — Intros are optional, max one sentence (~15 words).** If the heading plus
content already explain the section, drop the intro.

**R3 — Say it once.** Each reassurance has exactly one home. Every other surface
links to it with a small `(?)` disclosure or a `/guide#…` link. Shared strings
live in one module (`lib/copy.ts`) so they cannot drift.

**R4 — Status = headline + optional details.** A status line is at most ~8
words (`Synced 4 repos · +12 events`). Everything else goes in a "Details"
disclosure.

**R5 — Navigation is UI, not prose.** Related pages appear as a row of links or
tabs (`Species · Preview · Progression`), never inside a sentence.

**R6 — Show, don't caption.** Meters, chips, and numbers carry the meaning. A
caption appears only for an abnormal state (red, empty, blocked) and says what to
do.

**R7 — Text stays where it protects the user.** Destructive confirmations
(disconnect, delete cloud copy, replace local progress), actionable errors, and
`aria-label`s are **exempt** from trimming. Screen-reader text does not add to
visual load, so do not cut it.

**Word budgets per surface (visible, default state):**

| Surface | Now | Target |
|---|---:|---:|
| `/github` steady state | 762 (all states) | ≤ 120 visible at once |
| `/companions` | ~540 | ≤ 180 |
| `/write` connect step | 251 | ≤ 60 |
| `/repos` | 168 | ≤ 50 |
| `/leaderboard` | 118 | ≤ 40 |
| page intros (all) | 15–60 | ≤ 15 each |
| `/guide` | 566 | unchanged length; must be scannable (TOC + anchors) |

## 5. Shared primitives (build once, Phase 2)

No new dependencies. The project has no tooltip/popover library and no icon
library, and this plan does not add one. Hover-only tooltips are also bad on
touch and for assistive tech.

| Primitive | Built on | Use |
|---|---|---|
| `<InfoDisclosure label="How this works">` | native `<details>`/`<summary>` (already used on home for the Observation log) | T2 explanations next to a heading. Shows as a small `(?)` or "How it works" toggle, keyboard-operable, no JS state |
| `<StatusNote tone="ok\|warn\|error" title="…">` | `role="status"` + `<details>` | Short headline; optional details body; one action button |
| `<RelatedLinks links=[…]>` | plain `<nav>` | Replaces prose links in intros (R5) |
| `<Chip>` | span | Turns reassurance bullets into 2–3 word chips (`Private stays private`, `Selected repos only`) with the full sentence in a disclosure |
| `lib/copy.ts` | constants | Single home for repeated reassurances (R3) and `/guide` anchor ids |

All must be server-component safe (no Node built-ins, see the client-bundle
guard) and work without JS where possible.

## 6. Surface-by-surface changes

### 6.1 `/github`: turn one long panel into clear states (largest win)

Today one panel shows the intro, connect explainer, reassurances, repo
explainer, owner rules, repo list, sync results, recovery, cloud chooser, and
disconnect, all stacked. Restructure it as **one state at a time**:

```
State A · not connected      State B · connected, nothing tracked    State C · steady state
┌──────────────────────┐    ┌───────────────────────────────┐      ┌──────────────────────────────┐
│ Let your work wake   │    │ Pick repos to track           │      │ Last synced 2h ago  [Sync]   │
│ the companion.       │    │ [Search…] [All|Mine|Orgs]     │      │ ✓ 4 repos · +12 events  ▸    │
│ [Connect GitHub]     │    │ ☐ repo-a   ☐ repo-b  …        │      │ Tracked repos (4)       ▸    │
│ (?) What we read     │    │ [Track selected]              │      │ ─ alerts appear here only ─  │
└──────────────────────┘    │ (?) Approved vs tracked       │      │ Settings ▸ (auto-sync,       │
                            └───────────────────────────────┘      │   disconnect)                │
                                                                   └──────────────────────────────┘
```

Concrete edits:
- Intro (L1778–1781): keep the headline, drop the second sentence or reduce it
  to `Only repos you pick. Never your code.`
- Connect explainer (L1862) → `(?) What Terrarium reads` disclosure.
- Three reassurance sentences (L1894–1904) → three chips; the full text goes in
  the same disclosure.
- "Approved means … Tracked means …" (L2056) and the first-sync explainer
  (L2045) → one `(?) Approved vs tracked` disclosure. The first-sync rule
  becomes the empty-state line: `First sync sets a baseline, so old history isn't counted.`
- Sync results (L1104–1150) → `StatusNote`: headline
  `Synced 4 repos · +12 events`, with truncation, limits, and backup outcome
  under "Details". Warnings (partial read, backup failed) become the headline
  only when the user has to act.
- Receipt repair and the cloud-copy chooser (L1921–1996) stay **only** when
  active, as `StatusNote tone="warn"` with one primary action. Keep the
  destructive-choice text in full (R7).
- Auto-sync toggle, owner rules (L2068–2073), and disconnect (L2115–2131) move
  under a collapsed **Settings** section. Keep the disconnect consequence text
  in the confirmation only.
- `GitHubRewardGuide`: keep the XP table and drop the paragraph (L57). It moves
  to `/guide#github-xp` and is linked with `(?)`.

### 6.2 `/companions`: meet the creature, not the manual

- Intro: replace the 60-word paragraph with one line plus
  `<RelatedLinks>`: `Species · Preview · Progression`.
- **Remove the duplicate** "granted on arrival / every day you return" from the
  page and CareHouse empty state. Keep it once, in `OwnedCompanionGrid`'s
  empty state, as `A new companion arrives each day you visit.`
- "Spent on exactly one repository" → moves to `/repos` where the dressing
  happens.
- CareHouse:
  - Meters: drop the always-on captions (L185–221). Show a caption only when the
    need is low or the signal is missing, and say what to do (`Feed it: write or commit today`).
    The neutral explanations go into one `(?) How condition works` disclosure
    under the Condition heading.
  - Footnote L513 ("never removes XP…") → into that same disclosure.
  - Dormant banner L494 → `Dormant. One day of work wakes it.`
  - Room objects: keep the label; show the hint only on disabled objects
    (why it's unavailable).
  - "This week" list: keep as is (it is already compact data).
- "Garden signals" grid: keep. The "figures on the home page are the site
  owner's…" paragraph → one line: `Home shows the site owner's garden. Connect a folder to start yours.`
- Account-condition box (missing/unavailable): headline + one short line +
  link.

### 6.3 `/write` · `ConnectGarden`

- Privacy paragraph (L252) + L422–423 → one line: `Reads a local folder in this tab. Nothing uploads.` plus `(?) How it works`.
- Unsupported browser (L405) → `Needs Chrome, Edge, Brave, or Opera.` and put
  the API name in the disclosure.
- Revoked permission (L442) → `Folder access expired. [Reconnect]`.

### 6.4 `/repos`

Three paragraphs explain the same distinction. Replace them with one page
line, `Creatures generated from your repos and tags. Your own companions are in Companions.`,
and give each section a heading only (`Dress a repo`, `Repo creatures`,
`Tag clusters`), with at most one short line each.

### 6.5 `/leaderboard`, `/species`, `/preview`, `/progression`, `/notes`, `/graph`

- `/leaderboard`: `People you follow who've synced a garden.` Move the
  anti-farming rationale to `/guide#leaderboard`.
- `/species`, `/preview`: drop the PokeAPI/Generation-V implementation detail
  from the intro. Keep it in a page-footer credit line.
- `/progression`: one-line intro. The privacy line becomes the shared
  `(?)` from `lib/copy.ts`.
- `/notes`, `/graph`: already close to budget. Trim intros to ≤ 15 words.

### 6.6 Empty states and profiles

Empty state = **what's missing + one action**, ≤ 15 words. Applies to
`CollectionGrid`, `ActivityLogList`, `NoteList`, `CompanionPicker`,
`NeverSyncedFunnel`, `PrivateProfileNotice`, `UnverifiedXpNote` (the last one
→ a `(?)` beside the XP figure).

### 6.7 `/guide`: the one place long text belongs

It absorbs everything moved out of the surfaces, so it must become easier to
scan, not shorter:
- Sticky/inline table of contents with anchors (`#xp`, `#stages`, `#condition`,
  `#github-xp`, `#privacy`, `#leaderboard`).
- Rules as tables and short lists where they are currently prose.
- Every `(?)` disclosure on other surfaces ends with `More in the guide →`
  linking to the matching anchor.

## 7. Phases

| Phase | Scope | Risk | Done when |
|---|---|---|---|
| **1 · Copy-only trims** | Intros (R2), dedupe (R3), empty states (6.6), `/repos`, `/leaderboard`, `/species`, `/preview`, `/progression`. No structural changes | Low | Each listed surface is within budget; tests updated |
| **2 · Primitives** | `InfoDisclosure`, `StatusNote`, `RelatedLinks`, `Chip`, `lib/copy.ts`; apply to `/companions` + CareHouse + ConnectGarden | Low–med | `/companions` ≤ 180 words, `/write` ≤ 60; disclosures keyboard + screen-reader checked |
| **3 · GitHub states** | 6.1 restructure: state A/B/C, Settings fold, sync `StatusNote` | **Medium**: the panel is 2.3k lines with recovery flows | Each state ≤ 120 visible words; every recovery/destructive path still reachable and fully worded; existing sync tests green |
| **4 · Guide** | TOC, anchors, absorb moved copy, tables | Low | Every `(?)` links to a live anchor (test) |

Ship each phase as its own PR (one coherent change each, per `AGENTS.md`), with
the `docs/DESIGN.md` copy-budget section landing in Phase 1.

## 8. Measuring and guarding it

- **Copy audit script.** The word counter used for §2 (TypeScript AST walk over
  `.tsx`, counting JSX text and user-facing strings, skipping class names and
  attributes) gets committed as `scripts/copy-audit.mjs` with
  `npm run audit:copy`. It prints words per file and flags any sentence longer
  than ~25 words.
- **Before/after table** in each PR body (the "AS IS → TO BE" section) uses
  that output.
- **Optional guard test.** A Vitest check that fails if a surface goes over its
  budget by more than ~20%, so the text does not creep back. Decide in §9.
- **Tests that assert copy:** 35 test files reference rendered text. Each phase
  updates the affected assertions. Prefer `getByRole`/`aria-label` queries over
  exact sentences, so future copy edits don't break tests.
- **A quick check with real users** after Phase 2: show `/companions` and
  `/github` to 2–3 of the people who gave the feedback.

## 9. Open questions (yours to decide)

1. **Tone.** Keep the naturalist/archive voice in the shorter lines
   (`Sitting quietly, watching the room.`), or go plainer? *Recommendation:
   keep it in creature dialogue only; plain everywhere else.*
2. **Guard test.** Enforce word budgets in CI (§8), or treat them as guidance?
   *Recommendation: guidance in Phase 1, enforce after Phase 3.*
3. **GitHub Settings fold.** Is it OK for auto-sync and disconnect to sit behind
   a collapsed "Settings" section? *Recommendation: yes; both are rare
   actions.*
4. **Which surface did the users mean?** The feedback was general. If you know
   which page they were on, that surface should go first, even if it is not the
   GitHub panel.

## 10. Docs to update when this lands

- `docs/DESIGN.md`: new "Copy budget" section (§4 rules R1–R7 + budgets); note
  `InfoDisclosure` / `StatusNote` as the standard patterns.
- `docs/DECISIONS.md`: "Rationale and privacy explanations live in `/guide`;
  surfaces show state + one action."
- `docs/ROADMAP.md`: phases 1–4 as items; mark shipped as they land.
- `docs/PRODUCT.md`: no rule changes. Only update it if a quoted UI string
  there changes.
