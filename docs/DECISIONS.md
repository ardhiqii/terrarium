# Terrarium product decisions

This document records the product decisions from the initial Terrarium
brainstorm. It is intentionally separate from implementation details: the
product specification describes the full contract, while this page explains
why the first version works the way it does.

## Product idea

Terrarium is a companion layer for the work people already do. A user can
write notes, maintain projects, and ship code in familiar tools; Terrarium
turns that history into a visible companion journey.

The companion is the centre of the experience. We do not ask the user to pick
an abstract productivity focus such as “build software” or “write and think.”
The user chooses one companion to receive qualifying activity, while the
collection keeps every companion they have encountered.

## Start simple and local

- A new user receives a companion immediately, without authentication or a
  desktop download.
- The first session runs as a local guest profile.
- On first setup, the user may let existing notes or GitHub history influence
  the starter, choose a fully random starter, or connect a source later.
- Existing history chooses the starter’s identity and origin story. It does
  not become retroactive XP; progress begins at the first source baseline.
- Signing in is an upgrade for sync, recovery, public profiles, and the
  extension—not a prerequisite for using the core loop.

This gives users a useful first moment even when they have many repositories
or many notes. A large archive is context, not a reason to make onboarding
complex.

## Sources are optional and respectful

Terrarium supports three starting paths:

1. A built-in Markdown editor for users who do not already have a note tool.
2. A mounted Markdown folder, including an Obsidian vault, Logseq graph, or
   ordinary Markdown folder.
3. A connected GitHub account for verified development activity and recovery.

The first mounted-folder version uses the browser File System Access API; it
does not require an Obsidian plugin. The user opens Terrarium and chooses
**Scan again** when they want to refresh local activity. The app reads Markdown
metadata and derived change signals, ignores `.obsidian` and hidden system
folders, and does not upload note contents by default.

The website cannot observe a local folder while it is closed. GitHub can refresh
server-side, so it is the durable sync path when a user wants progress across
devices or a public profile. The extension shows public synced state and does
not read local notes.

## XP should be explainable

XP belongs to the active companion, not primarily to the account. There is one
active companion at a time, and switching companions never moves or deletes
the previous companion’s XP.

The first balance uses simple evidence-based events:

- qualifying active days and work sessions;
- new notes and net-new words after the source baseline;
- newly resolved links;
- merged pull requests, releases, linked issues, and successful CI.

The exact values live in [`PRODUCT.md`](PRODUCT.md). Every event has a stable
ID, source, timestamp, evidence type, and verification state. The event ledger
prevents repeated scans, refreshes, empty commits, and duplicate deliveries
from awarding XP twice.

AI assistance is allowed. Terrarium does not try to detect or punish AI use,
and AI does not decide whether work is meaningful. Instead, the public history
shows the evidence—commits, pull requests, reviews, releases, and CI—so people
can understand the activity for themselves. GitHub events may be marked
verified; local guest events remain local until the user provides a trusted
sync path.

## New companions come from play

One companion would become repetitive, so the collection loop matters:

1. Qualifying activity fills a hidden encounter meter.
2. Reaching a threshold creates one encounter.
3. The result is a persisted random draw, weighted by evidence such as recent
   languages, file types, note tags, links, and activity shape.
4. The result is saved before it is displayed, so a refresh cannot reroll it.
5. Duplicates are allowed and convert into family-specific Essence.

New companions are earned through activity and milestones, not purchased. A
user can receive a rare result, but the first prototype has no paid rolls and
no pity system. Rarity, duplicate value, thresholds, and any collection limit
must be tuned through playtests rather than guessed into the first release.

## Evolution and assets are separate concerns

XP milestones describe the user’s progression with a companion. An asset
provider defines that companion’s valid forms and evolution chain. These must
not be conflated:

- a real provider evolution chain may drive evolution when it exists;
- a final milestone may be a valid form or cosmetic mastery state, labelled as
  such rather than presented as a canonical evolution;
- branching forms need explicit tags and configuration;
- every form needs an animated asset, a static fallback, or both.

Pokémon and PokeAPI are useful for prototyping the provider adapter, but
Pokémon names, designs, and sprites are not Terrarium’s commercial assets. The
future marketplace is for artist-created families with explicit licences,
attribution, progression metadata, encounter tags, rarity, moderation state,
and fallback assets. The game engine must consume a provider contract so that
Pokémon can later be replaced by original creatures, Digimon-like families,
anime-inspired characters, or other licensed art without changing the XP loop.

## Guest-to-account sync

Guest progress is valuable immediately but is not automatically durable. The
app warns users that browser storage can be cleared and that a new device has
no guest state.

When a guest signs in, the server merges the local event ledger by stable event
IDs, unions collections, preserves each companion’s XP, and keeps the selected
active companion when possible. This makes sync idempotent and prevents the
same note scan or GitHub event from paying twice. A new device can restore
synced derived state and verified GitHub activity, but cannot restore local
note history that was never synced or exported.

## What remains deliberately open

These decisions should be resolved with a small friend test, not by adding
complexity prematurely:

- encounter thresholds and rarity weights;
- whether Essence improves a family, unlocks a reroll, or only contributes to
  evolution;
- whether a collection needs a quantity limit;
- the final provider schema and artist moderation workflow;
- the exact local Markdown diff strategy for renames, moves, and edits;
- server retention, privacy controls, and public-profile visibility defaults.

These are product tuning questions. They do not block the basic promise:
start immediately, bring the tools you already use, earn explainable progress,
and collect companions that reflect the work you actually do.
