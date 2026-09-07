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
- The starter is visible immediately. On first setup, the user may either
  choose **Surprise me** for a random valid family or choose **Let my work
  decide** so connected GitHub and Markdown sources can influence the family.
  Keeping the starter and connecting a source later remains available without
  becoming a separate onboarding gate.
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

Local note activity is private by default. A public profile may optionally show
only a vague aggregate signal such as “Local notes contributed.” It must never
expose note titles, contents, file paths, tags, backlinks, or private graph
structure. The user controls whether even the aggregate signal is shown.

Public companion visibility is opt-in. A companion is private until the owner
enables a public profile and chooses the surfaces where it may appear, such as
the GitHub profile, public repository pages, or a Terrarium profile. Disabling
the profile removes it from those surfaces. The extension must show nothing for
a user who has not opted in.

The owner controls the public presentation. The initial controls cover the
companion appearance, display name, short bio, level and evolution, recent
public activity, selected public projects, and an optional aggregate note-
contribution signal. All other profile details remain hidden unless explicitly
enabled. The extension hover card shows only a compact subset and links to the
full Terrarium profile for detail.

Extension reactions and progression are separate. Browsing repositories,
profiles, commits, pull requests, releases, or issues may trigger an immediate
visual reaction, but never grants XP. XP comes from normalized, verified source
events after sync; the extension itself does not award XP, which prevents page
clicks or fabricated browser activity from inflating progression.

The first companion reaction layer is dialogue-first. A companion can express
idle, focused, curious, excited, and resting moods through short text bubbles
and simple UI treatment; moods are friendly and never punish the user or affect
XP. Character animation is an optional asset capability, not a requirement for
the core product. Artist-provided skins may later add animations, replace the
dialogue presentation, or enable both together without changing game identity,
XP, or progression rules.

Initial dialogue is predefined by the companion or skin. Users can choose a
quiet, balanced, or chatty frequency, disable dialogue while keeping the
companion visible, and set a companion nickname. Deeper custom dialogue and
community or artist personality packs remain later features.

Progress never decays. When the user is inactive, the companion may enter a
resting or sleepy mood and welcome the user when they return, but inactivity
never removes XP, lowers a level, deletes a collection item, or punishes the
user.

## GitHub access follows user approval and repository visibility

GitHub is the primary developer source. Terrarium may read public repositories,
private personal repositories, and private organization repositories when the
user has permission and explicitly selects or approves them. It must not scan
every repository an account can access by default.

Repository selection comes from GitHub's repository list, not a manually typed
repository name. The picker groups personal and organization repositories and
shows visibility and permission state. Users may select all currently visible
repositories, but newly created repositories are not selected automatically by
default.

Automatic inclusion is an opt-in convenience. It can be enabled separately for
future personal repositories and for each approved organization. It covers
public and private repositories only when GitHub permission exists; it never
overrides a revoked or missing permission. A newly discovered repository is
shown to the user, starts with a fresh baseline, and does not award retroactive
XP. Users may exclude it, and an exclusion remains in effect until the user
manually enables the repository again.

Public and approved private repositories use the same normalized activity rules.
The connected GitHub account is one XP source for daily caps, so selecting more
repositories cannot multiply the user's daily reward. Repository selection only
controls which future activity is read; removing a repository stops future
events but does not erase XP already earned from it.

Commits are evidence of activity, not an unlimited per-commit XP faucet. Empty
or generated-only commits do not award XP. Active days and work sessions are
capped, while meaningful outcomes such as merged pull requests, releases, and
successful CI award one stable event each. Repeated API scans, webhooks, CI
reruns, renamed repositories, and duplicate deliveries must resolve to stable
event IDs and never pay twice.

The signed-in owner may see their own private activity details. Public profiles
follow repository visibility: public activity may be shown with its normal
evidence, while private repository names, pull requests, issues, file paths,
and code are never exposed publicly. Private activity affects the owner's
companion but is not part of the public profile by default.

Disconnecting GitHub, removing a repository, revoking organization access, and
deleting synced derived data are supported user controls. The server stores
derived activity and progression only, never repository contents, code, or
private note text.

## XP should be explainable

XP belongs to the active companion, not primarily to the account. There is one
active companion at a time, and switching companions never moves or deletes
the previous companion’s XP.

The first balance uses simple evidence-based events:

- qualifying active days and work sessions;
- new notes and net-new words after the source baseline;
- newly resolved links;
- merged pull requests, releases, linked issues, and successful CI.

Note activity follows the same general rule as GitHub activity: reward returning
to meaningful work, not raw volume. The initial note event set is deliberately
small:

- a meaningful writing session gives a small amount of XP;
- a new note or project gives a one-time bonus after the source baseline;
- net-new body words give a small, coarse bonus;
- a newly resolved wikilink gives a connection bonus once.

Unchanged scans, repeated saves, opening or reading notes, random metadata
changes, tags, backlinks, and maturity labels do not award XP initially. A new
wikilink is rewarded once; the resulting backlink is not a second reward for
the same action. Note-derived signals can still influence encounters and the
companion's presentation without becoming another XP economy.

Multiple sources may contribute to the same companion. GitHub and local notes
are treated as separate explainable ledgers, so writing a design note and then
shipping code can both count as meaningful work. Terrarium does not inspect note
content to decide whether it matches a commit. Source-level deduplication still
prevents repeated scans or deliveries from paying twice, while cross-source
diminishing returns or a global soft limit prevents adding more sources from
multiplying XP without bound.

Mounted Markdown uses conservative lifecycle handling. An edit produces only
valid post-baseline diff events. A rename or move preserves the note identity
when the local scan can confidently match it, and never creates a new-note bonus.
A deletion stops future events but never removes earned XP. Recreating a deleted
note does not repeatedly pay the new-note bonus. If a rename, move, or identity
match is uncertain, Terrarium keeps the existing history and awards no new-note
bonus rather than guessing. These comparisons happen locally during a scan; the
server never needs note content.

Terrarium follows the mounted vault's actual link semantics for the current
graph. A note's internal identity is used for history, XP, and cautious rename
continuity, but it must not silently turn an old unresolved link into a valid
edge. If a rename was performed by the note editor and links were updated, the
graph follows those updated links. If a file was renamed externally and links
were not updated, Terrarium shows the link as unresolved, preserving compatibility
with the source vault. Core Wikilinks, Markdown file links, and note aliases are
supported; editor-specific block references and embeds remain out of scope for
the first version.

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

The canonical model is a provider-neutral companion catalog. Terrarium owns the
shared XP curve and progression slots; a provider or artist maps each slot to a
form, story beat, cosmetic, animation, or mastery reward. Pokémon families can
use a curated path from PokeAPI, while artist families can define their own
creative line without imitating Pokémon biology. Artists define the creative
sequence, but cannot change XP thresholds or progression integrity rules.

The user state stores a family ID, catalog version, XP, Essence, and selected
skin. The current progression slot is derived from XP and the catalog version,
not stored as an independent source of truth. A skin changes appearance for
compatible progression slots; a completely different progression line is a new
family. Catalog updates are versioned so an asset change cannot unexpectedly
move a user's companion backward.

Pokémon and PokeAPI are useful for prototyping the provider adapter, but
Pokémon names, designs, and sprites are not Terrarium’s commercial assets. The
future marketplace is for artist-created families with explicit licences,
attribution, progression metadata, encounter tags, rarity, moderation state,
and fallback assets. Marketplace publishing is future scope and must not block
the first product loop. When it is built, automated package validation, safety
scanning, creator-declared licensing, community reports, and takedown/fallback
controls are preferred over manual review of every submission. The game engine
must consume a provider contract so that
Pokémon can later be replaced by original creatures, Digimon-like families,
anime-inspired characters, or other licensed art without changing the XP loop.

## Guest-to-account sync

Guest progress is valuable immediately but is not automatically durable. The
app warns users that browser storage can be cleared and that a new device has
no guest state.

Version-one mounted-note history is local to the browser and device. Terrarium
does not attempt automatic cross-device note-history merging because the server
does not receive note contents and cannot reliably prove that two mounts are the
same vault. Users may later export and import a privacy-safe Terrarium state
backup to move derived note history deliberately. GitHub remains the durable
cross-device source for verified development activity.

When a guest signs in, the server merges GitHub events by stable event IDs and
imports the current companion condition and collection. Local-note history is
not uploaded as a detailed event ledger. If local-note sync is enabled, the
server receives only a private condition snapshot and sync checkpoint, so the
same local progress is not counted twice without exposing note activity details.
A new device can restore the synced companion condition and verified GitHub
activity, but cannot restore local note history that was never synced or
exported.

Sync conflicts use a simple split rule. Irreversible progression—XP, evolution,
Essence, collection membership, and persisted encounters—merges automatically
and never moves backward. Mutable preferences—active companion choice, nickname,
dialogue frequency, and public-profile settings—may show a local-versus-cloud
choice. A failed sync keeps local state intact for retry; sync never silently
discards progression.

Destructive controls are separate and explicit. Disconnecting GitHub stops future
tracking but keeps earned progression. Removing a mounted source stops future
scans but keeps earned progression. Resetting local state clears browser-held
progress only after confirmation. Deleting cloud state removes synced companion
data but never deletes local note files. The product should offer an export
backup before destructive actions.

Progression pacing should feel welcoming early and meaningful later. The first
evolution should be reachable after a short period of genuine activity, later
evolutions should require increasingly sustained work, and encounters should
occur more often than evolutions. No evolution, level, or collection progress
is ever lost.

All companion families use the same XP evolution curve in the first version.
Families may differ in valid forms, personality, encounter weighting, and art,
but choosing a family must not secretly create a longer grind. Essence may add
optional family mastery or cosmetics without changing the shared XP curve.

## What remains deliberately open

These decisions should be resolved with a small friend test, not by adding
complexity prematurely:

- encounter thresholds and rarity weights;
- the exact Essence thresholds and family mastery rewards;
- whether a collection needs a quantity limit;
- the final provider schema and artist moderation workflow;
- server retention and the remaining public-profile privacy controls.

These are product tuning questions. They do not block the basic promise:
start immediately, bring the tools you already use, earn explainable progress,
and collect companions that reflect the work you actually do.
