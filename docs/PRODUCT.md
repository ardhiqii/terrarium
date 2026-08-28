# Companion product specification

This is the product-level source of truth for the companion system. `DESIGN.md`
defines the visual language. `PLAN.md` defines the implementation sequence.
`ROADMAP.md` records what is shipped and what is next.

## 1. Product in one sentence

An offline-first companion for developers: the user writes notes and ships work
in the tools they already use, and one chosen companion grows from that history.

The companion is the product, not a productivity score. The system should make
work feel visible and rewarding without requiring an account, moving notes to a
new platform, or using AI to judge whether a person did “real” work.

## 2. Core vocabulary

| Term | Meaning |
|---|---|
| **Guest** | A user with local progress and no account. The app works immediately. |
| **Source** | A built-in note editor, mounted Markdown folder, or connected GitHub account. |
| **Companion** | A collectible character with its own XP and progression. |
| **Active companion** | The one companion currently receiving activity XP. |
| **Collection** | Every companion the user has encountered, including duplicates. |
| **Encounter** | A random new companion result earned from activity. |
| **Evolution** | A companion’s configured progression through valid assets or forms. |
| **Essence** | The family-specific value created by duplicate encounters. |
| **Event ledger** | An idempotent list of source events already counted for XP. |

The user chooses a companion, not an abstract focus such as “build software” or
“write and think.” All qualifying activity goes to the active companion. The
collection and the event history explain what happened.

## 3. First-run behavior

The first visit must not require authentication or a desktop download.

1. The user opens the website and receives a starter companion immediately.
2. The app creates a local guest profile in browser storage.
3. The user may personalize the first companion in one of three ways:
   - **Let my work decide:** inspect connected notes or GitHub history and use it
     to choose a weighted companion identity.
   - **Surprise me:** choose a fully random valid companion.
   - **Connect later:** keep the starter and connect a source when ready.
4. Existing history affects the first companion’s identity and origin story. It
   does not become retroactive XP. XP starts from the baseline recorded when the
   source is first connected.

The starter must be visible before the user makes any connection. A source is an
optional way to personalize the companion, not a gate in the onboarding flow.

## 4. Sources and privacy

### 4.1 Built-in editor

The website includes a Markdown editor for users who do not already have a note
tool. Notes remain in local browser storage until the user explicitly exports or
syncs derived state.

### 4.2 Mounted Markdown folders

The user can mount an existing Obsidian vault, Logseq graph, or ordinary folder
of Markdown files through the browser File System Access API. No Obsidian plugin
is required for the first version.

- Read `.md` and `.mdx` files recursively.
- Ignore `.obsidian`, hidden system folders, and non-Markdown files.
- Scan when the website is open or when the user presses **Scan again**.
- Request permission again when the browser revokes the folder handle.
- Do not upload note contents.
- Detect changes with file path, modification time, size, and content hash when
  needed. Count only a new post-baseline change once.

The website cannot observe a local folder while it is closed. A desktop viewer
may be added later, but it is not required for the core product.

### 4.3 GitHub

GitHub is the verification source for public development activity. A connected
GitHub account enables server-side refresh, recovery, public profiles, and the
extension. GitHub data may refresh while the website is closed.

The app stores derived events and progress, not repository contents. The public
profile shows an evidence-based activity history, never a hidden “quality score.”

### 4.4 Guest and account transitions

Guest state is local and can be lost with browser storage, a cleared profile, or
a new device. The app warns about this and recommends signing in or exporting a
backup.

When a guest signs in:

- If there is no server profile, import the local event ledger and collection.
- If a server profile exists, merge event IDs instead of adding XP twice.
- Union collections and preserve each companion’s XP independently.
- Keep the selected active companion when it still exists; otherwise ask the
  user to choose one.
- Make the server snapshot authoritative after the merge.

A new device starts with no guest state. Signing in can restore synced derived
state and verified GitHub activity, but it cannot restore unsynced local note
history.

## 5. XP model

XP belongs to the active companion. The system may show a small account-level
encounter meter internally, but it must not become a second prominent level bar.

### 5.1 Prototype rates

These are the first playtest values. They reward evidence of sustained work and
outcomes, not raw volume.

| Event | XP | Rules |
|---|---:|---|
| Qualifying active day | 10 | Once per source per calendar day. |
| Work session | 10 | Maximum two sessions per source per day. |
| New note | 25 | Once per note after the source baseline. |
| 100 new words | 5 | Count net new body words, not repeated scans. |
| New resolved wikilink | 3 | Only when the target exists. |
| Merged pull request | 25 | One event per merged PR. |
| Published release | 40 | One event per release. |
| Closed linked issue | 10 | Only when linked to the project or PR. |
| Successful CI on merged PR | 10 | One qualifying success per merged PR. |

Empty commits, unchanged saves, refreshes, repeated scans, and duplicate webhook
deliveries award zero additional XP. Tiny commits may be grouped into one work
session. Generated-only changes are ignored or given no more than a minimal
signal, depending on the source metadata.

### 5.2 Anti-farming rules

- Every event has a stable ID and is counted through the event ledger.
- Daily and per-source caps are applied before XP is summed.
- A commit is evidence of activity, not proof of quality.
- The app does not attempt to detect or punish AI-assisted work.
- Public activity displays the underlying evidence, such as commits, PRs,
  releases, reviews, and CI outcomes, so other people can judge the history.
- Server-verified GitHub events are marked verified. Guest and local-note events
  are marked local and unverified until the user provides a trusted sync path.

This is deliberately a rules-based system. AI may help summarize activity later,
but it must not decide whether XP is deserved.

## 6. Encounters and collection

Encounters are the main source of dopamine after the first companion.

1. Activity fills a hidden **encounter progress** meter.
2. When a threshold is reached, the app performs one deterministic random draw.
3. The result is persisted before it is shown, so refreshes cannot reroll it.
4. The draw is weighted by simple evidence from the recent work: languages,
   file types, note tags, links, and activity shape. No AI is required.
5. The user may switch active companions at any time. Switching never deletes or
   transfers the previous companion’s XP.
6. A duplicate is allowed. It converts into Essence for that companion family,
   which can improve that family or contribute to its evolution.

There is no paid roll, no paid Pokémon content, and no pity system in the first
prototype. Rare tiers are allowed, but the initial balance should be measured
with playtests before adding protection mechanics. A duplicate should feel useful
without making collection completion mandatory.

## 7. Evolution and asset providers

The app’s XP milestones and a provider’s lore evolution chain are separate
concepts.

- A companion definition declares its family, progression steps, encounter tags,
  asset provider, and forms.
- If a provider has a real evolution chain, the configuration must use a valid
  path through that chain. The app must not invent a fake species-to-species
  evolution while calling it canonical.
- Families with two or three real stages may use two or three evolution steps.
  A final mastery milestone may use a valid form or cosmetic variant, but it
  must be labelled as mastery/form, not as a new evolution.
- Branching families choose a branch through explicit configuration and tags.
- A form may have an animated asset, a static asset, or both. The renderer uses
  animation when available and a static fallback otherwise.

The current PokeAPI adapter now reads Pokémon, species, form, sprite, and
evolution-chain metadata and caches it. The existing four-stage visual mappings
are legacy prototype data and must be replaced by real family configurations
before the companion collection is considered final.

PokeAPI is acceptable for local prototyping. Pokémon names, designs, and sprites
are not a commercial asset license. A commercial marketplace must use artist
assets with explicit licenses, not Pokémon assets.

## 8. Marketplace direction

The future marketplace is an asset-provider system, not a Pokémon store.

An artist submission should include:

- asset files and animation variants;
- license, attribution, and commercial-use terms;
- companion family and progression metadata;
- form IDs and fallback assets;
- encounter tags and rarity settings;
- preview images and moderation state.

The game engine should consume this provider contract so PokeAPI can be replaced
without changing XP, encounters, collection, or sync.

## 9. Public surfaces

- **Website:** onboarding, local sources, active companion, collection, ledger,
  and privacy controls.
- **Public profile:** synced derived state and evidence, with verification labels.
- **GitHub extension:** displays public synced companion state beside repositories;
  it does not read local notes.
- **README badge:** static fallback for a public profile or selected companion.
- **Desktop viewer:** optional future companion display, not a prerequisite.

Game UI stays off reading pages except for a quiet optional footer strip.

## 10. Success criteria for the first real prototype

The product is ready for a small friend test when:

- a guest can start and use the app without authentication;
- a user can connect the built-in editor or a recursive Markdown folder;
- GitHub activity can be connected and verified separately from local notes;
- XP is idempotent, capped, and explainable event by event;
- one active companion can be switched without losing per-companion XP;
- encounters are random, weighted, persisted, and duplicate-safe;
- first-companion selection supports work-based and fully random paths;
- sign-in merges guest state without double-counting;
- the collection works with real provider metadata and static asset fallback;
- the extension shows only public synced state;
- no note content is uploaded by default.
