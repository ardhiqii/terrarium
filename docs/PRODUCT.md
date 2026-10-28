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
15 minutes, with manual, 5-minute, and 30-minute options.

**The schedule that exists today runs the GitHub source.** The `/github` screen
offers the same four choices, and the cadence is stored per browser profile
(with the account namespace), because the timer only exists while the page is
open. A scheduled cycle runs the same read a manual **Sync GitHub now** runs:
GitHub activity, verified receipts, and the deferred baseline commit. A cadence
that has never run waits one full interval after the page opens rather than
syncing on load; **Sync GitHub now** is always available. Each sync reads a
window of repositories derived from GitHub's hourly request budget *and* from
the deferred checkpoint's event capacity (16 repositories at the current
bounds), so a cycle costs only a few hundred requests, and repositories that
still need a baseline are read first so a larger tracked set is covered window
by window. A cycle that would overdraw the account's hourly GitHub request
budget is skipped and *says so*, then resumes automatically when the rolling
hour window clears. Terrarium budgets the requests it actually spent, and folds
in what another open tab recorded rather than overwriting it.
The local-note cloud-write schedule (scan first, write only when the scan found
relevant derived changes) remains tied to folder mounting and is not part of
this schedule.

When syncing, Terrarium may upload a private companion condition snapshot and
sync checkpoint, such as XP, evolution, collection, and encounter state. It
does not upload note contents, titles, paths, graph edges, exact writing
history, or detailed note events. A new device can restore the companion
condition, then mount the folder and establish a fresh local note baseline.
The website cannot scan or sync a mounted folder while it is completely closed;
reliable background syncing is reserved for a future desktop app.

### 4.3 Hosted sync storage

The server-side sync boundary is durable Postgres storage for deployments that
may handle requests on more than one short-lived instance. The current hosted
provider is Supabase. It stores the encrypted GitHub credential, repository
tracking settings and baselines, derived product snapshots, and opt-in public
derived profiles. The existing GitHub OAuth/session flow remains owned by
Terrarium; Supabase is a persistence layer, not a second login requirement.

The local SQLite adapter remains the development and persistent single-server
fallback. Vercel must use the Supabase adapter. Supabase tables have row-level
security enabled and are accessed by a server-only key; no database key or
GitHub token is sent to the browser. Applying the checked-in migration is part
of deployment. Note contents and detailed note history remain on the user's
device under the existing condition-only sync contract.

Product snapshots are keyed by immutable GitHub account ID rather than the
mutable login handle. Writes use an optimistic checkpoint so two devices do
not silently replace one another's latest condition. GitHub activity receipts
are issued by the server-side GitHub sync route and verified before a product
upload can preserve `verified` provenance. A cloud restore keeps event IDs
stable so the next provider delivery remains idempotent. Replayed aggregate
signals refresh their evidence without awarding the stable event twice, and
ownership stays with the companion that first accepted the event. Account-row
deletes require the current server version and are conditional at the store,
so an open identity chooser cannot erase a newer device's progress. Legacy
rows that have no immutable GitHub ID are not adopted by mutable handle.

If one legacy GitHub receipt no longer matches the canonical product payload,
`/github` keeps the browser ledger, proofs, encounters, and signed checkpoint
in the account-local recovery record instead of clearing them. **Repair receipts
and retry** sends the bounded opaque event IDs together with the short-lived
signed checkpoint that originally named them, or preserves the old server
receipt for a legacy event, to `POST /api/github/repair`; the server re-reads
the approved 16-repository window, checks GitHub attribution
and ownership, and mints receipts only for independently confirmed activity.
Unrecoverable events remain visible as blocked and are never downgraded to local
provenance. Valid events may be backed up without advancing the checkpoint; the
last successful checkpoint advances only after a repaired snapshot is stored.
Repeated repair or sync is idempotent, and XP/caps are recomputed server-side.

The `/companions` archive reads the trusted account product snapshot when a
user is signed in and one exists. It shows that account-scoped XP and
progression separately from the local garden archive. A signed-in user with no
product row or an unavailable row sees an explicit not-synced/unavailable state;
the legacy `github-cache.json` aggregate is not presented as account XP.

### 4.4 GitHub

GitHub is the primary remote source for developer activity. A connected GitHub
account may include public repositories, private personal repositories, and
private organization repositories when the user has permission and explicitly
selects or approves them. Terrarium must not automatically scan every
repository the account can access.

Repository access is chosen from GitHub's repository list rather than by typing
repository names. The picker is a searchable browser with all, individual, and
organization filters plus per-owner grouping, and it shows visibility and
permission state alongside the approved and tracked counts. Selecting all means
all repositories currently shown; newly created repositories are not selected
by default.

Opening the picker must not spend the account's GitHub request budget. The last
successful listing is cached in two places: the browser keeps one copy per
profile (one active GitHub account at a time) and the server keeps one per
account. The server copy answers a request without contacting GitHub for five
minutes and is revalidated on demand with the **Refresh list** button; it is
replaced only by a complete successful listing, never by a partial page or an
error, and an empty listing is cached too so a legitimately empty account does
not hammer GitHub. When GitHub cannot be read, the server serves the last known
listing instead of failing while it is less than an hour old, and the picker
labels what the user is looking at — `List updated 3 min ago`, or
`cached · unavailable · updated …` when the visible list is not fresh. The
browser copy paints instantly on return visits while the server request still
runs, so saved settings stay server-authoritative. A failed read is never
treated as an empty account: nothing is pruned or unselected from it, and a
sync never drops a repository baseline from a listing it could not refresh.
A listing that fills GitHub's last permitted page (500 repositories) is stored
with a `truncated` flag: it is usable, but it is never treated as complete, so
nothing is pruned or silently unselected from it either. The browser copy is
keyed to the active GitHub account; a copy stored for another account is
discarded instead of painted, and a failed read only keeps showing a list the
server confirmed belongs to this account.

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

The current prototype expects a GitHub App configured with fine-grained read
permissions for repository metadata, contents, pull requests, issues, checks,
and required organization approval. It deliberately does not request the
classic `repo` scope, which is broader and includes write-capable access. The
token is stored only in encrypted server-side account state and is never sent
to the browser or included in a sync payload.

Reminders are action-based and quiet. Show a one-time permission explanation
before authorization, a persistent status with **Manage repositories**, and a
single notification when new eligible repositories appear. A dismissed
repository reminder stays dismissed until its access or tracking state changes.
If permission is revoked, tracking pauses and the owner sees **Reconnect or
review access**. Private repository names and reminder details remain visible
only to the owner.

One Terrarium profile has one active GitHub account at a time. Switching is an
explicit action: the previous account becomes archived and stops future
tracking, while its earned XP and owner-only history remain. The new account
requires fresh repository selection and a fresh baseline; it receives no
retroactive XP. Reconnecting an archived account later is another explicit
switch and never resumes it in the background. Public activity defaults to the
current account; archived account details remain private unless the owner
explicitly enables them.

The same activity rules apply to public and approved private repositories. The
connected GitHub account is one source for daily XP caps, so selecting more
repositories cannot multiply rewards. Removing a repository stops future
tracking but does not erase XP already earned from it.

Repository identity follows GitHub's stable repository ID. A rename preserves
the repository's tracking history and baseline. An ownership transfer keeps
history only while the user still has permission; otherwise tracking pauses.
Archiving or deleting a repository stops future tracking but preserves earned
XP and owner history. Visibility changes follow GitHub's current visibility:
private details remain owner-only, and public display is re-evaluated before
the next profile update.

Delayed GitHub sync uses bounded catch-up. Activity becomes eligible only after
the repository is approved and its initial baseline is recorded. Later syncs
may count eligible activity that happened since the last checkpoint, using the
activity date for daily and session caps rather than the sync date. A catch-up
is summarized as one returning update instead of replaying every reaction.
Activity from before approval or the initial baseline never awards retroactive
XP. A sync returns a short-lived signed checkpoint, and the GitHub baseline is
committed only after the derived product condition upload succeeds. The
checkpoint travels with that upload inside the request body, not in a request
header: it carries every event ID the sync issued and both baseline maps, which
for a 44-repository account is tens of kilobytes -- beyond what a request-header
budget accepts. This keeps an interrupted cloud write retryable; receipt or
checkpoint validation failure does not consume eligible activity. A repository
that disappears, is archived, or is paused is cleared back to a fresh baseline
before it can resume. If
GitHub no longer exposes enough history to verify an event, Terrarium does not
guess.

A bounded sync reads only the newest page of each activity list, and it reads a
derived window of repositories. There is no arbitrary repository count: the
window comes from GitHub's hourly request budget on one side and the deferred
checkpoint's event capacity on the other, so a sync can never build a
checkpoint its own validator rejects. A forty-four repository account covers all
forty-four across a few syncs, and repositories that still need a baseline are
always read first, so a repository can never be stranded without one. When a scan
reaches the end of that window with the final page still full, the read is
reported as **truncated** rather than failed: the baseline is still recorded and
the sync reports that the scan window ended. Because every list is read
newest-first, the unread material is older than the recorded baseline and can
never be awarded anyway. A genuinely failed request is treated differently and
still withholds the baseline, so activity that could be newer than the
checkpoint is retried rather than skipped. The sync route streams newline-
delimited progress, so a long read reports the repository it is currently
reading out of the known total instead of appearing frozen.

Commits are evidence of activity rather than unlimited direct XP. Empty and
generated-only commits award no XP. Active days and work sessions are capped;
merged pull requests, releases, linked issues, and successful CI produce stable
one-time events. Repeated scans, webhook deliveries, CI reruns, repository
renames, and other duplicate deliveries must be deduplicated by stable event
IDs.

The GitHub source screen makes this ledger legible: it explains the reward map,
shows recent verified receipts with their category and XP value, and reports the
number of newly applied events after each sync. A repeated sync may receive an
already-known event from the provider, but it must report zero new events and
leave the companion XP unchanged.

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
access, and delete synced derived data, and these are deliberately different
controls. **Disconnect GitHub** (`DELETE /api/github/repositories`) removes the
stored OAuth token and every sync checkpoint so no future activity can be
tracked; it keeps earned XP, the companion, and the repository selections, so
reconnecting resumes the same sources with a fresh baseline. **Delete synced
data** (`DELETE /api/sync/product`) is the separate destructive control that
removes the synced progression snapshot. Signing out is neither: it only clears
the browser session cookie and leaves the account, token, and XP untouched. A
revoked token, a GitHub outage, a closed tab, or an expired session never
disconnects or deletes anything — it pauses tracking and asks for a reconnect.
GitHub may refresh server-side while the website is closed, but the server
stores derived activity and progression only, never repository contents or code.

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

A signed-in account can hold two different guest identities: the one in this
browser and the one inside the account's cloud snapshot. The product route
refuses such an upload with `409` rather than letting one browser silently
overwrite an account's snapshot. That refusal is surfaced as an explicit
choice on the GitHub panel, with both copies shown (events, companions, XP,
and created date) before anything changes:

- **Keep both** (recommended) adopts the account's guest identity locally,
  keeps the browser's ledger, XP, and collection, and uploads the combined
  copy; the server merges the two event sets without double-counting.
- **Use this browser** deletes the account's cloud snapshot and replaces it
  with the browser's copy. This is destructive and requires a two-step
  confirmation naming what is deleted.
- **Use the account** replaces the browser's product state for that account
  with the cloud snapshot, adopts its guest identity, and uploads the result.

Every action reports its outcome in the sync summary, and the choice closes
once an upload succeeds so normal syncing resumes. If the two sides already
share one identity, or one side holds no progression, the same chooser is
shown with copy for that case instead of assuming a conflict.

Destructive controls are separate and explicit. Disconnecting GitHub removes
the stored token and sync checkpoints, stops future tracking, and keeps earned
XP and the repository selections; deleting synced data is a different control
that removes the cloud progression snapshot. Removing a mounted folder stops
future scans but keeps earned XP. Resetting local state clears browser-held progress
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

**Not yet implemented — see [`ROADMAP.md`](ROADMAP.md).** The paragraphs below
describe the intended contract; the shipped code currently buckets days and
sessions in UTC, so a commit made late in the local evening can land on the
previous day for a user east of UTC. This is a known gap, not a shipped
behaviour.

Daily and session caps use one account-level **progress timezone**. It defaults
to the browser timezone when the user starts, does not change automatically
when the user travels, and can be changed explicitly for a future progress day.
Past events are never reclassified after a timezone change. GitHub caps use the
verified activity timestamp, not the user's computer clock; local note events
use the time Terrarium observes the meaningful change and remain unverified.

### 5.1 Prototype rates

These are the first playtest values. They reward evidence of sustained work and
outcomes, not raw volume.

| Event | XP | Rules |
|---|---:|---|
| Qualifying active day | 10 | Once per source per calendar day. |
| Work session | 10 | Maximum two sessions per source per day. |
| New note | 25 | Once per note after the source baseline. Maximum three new notes per source per calendar day. |
| 100 new words | 5 | Count net new body words, not repeated scans. Maximum ten buckets (1,000 words) per day across all mounted folders. |
| New resolved wikilink | 3 | Only when the target exists. Maximum twelve per day across all mounted folders. |
| Merged pull request | 25 | One event per merged PR. |
| Published release | 40 | One event per release. |
| Closed linked issue | 10 | Only when linked to the project or PR. |
| Successful CI on merged PR | 10 | One qualifying success per merged PR. |

**Every category is capped, and so is every day.** The activity categories are
capped because a day is one day. The content categories are capped because a
scan is repeatable: a file can be padded, rescanned, padded again, and each pass
changes the content hash, so "net new words" alone is not a bound. Without
content caps the note source paid without limit while the GitHub source was
capped at 30 XP/day (10 active day + two 10 XP sessions), which made the two
sources incomparable and made padding a file out-earn a month of real commits.

**A global daily budget of 300 XP** applies across every source, per calendar
day. This is the "cross-source diminishing returns or a global soft limit" the
section below has always promised and nothing implemented until now. Per-source
caps alone let each new source bring its own allowance, so six sources meant six
allowances; the budget is what keeps the economy the same shape as sources are
added. It does not bind on today's two sources: notes maxed reach 191, GitHub's
activity ceiling is 30, and both together are 221. It binds the moment a third
source joins, which is exactly the case it exists for. The figure is set to clear
every honest single-source day measured, including a heavy GitHub day of eight
merged pull requests and four green builds (270), because those categories carry
no per-source cap of their own and the budget is the only limit on them. The
budget is pacing, not security, and is not claimed as such: a guest owns their
local state, and only the `verified` side is signed by the server.

The caps are deliberately hardened against the inputs a user controls:

- **The day comes from the scan clock, never from a file.** File modification
  time is settable (`touch -t`, archive extraction, a crafted mount), so
  bucketing by it let a single scan spread its work across a year of days and
  earn a year of allowance at once. A scan is charged to the real day it ran.
- **The allowance is not per folder.** Keying the cap by the mounted folder's
  name meant copying a vault, or renaming it, minted a fresh allowance for
  identical content. Every mounted folder now shares one daily budget.
- **`new-note` is keyed to the note's content, not its path,** so moving or
  renaming a file does not re-earn the bonus for a note that already paid.

These caps apply per **day**, across all mounted folders. Reaching a cap is
visible: the activity log lists the events a cap rejected with zero XP and the
reason.

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

### 5.3 Note maturity history

Maturity (seedling / budding / evergreen) is authored in note frontmatter, not derived. A change
between two **observed** values is recorded as a dated, deduplicated `maturity-changed` event in
the ledger, carrying the path and the `from` / `to` values.

- **A downgrade is recorded too.** The previous behaviour recomputed promotions from the current
  snapshot, so moving a note back to `seedling` silently erased XP that had already been awarded,
  with no record it ever existed. That is the failure this history removes.
- **Only two observed values are compared.** A note's first observation is its starting state, not
  a change; and a scan summary written before this field existed has no observed value at all.
  Both cases emit nothing. Treating a missing value as `seedling` would emit a change for every
  already-evergreen note on the first scan after an upgrade.
- **The timestamp is the scan's trusted clock, never the file's mtime.** mtime is user-settable,
  and this event carries no cap, so an uncapped event's budget day falls back to its timestamp. A
  history whose timestamps are chosen by the thing being audited is not a history.
- **It is worth zero XP today, deliberately.** Promotion XP still comes from the snapshot exactly
  as before. Recording history first makes the existing claim auditable; replaying promotions from
  this log is a separate decision with a migration consequence, and it has not been taken.
- Per section 4.2 the record stores the path and the maturity label only, never note text. A
  maturity word is user-authored metadata from a fixed three-value vocabulary, the same class of
  data as the wikilink targets a scan already keeps.

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

### 6.1 Eggs

A draw produces an **egg**, not a collection entry. The egg is stored, the user
opens it, and the companion joins the collection when it hatches.

- **An unhatched companion is not owned.** It is not in the collection and does not
  count toward the assignment bound in section 6.3, because a companion the user has
  never met cannot be shown on a repository.
- **Hatching preserves identity.** The collection entry is keyed on the same draw id
  the egg was laid with, so anything that referenced the companion before the hatch
  still resolves afterward.
- **A duplicate never becomes an egg.** It was already converted to Essence at draw
  time, so an egg for one would open onto nothing.
- **Opening is one action.** The egg is a button; there is no second confirmation.
- **Motion is optional, the hatch is not.** Under `prefers-reduced-motion` the
  animation does not play, but the sequence still completes and the companion still
  arrives.

### 6.2 Daily draw

One draw is granted for opening the app on a new **local** calendar day.

- The day boundary is the user's own midnight, not UTC. A user east of UTC must not
  see their daily draw reset at an arbitrary hour of their morning.
- The claim is recorded by a `daily:<YYYY-MM-DD>` trigger id in the existing
  processed-trigger list, so a replayed or duplicated claim is a no-op rather than a
  second companion.
- The daily draw is an addition to the activity meter in this section, not a
  replacement for it.
- **A draw prefers what the user does not own.** Entries already in the collection are
  removed from the selection pool while any unowned entry remains, so a daily draw yields
  a companion instead of a duplicate. An owned result is not a re-roll, it is a
  non-event: `isDuplicate` pays only Essence, and Essence is not yet visible or
  spendable, so the day reads to the user as "nothing happened".
- **The pool is recomputed per draw, not per batch.** A single trigger worth two draws
  must not be able to select the same companion twice.
- **Once every entry is owned the pool falls back to the full table.** That fallback is
  the only path by which duplicates, and therefore Essence, stay reachable at all, so it
  is load-bearing rather than defensive.
- **The runway is the catalog size.** With the prototype's twelve entries, a user owning
  only the starter gets twelve productive days (measured: eleven further draws, then the
  collection completes at 12/12). Extending the reward means growing the catalog, not
  changing the rule. Every new entry also needs a measured sprite size; see section 7.

### 6.3 Dressing a repository

A companion can be dressed onto a repository, so it is the creature that repository
carries.

- **The bound is how many companions the user owns.** The interface states the
  collection size, so the number of repositories that can be dressed must equal it.
  Counting distinct species instead would make the displayed number a lie.
- **A companion is spent on exactly one repository.** Sharing one across many would
  make the bound meaningless.
- **A repository carries one companion.** Assigning a second requires taking the
  first back.
- **The rule is enforced on read, not only on write.** The profile is user-writable
  local storage; an invariant enforced only on the write path is decorative.
- **Deferred:** the assigned companion is not yet rendered by the badge or device
  endpoints, which still select a species automatically. The intended end state is
  that they show **the assigned** companion.

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

### 7.1 Per-companion sprites in the collection

A collection tile renders the sprite of the companion it names, resolved from that
companion's current form at the tile's xp.

- **Resolution must be client-safe.** The collection grid is a `'use client'` component,
  and `CreatureSprite` reaches `node:fs` transitively; importing it there fails the entire
  build, not just that page. Tiles therefore resolve through `lib/game/companion-sprite.ts`,
  which depends only on `sprites/pokeapi-pure` (committed JSON plus two URL builders, no
  filesystem and no network) and the catalog's own progression maths.
- **Sprite dimensions are measured, never assumed.** `RemoteSprite` sets explicit
  width/height and DESIGN.md 2.4 permits integer scaling only, so a wrong size distorts
  pixel art rather than nudging layout. The animated sprites run from 37x38 to 102x84; the
  static PNGs are all 96x96, which is why one box can serve both variants.
- **A catalog form without a measured size fails a test** rather than rendering stretched.
- **The form comes from the catalog's own progression resolver**, so a tile cannot
  disagree with the progress panel about which form a companion is in.
- The tile shows the base form at xp 0; passing xp would show the evolved form. The
  per-companion xp lives in the server-side product state this surface does not read.

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

## 11. Interface rules

Each rule below exists because reading the shipped build as a stranger found it broken.

### 11.1 A number names what it counts

Two correct numbers still read as a bug when neither says what it counts. The stage bar
read `50 / 3500 xp` while the ledger below it read `Total 1550 xp`. Both were right:
1,550 total, 1,500 to enter Mossling, so 50 into a 3,500-wide stage. Nothing said the
fraction was XP *within* the stage.

- A progress fraction states the scope of its denominator: `50 of 3,500 xp into Mossling`,
  never `50 / 3500`.
- `aria-valuetext` says what the visible label says, because a screen reader gets one of them.
- A component rendering a fraction takes the stage name as a prop. `XpBar` cannot describe
  a stage it was not told about, and a call site that omits it is a defect, not a default.

### 11.2 A surface says whose garden it shows

`/` renders the site owner's built-in garden; `/companions` renders the viewer's. Signed
out those differ (1,550 xp and Mossling against 0 xp and Sporeling) and sat one click
apart with no label, so one of them looked broken. State whose state. Where the viewer
has nothing yet, say so and name the action that changes it.

### 11.3 Interactive targets are at least 44 px

Measured at 390 px on the shipped build: theme toggle 32x32, hamburger 30x30, brand 24 px
tall, nav rows 32 px, footer links 20 px. Ten targets on one page. The icon may stay
16 px; the hit area may not. Header controls are fixed first because they are reached on
every route.

### 11.4 A filter states its effect

`/graph` is the surface that stops scaling first and it had no way to narrow anything. It
filters by tag and maturity and prints `N of M nodes` while a filter is active, so the
reader does not count to find out what happened. Filtering drops links whose far end was
dropped: lines drawn into nothing read as corrupt data, not as a filter.

### 11.5 One h1, and it is not a creature's name

`/` had no `<h1>`: the outline began at `Mossling`, so the document's subject was a name
inside a card. The tagline carries the h1; the styling stays quiet because DESIGN.md keeps
the creature as the visual focal point. Semantics and visual emphasis may differ.

### 11.6 Detail a stranger did not come for is opt-in

The home page opened with a nine-row XP ledger before saying what the product is. The
ledger remains, first-class, behind a `<details>` whose summary carries the total: no
state, no JavaScript, keyboard-operable.
