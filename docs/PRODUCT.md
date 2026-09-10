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
3. The user may personalize the first companion in two ways:
   - **Let my work decide:** inspect approved GitHub or mounted Markdown
     signals and use them to choose a weighted companion family.
   - **Surprise me:** choose a fully random valid companion family.
4. The user can also keep the immediate starter and connect a source later.
5. Existing history affects the first companion’s identity and origin story. It
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

Folder mounting is progressive enhancement, not a requirement for using the
website. Browsers with the File System Access API get the best experience: a
remembered folder handle and on-demand rescans. Other browsers get a clearly
labeled **Scan folder once** fallback using directory selection or drag and
drop. The fallback reads the selected files locally and stores only derived
state; it does not upload anything, but the user must select the folder again
to detect later changes. The website cannot observe a local folder while it is
closed. A desktop viewer may be added later for reliable background monitoring.

Local note activity is private by default. The user may opt in to a vague
aggregate public signal, such as “Local notes contributed.” Public surfaces
must never expose note titles, contents, file paths, tags, backlinks, or private
graph structure. The aggregate signal is separate from the note XP ledger and
does not make local note activity independently verified.

Cloud sync for local notes is condition-only and opt-in. The user chooses
whether to keep cloud sync off, sync manually with **Sync now**, or sync on a
schedule while the website is open. The default interval for scheduled sync is
15 minutes, with manual, 5-minute, and 30-minute options. A scheduled cycle
first scans the local folder, then syncs only if cloud sync is enabled and the
scan produced relevant derived changes.

When syncing, Terrarium may upload a private companion condition snapshot and
sync checkpoint, such as XP, evolution, collection, and encounter state. It
does not upload note contents, titles, paths, graph edges, exact writing
history, or detailed note events. A new device can restore the companion
condition, then mount the folder and establish a fresh local note baseline.
The website cannot scan or sync a mounted folder while it is completely closed;
reliable background syncing is reserved for a future desktop app.

### 4.3 GitHub

GitHub is the primary remote source for developer activity. A connected GitHub
account may include public repositories, private personal repositories, and
private organization repositories when the user has permission and explicitly
selects or approves them. Terrarium must not automatically scan every
repository the account can access.

Repository access is chosen from GitHub's repository list rather than by typing
repository names. The picker groups personal and organization repositories and
shows visibility and permission state. Selecting all means all repositories
currently shown; newly created repositories are not selected by default.

Users may opt in to automatic inclusion separately for future personal
repositories and each approved organization. Automatic inclusion respects
GitHub permissions and never bypasses a revoked or missing grant. A newly
discovered repository is surfaced to the user, starts with a fresh baseline,
and contributes no retroactive XP. Excluding it stops future tracking and stays
in effect until the user explicitly enables it again.

The connection flow must explain the difference between GitHub access and
Terrarium tracking before authorization: **Approved** means Terrarium may read
activity from a repository; **Tracked** means that repository contributes to the
companion's progress. After returning from GitHub, show a setup prompt if no
repositories are tracked and show the counts of approved versus tracked
repositories in the source settings.

Reminders are action-based and quiet. Show a one-time permission explanation
before authorization, a persistent status with **Manage repositories**, and a
single notification when new eligible repositories appear. A dismissed
repository reminder stays dismissed until its access or tracking state changes.
If permission is revoked, tracking pauses and the owner sees **Reconnect or
review access**. Private repository names and reminder details remain visible
only to the owner.

The same activity rules apply to public and approved private repositories. The
connected GitHub account is one source for daily XP caps, so selecting more
repositories cannot multiply rewards. Removing a repository stops future
tracking but does not erase XP already earned from it.

Commits are evidence of activity rather than unlimited direct XP. Empty and
generated-only commits award no XP. Active days and work sessions are capped;
merged pull requests, releases, linked issues, and successful CI produce stable
one-time events. Repeated scans, webhook deliveries, CI reruns, repository
renames, and other duplicate deliveries must be deduplicated by stable event
IDs.

The owner may see private activity details after authenticating with GitHub.
Public profiles follow repository visibility: public activity may show its
normal evidence, while private repository names, pull requests, issues, file
paths, and code never appear publicly. Private activity affects the owner's
companion but is excluded from public profiles by default.

GitHub XP belongs to the connected user, not to the repository as a whole. A
commit counts only when GitHub attributes its author or committer to that user;
pull requests, reviews, issues, and releases count only when created or acted
on by that user. A co-authored commit counts once when the user is one of the
recognized authors. CI contributes only when tied to an eligible
user-attributed commit or pull request. Teammate activity, unrelated bot
activity, and repository-wide activity do not grant the user's XP.

AI-assisted work is treated as the user's work when the AI acts through the
user's GitHub identity. If an AI tool uses a separate bot identity, the user
must explicitly link that identity before its activity can count; commit
messages or display names alone are not proof. Linked AI activity shares the
user's normal caps and deduplication rules and does not create a second XP
source.

Users can disconnect GitHub, remove selected repositories, revoke organization
access, and delete synced derived data. GitHub may refresh server-side while the
website is closed, but the server stores derived activity and progression only,
never repository contents or code.

The public profile shows an evidence-based activity history, never a hidden
“quality score.”

Public companion visibility is opt-in. A user must enable a public profile
before the companion can appear on GitHub or in Terrarium discovery. The user
can choose which public surfaces are enabled and can hide the profile later.
When the profile is disabled, the extension shows no companion for that user.

The owner controls the public presentation. The first version supports toggles
for companion appearance, display name, short bio, level and evolution, recent
public activity, selected public projects, and an optional aggregate note-
contribution signal. Unselected details remain hidden. The extension hover card
is a compact preview of this public profile and links to the full profile.

The extension may react immediately to browsing context, such as viewing a
repository, commit, pull request, release, or issue. These reactions are visual
only and do not award XP. Progression changes only when normalized source events
are synced and accepted by the XP engine; the extension never grants XP from
page clicks or browsing alone.

The initial reaction system is dialogue-first so the product does not depend on
expensive character animation. Companions can show short messages for idle,
focused, curious, excited, and resting moods. These moods are friendly flavor,
not a score or punishment. Later artist skins may provide animations, replace
dialogue reactions, or combine animation and dialogue while preserving the same
companion identity and progression.

Dialogue is predefined by the companion or skin in the first version. Users can
choose a quiet, balanced, or chatty frequency, disable dialogue while keeping
the companion visible, and set a nickname. Custom dialogue editing and
community personality packs are deferred until the core reaction loop is
validated.

Progress never decays. During inactivity the companion may rest or become
sleepy, and it may welcome the user when they return, but inactivity never
removes XP, lowers a level, deletes a collection item, or creates a penalty.

### 4.4 Guest and account transitions

Guest state is local and can be lost with browser storage, a cleared profile, or
a new device. The app warns about this and recommends signing in or exporting a
backup.

Mounted-note history is device-local in the first version. The server does not
automatically merge note history across devices because it cannot reliably prove
that two mounted folders are the same vault without receiving note contents.
The product should provide an explicit privacy-safe Terrarium state
export/import path for users who want to move derived note history. GitHub is
the durable cross-device source for verified development activity.

When a guest signs in:

- If there is no server profile, import the current companion condition and
  collection; keep detailed local-note history on the device.
- If a server profile exists, merge GitHub event IDs and reconcile local-note
  condition snapshots through sync checkpoints instead of uploading note events.
- Union collections and preserve each companion’s XP independently.
- Keep the selected active companion when it still exists; otherwise ask the
  user to choose one.
- Make the server snapshot authoritative after the merge.

Sync conflicts deliberately separate progression from preferences. XP,
evolution, Essence, collection membership, and persisted encounters merge
automatically and never move backward. If mutable preferences differ—such as
the active companion, nickname, dialogue frequency, or public-profile settings—
the user may choose the local or cloud version. A failed sync preserves local
state and can be retried; it never silently discards progression.

Destructive controls are separate and explicit. Disconnecting GitHub stops
future tracking but keeps earned XP. Removing a mounted folder stops future
scans but keeps earned XP. Resetting local state clears browser-held progress
only after confirmation. Deleting cloud state removes synced companion data but
never deletes local note files. Deleting a Terrarium account immediately hides
the public profile and stops integrations, offers an export backup, and starts
a 30-day deletion period. During that period the user may recover the account;
afterward, cloud profile, companion, sync, and GitHub-token data are permanently
deleted. Account deletion does not alter local note files or automatically
clear browser-held state; **Reset local data** remains a separate explicit
action. Confirmation must name these boundaries clearly.

Progression pacing is welcoming early and more meaningful later. The first
evolution should be reachable after a short period of genuine activity, later
evolutions should require increasingly sustained work, and encounters should
occur more often than evolutions. No evolution, level, or collection progress
is ever lost. Exact thresholds remain playtest values.

All companion families use the same XP evolution curve initially. Families may
have different valid forms, personalities, encounter weights, and art, but a
family choice must not create a hidden longer grind. Essence can provide
optional family mastery or cosmetic rewards without changing the shared XP
curve.

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

Notes use the same activity model as GitHub, with a deliberately small event
set. A meaningful writing session gives base XP, a new note or project gives a
one-time post-baseline bonus, net-new body words give a small coarse bonus, and
a newly resolved wikilink gives one connection bonus. Opening or reading a note,
unchanged saves, repeated scans, arbitrary tag changes, backlinks, and maturity
labels do not award XP initially. A backlink is a graph consequence of a new
resolved link, not a second reward for the same action. Note tags, graph shape,
and other derived signals may still influence encounters and companion
presentation without creating a separate economy.

GitHub and local notes can both contribute to the same companion. A writing
session and a later coding event are valid separate work signals, and the app
does not inspect note content to match them to commits. Each source is
deduplicated independently. Cross-source diminishing returns or a global soft
limit prevents additional mounted sources from multiplying XP without bound.
The ledger explains the source of every reward.

Mounted Markdown handles lifecycle changes conservatively. Edits produce only
valid post-baseline diff events. A rename or move preserves note identity when
the local scan can confidently match it and never creates a new-note bonus. A
deletion stops future events but never removes earned XP, and recreating a
deleted note does not repeatedly pay the new-note bonus. When identity is
uncertain, the app keeps existing history and awards no new-note bonus rather
than guessing. These comparisons happen locally during scanning; note content
is not sent to the server.

The current graph follows the links actually written in the mounted vault. A
stable internal note identity supports history, XP, and cautious rename
continuity, but does not silently repair an old link. Links updated by Obsidian
remain connected naturally; links left stale after an external rename appear as
unresolved. The first version supports core Wikilinks, Markdown file links, and
note aliases. Obsidian-specific block references, embeds, plugins, and Dataview
semantics are not required for the initial graph.

### 5.2 Anti-farming rules

- Every event has a stable ID and is counted through the event ledger.
- Daily and per-source caps are applied before XP is summed. For GitHub, the
  connected account is the source even when multiple repositories are selected.
- A commit is evidence of activity, not proof of quality.
- Empty and generated-only commits do not award XP, and repeated source
  deliveries must be deduplicated by stable event IDs.
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
   which can unlock optional family mastery or cosmetic rewards. Essence does
   not give XP, skip evolution, or act as a general currency.

Evolution is controlled by work XP only. When a companion reaches a progression
threshold, it advances through the valid provider-defined evolution path. A
duplicate encounter and its Essence never become a requirement for evolution.

There is no paid roll, no paid Pokémon content, and no pity system in the first
prototype. Rare tiers are allowed, but the initial balance should be measured
with playtests before adding protection mechanics. A duplicate should feel useful
without making collection completion mandatory.

## 7. Evolution and asset providers

The app’s XP milestones and a provider’s lore evolution chain are separate
concepts.

- A companion definition declares its family, progression steps, encounter tags,
  asset provider, and forms.
- Work XP controls progression through those steps. Family Essence is an
  optional duplicate/mastery track and does not gate or replace evolution.
- If a provider has a real evolution chain, the configuration must use a valid
  path through that chain. The app must not invent a fake species-to-species
  evolution while calling it canonical.
- Families with two or three real stages may use two or three evolution steps.
  A final mastery milestone may use a valid form or cosmetic variant, but it
  must be labelled as mastery/form, not as a new evolution.
- Branching families choose a branch through explicit configuration and tags.
- A form may have an animated asset, a static asset, or both. The renderer uses
  animation when available and a static fallback otherwise.

The canonical model is a provider-neutral companion catalog. Terrarium owns a
shared XP curve and standard progression slots such as starter, growth,
signature, and mastery. A provider or artist maps those slots to forms, story
beats, cosmetics, animations, or mastery rewards. Artists define the creative
sequence, but cannot change XP thresholds or progression integrity rules.

The user state stores the family ID, catalog version, XP, Essence, and selected
skin. The current slot is derived from XP and the catalog version. A compatible
skin maps its own appearance to the same slots and can be changed without
changing XP or family history. A completely different progression line is a
new family, not a skin. Catalog versions keep asset updates from moving a
companion backward.

The current PokeAPI adapter now reads Pokémon, species, form, sprite, and
evolution-chain metadata and caches it. It should populate catalog candidates,
not define the game rules. The existing four-stage visual mappings are legacy
prototype data and must be replaced by real family configurations before the
companion collection is considered final.

PokeAPI is acceptable for local prototyping. Pokémon names, designs, and sprites
are not a commercial asset license. A commercial marketplace must use artist
assets with explicit licenses, not Pokémon assets.

## 8. Marketplace direction

The future marketplace is an asset-provider system, not a Pokémon store.

Marketplace publishing is future scope and does not block the first product
loop. It should use automated package validation and safety scanning, creator-
declared licensing, community reports, takedown controls, and safe fallback
assets rather than requiring manual review of every submission.

An artist submission should include:

- asset files and animation variants;
- license, attribution, and commercial-use terms;
- companion family and progression metadata;
- form IDs and fallback assets;
- encounter tags and rarity settings;
- preview images, automated-check state, and takedown state.

The game engine should consume this provider contract so PokeAPI can be replaced
without changing XP, encounters, collection, or sync.

## 9. Public surfaces

- **Website:** onboarding, local sources, active companion, collection, ledger,
  and privacy controls.
- **Public profile:** synced derived state and evidence, with verification labels;
  available only after explicit owner opt-in.
  Local-note contribution is hidden by default and may appear only as an
  opt-in aggregate signal; note content and structure are never public.
- **GitHub extension:** displays public synced companion state beside opted-in
  users and repositories; it does not read local notes. Hover previews stay
  compact, can be dismissed or moved, and link to the full profile. It can
  react from browsing context through dialogue and optional skin animation, but
  never awards XP directly.
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
