# Implementation plan

This plan implements [`PRODUCT.md`](PRODUCT.md). `DESIGN.md` governs the visual
language, and [`ROADMAP.md`](ROADMAP.md) records the current status. The old
T0-T30 task files describe the first personal-site prototype; they are historical
references, not the plan for the product model below.

## Non-negotiable architecture

- The web app starts in guest mode. Authentication is optional.
- Local note content stays local by default.
- GitHub is the server-verifiable source for public development activity.
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
- `src/lib/game/types.ts`
- `src/lib/game/events.ts`
- `src/lib/game/companions.ts`
- `src/lib/game/providers.ts`

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
5. Warn that guest state can be lost on a new device or cleared browser data.

The app must remain useful with no source connected and no network.

**Status: partial — guest onboarding and local persistence are shipped; account recovery and compact cross-session source snapshots remain.**

## Phase 2. Event ledger and basic XP

**Depends on:** Phase 1.

Replace the old aggregate snapshot calculation with normalized events.

Implement:

- source-specific baseline snapshots;
- note diff measurements using path, modification metadata, and content hash;
- GitHub commit, PR, release, issue, and CI event normalization;
- stable event IDs and deduplication;
- per-source daily caps;
- active-companion XP attribution;
- an explainable XP ledger with local or verified provenance.

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
- progression steps;
- form metadata;
- animated and static asset URLs;
- asset fallback behavior;
- provider attribution and license state.

Implement encounter logic:

- hidden encounter progress meter;
- threshold calculation;
- deterministic random draw from a persisted seed;
- work-pattern weighting using rules, not AI;
- duplicate-to-family-Essence conversion;
- collection union and active-companion switching.

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
- permission-revocation recovery;
- baseline-aware net word, note, and resolved-link events;
- safe rename and delete behavior;
- no note-content upload.

The website scans while open or on demand. Monitoring a closed browser is out of
scope for this phase.

**Status: partial — verified event normalization and derived-only merge contracts are shipped; product sync API wiring and OAuth integration remain.**

## Phase 5. GitHub identity and sync

**Depends on:** Phases 1 and 2.

Add optional GitHub sign-in and derived-state sync:

- GitHub OAuth identifies the user and protects recovery;
- public GitHub events are server-verified;
- local note events remain labelled local/unverified;
- sync payloads reject note contents at the schema boundary;
- first sign-in imports guest state when no server state exists;
- existing server state merges by event ID without double-counting;
- companion XP remains per companion after merge;
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
- extension showing public synced state only;
- static README badge;
- mobile read-only fallback.

The extension must never read a local vault. The README badge must not imply that
private or local note activity was independently verified.

## Phase 7. Marketplace and original art

**Depends on:** Phases 3 and 6.

Define the artist provider contract and moderation workflow:

- original asset upload;
- explicit license and attribution;
- progression and form metadata;
- tags and rarity;
- preview and accessibility text;
- moderation and takedown state;
- provider versioning and asset fallback.

Do not commercialize Pokémon names, designs, or sprites. Replace the prototype
provider before marketplace launch or other commercial distribution.

## Verification commands

Run these before merging any implementation phase:

```bash
npx tsc --noEmit
npm test
npm run build
```

For source and sync work, also test with an empty garden, a large vault, many
repositories, repeated scans, a new device, offline mode, permission loss, and
a guest-to-account merge.
