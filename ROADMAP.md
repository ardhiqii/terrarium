# Roadmap

This is the execution status for the product described in
[`PRODUCT.md`](PRODUCT.md). `DESIGN.md` describes the visual system and
[`PLAN.md`](PLAN.md) contains the implementation plan. The earlier T0-T30 files
remain useful as historical implementation notes, but they are not the current
product contract.

Last reviewed: **2026-08-28**

## Product direction

The project is an offline-first companion for developers. A user can open the
website as a guest, receive a starter companion, and use a built-in editor or
mount an existing Markdown folder. GitHub is optional for verified development
activity, account recovery, sync, public profiles, and the browser extension.

The user chooses one active companion. That companion receives new XP, while the
collection preserves every other companion and its XP. Encounters are random but
weighted by transparent work signals. Duplicates become family-specific Essence.

## Current status

### Shipped prototype

- Personal digital-garden site with notes, projects, tags, search, and graph.
- Existing snapshot-based garden and GitHub XP engine.
- Four-stage botanical creature UI and item drawer.
- Public creature JSON API and static README badge.
- Browser extension for public GitHub pages.
- Built-in Markdown editor and local File System Access folder mounting.
- GitHub sign-in and derived-state sync foundation.
- PokeAPI sprite adapter with local fallback.

### Just verified

- All 36 currently configured default Pokémon sprite IDs returned live animated
  GIF assets.
- The adapter now reads Pokémon and species metadata, including form name,
  default-form state, static/animated asset URLs, and evolution-chain ID.
- Alternate forms with no animation use their static PokeAPI sprite.
- Legacy cache entries refresh once to gain the new metadata, then remain
  cache-first.
- `npx tsc --noEmit` passes.
- `npm test` passes: 545 tests across 40 files.
- `npm run build` succeeds.

### Known prototype mismatch

The old `SPECIES_LINES` configuration is a visual progression, not a set of
canonical Pokémon evolution families. For example, its current line combines
Pichu, Pikachu, Electabuzz, and Electivire. This must be replaced by provider
configurations that declare real families and valid evolution paths before the
collection is considered final.

## Delivery order

| Phase | Goal | Status |
|---|---|---|
| 0 | Product and data contracts | **in progress** |
| 1 | Guest onboarding and local profile | planned |
| 2 | Event ledger and basic XP | planned |
| 3 | Companion catalog, forms, and encounters | planned |
| 4 | Recursive Markdown and Obsidian mounting | partial, needs upgrade |
| 5 | GitHub verification and guest sync merge | partial, needs new model |
| 6 | Collection UI, profiles, extension integration | partial, needs new model |
| 7 | Licensed marketplace providers and original art | future |

The detailed acceptance criteria for each phase are in [`PLAN.md`](PLAN.md).

## Immediate next work

### 1. Freeze the new contracts

Add types for:

- guest and account profiles;
- source baselines;
- normalized source events;
- per-companion XP ledgers;
- encounter progress and persisted results;
- family-specific Essence;
- provider metadata, forms, evolution paths, asset URLs, and licenses.

Do not extend the old aggregate `CreatureState` shape indefinitely. Migrate the
consumers deliberately.

### 2. Implement the event ledger

Normalize note and GitHub changes into stable, replay-safe events. Establish a
baseline when an existing source is first connected so old history can influence
the first companion but cannot flood the user with retroactive XP.

### 3. Replace fake species lines

Create a provider-neutral companion catalog. The PokeAPI provider should resolve
species, forms, evolution chains, and the best available asset. The game engine
should consume only the provider contract. Keep the PokeAPI provider isolated so
it can be replaced with licensed artist assets.

### 4. Build encounters and collection

Add a quiet encounter meter, persisted weighted draws, duplicate conversion, one
active companion, free switching, and per-companion XP. Test refreshes, repeated
events, duplicate results, offline mode, and deterministic replay.

### 5. Upgrade local source handling

Make mounted folders recursive, ignore `.obsidian` and hidden system folders,
hash content when modification metadata is insufficient, and calculate net
changes relative to the source baseline. Keep the no-plugin decision for the
first version.

### 6. Migrate sync and public surfaces

Merge guest state by event ID, keep local and verified provenance visible, and
ensure public profiles and the extension show derived state only. Do not expose
note contents through sync or public APIs.

## Product decisions not to reopen during implementation

- No authentication gate for first use.
- No desktop app requirement for the core experience.
- No Obsidian plugin for the first version.
- No automatic upload of note contents.
- No AI quality judge or AI-detection penalty.
- No paid Pokémon companions or paid random rolls.
- One active companion, many collectible companions.
- Duplicates are useful through family-specific Essence.
- PokeAPI is prototype-only; marketplace art must be licensed.

## External constraints

PokeAPI documents Pokémon species, varieties/forms, and evolution chains in its
[v2 API documentation](https://pokeapi.co/docs/v2). Its sprite repository also
states that the image contents are copyrighted by The Pokémon Company in its
[license notice](https://github.com/PokeAPI/sprites/blob/master/LICENCE.txt).
Use those assets for prototyping only and replace them before commercial
distribution.

## Branch and verification policy

`main` is the only long-lived branch. Use a short-lived `feat/`, `fix/`,
`chore/`, or `docs/` branch, push it, and merge through a pull request. Before
merging, run:

```bash
npx tsc --noEmit
npm test
npm run build
```
