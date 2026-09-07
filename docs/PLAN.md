# Implementation plan

This plan implements [`PRODUCT.md`](PRODUCT.md). `DESIGN.md` governs the visual
language, and [`ROADMAP.md`](ROADMAP.md) records the current status. The old
T0-T30 task files describe the first site prototype; they are historical
references, not the plan for the product model below.

## Non-negotiable architecture

- The web app starts in guest mode. Authentication is optional.
- Local note content stays local by default.
- GitHub is the server-verifiable source for public and user-approved private
  development activity.
- The XP engine consumes normalized events, not raw note text or ad hoc snapshots.
- Every event has a stable ID and is safe to replay.
- XP belongs to the active companion. Collection membership and XP are separate.
- Encounter results are persisted before display and cannot reroll on refresh.
- Provider metadata is separate from game rules. PokeAPI is replaceable.
- Public surfaces expose evidence and verification status, not an opaque quality score.

## Phase 0. Documentation and contracts

**Status: complete.**

Create the shared contracts before rewriting the old snapshot model.

Target files:

- `PRODUCT.md`
- `DESIGN.md`
- `ROADMAP.md`
- `apps/web/src/lib/game/types.ts`
- `apps/web/src/lib/game/events.ts`
- `apps/web/src/lib/game/companions.ts`
- `apps/web/src/lib/game/providers.ts`

Done when the types can represent guest state, source baselines, normalized
events, per-companion XP, encounters, duplicates, provider forms, and verified
versus local evidence without storing note contents.

## Phase 1. Guest shell and local state

**Depends on:** Phase 0.

Build the first-run flow:

1. Create a local guest profile on first visit.
2. Show a starter companion immediately.
3. Offer “Let my work decide,” “Surprise me,” and “Connect later.”
4. Store the local profile and event ledger in browser storage.
5. Offer a privacy-safe local state export/import path for backups.
6. Warn that guest state can be lost on a new device or cleared browser data.

The app must remain useful with no source connected and no network.

**Status: partial — guest onboarding and local persistence are shipped; account
recovery, portable state export/import, and compact cross-session source
snapshots remain.**

## Phase 2. Event ledger and basic XP

**Depends on:** Phase 1.

Replace the old aggregate snapshot calculation with normalized events.

Implement:

- source-specific baseline snapshots;
- note diff measurements using path, modification metadata, and content hash;
- GitHub commit, PR, release, issue, and CI event normalization;
- stable event IDs and deduplication;
- per-source daily caps;
- cross-source diminishing returns or a global soft XP limit;
- active-companion XP attribution;
- an explainable XP ledger with local or verified provenance.

The initial Markdown XP contract stays intentionally small: writing sessions,
new notes or projects, coarse net-new body-word buckets, and newly resolved
wikilinks. Tags, backlinks, maturity labels, reading, and unchanged saves are
signals or no-ops rather than separate XP events until playtesting shows a
clear reason to add them.

Initial rates are defined in `PRODUCT.md`. Do not add AI quality scoring. Test
empty commits, unchanged saves, repeated scans, duplicate deliveries, tiny
commit bursts, and generated-only changes.

Done when the same source scan can run repeatedly with no extra XP and every XP
point can be traced to one ledger event.

**Status: partial — rules engine, deterministic encounters, duplicate Essence, and PokeAPI bridge are shipped; legacy surfaces still need migration.**

## Phase 3. Companion catalog and encounters

**Depends on:** Phase 2.

Implement a provider-neutral catalog:

- companion family and identity;
- encounter tags and rarity tier;
- provider-neutral progression slots and a shared XP curve;
- form metadata;
- animated and static asset URLs;
- asset fallback behavior;
- provider attribution and license state.

Keep the catalog versioned. Store the family definition, forms, progression
slot-to-form mapping, provider references, skin compatibility, and fallback
metadata in the catalog; store only family ID, catalog version, XP, Essence,
and selected skin in user state. Derive the current progression slot from XP.

Support two catalog inputs: a curated PokeAPI importer that maps a selected
evolution path into Terrarium slots, and future artist manifests that define a
creative line against the same slots. A skin may replace compatible appearance
assets without changing progression. A different progression line is a new
family.

Implement encounter logic:

- hidden encounter progress meter;
- threshold calculation;
- deterministic random draw from a persisted seed;
- work-pattern weighting using rules, not AI;
- duplicate-to-family-Essence conversion;
- collection union and active-companion switching.

Evolution progression is driven by companion XP through the provider's valid
steps. Duplicate Essence is a separate optional mastery/cosmetic track and must
not be required to evolve a companion.

The PokeAPI adapter may populate the prototype catalog, but the game engine must
not depend on PokeAPI names, numeric IDs, or URL conventions.

**Status: partial — recursive FSA mounting and baseline-aware in-session scans are shipped; persistent compact scan summaries remain.**

## Phase 4. Sources: editor and mounted Markdown

**Depends on:** Phase 2.

Finish the local source layer:

- built-in Markdown editor for users without an existing tool;
- recursive `.md` and `.mdx` scanning;
- Obsidian vault support without an Obsidian plugin;
- ignore `.obsidian` and hidden system folders;
- vault-local graph resolution for core Wikilinks, Markdown file links, and
  aliases;
- permission-revocation recovery;
- baseline-aware net word, note, and resolved-link events;
- safe rename and delete behavior;
- conservative identity matching that avoids duplicate new-note rewards;
- no note-content upload.

The website scans while open or on demand. Monitoring a closed browser is out of
scope for this phase.

**Status: partial — verified event normalization and derived-only merge contracts are shipped; product sync API wiring and OAuth integration remain.**

## Phase 5. GitHub identity and sync

**Depends on:** Phases 1 and 2.

Add optional GitHub sign-in and derived-state sync:

- GitHub OAuth identifies the user and protects recovery;
- selected public and private GitHub events are server-verified;
- repository access comes from an explicit picker, with opt-in automatic
  inclusion for future personal repositories or selected organizations;
- newly discovered repositories begin at a fresh baseline and never award
  retroactive XP;
- local note events remain labelled local/unverified;
- sync payloads reject note contents and detailed local-note telemetry at the
  schema boundary;
- manual local-note sync uploads only a private condition snapshot and sync
  checkpoint;
- first sign-in imports the current companion condition when no server state
  exists;
- GitHub state merges by event ID, while local-note condition reconciles by
  checkpoint without double-counting;
- irreversible progression merges automatically, while mutable preference
  conflicts offer a local-versus-cloud choice;
- companion XP remains per companion after merge;
- separate disconnect, source removal, local reset, and cloud deletion controls
  with an export-before-delete safeguard;
- early first evolution, slower later evolution, and more frequent encounters;
- shared XP evolution curve across companion families;
- server state becomes authoritative after a completed merge.

Do not make sign-in a prerequisite for using the editor, mounting notes, or
earning local XP.

**Status: partial — `/write` onboarding/activity and extension payload compatibility are shipped; public collection/profile migration remains.**

## Phase 6. Surfaces and distribution

**Depends on:** Phases 3 and 5.

Update the website, extension, profile, and badge to the new state model:

- active companion and collection pages;
- encounter reveal and duplicate feedback;
- evidence ledger and verification labels;
- public profile with derived state only;
- opt-in aggregate local-note contribution signal, with no note content or
  structure exposed;
- opt-in public companion profile and per-surface visibility controls;
- owner-controlled public presentation fields and a compact extension hover
  preview;
- extension showing public synced state only for opted-in profiles;
- extension reactions that are visual-only and cannot award XP;
- dialogue-first mood reactions with optional artist-provided animation;
- predefined dialogue with quiet, balanced, and chatty frequency controls;
- resting and returning reactions with no XP decay or inactivity penalty;
- static README badge;
- mobile read-only fallback.

The extension must never read a local vault. The README badge must not imply that
private or local note activity was independently verified.

## Phase 7. Marketplace and original art

**Depends on:** Phases 3 and 6.

Define the artist provider contract and automated marketplace workflow:

- original asset upload;
- explicit license and attribution;
- progression and form metadata;
- tags and rarity;
- preview and accessibility text;
- automated validation and safety-scan state;
- community reports and takedown state;
- provider versioning and asset fallback.

Do not commercialize Pokémon names, designs, or sprites. Replace the prototype
provider before marketplace launch or other commercial distribution.

## Verification commands

Run these before merging any implementation phase:

```bash
npm run typecheck
npm test
npm run build
```

For source and sync work, also test with an empty garden, a large vault, many
repositories, repeated scans, a new device, offline mode, permission loss, and
a guest-to-account merge.
