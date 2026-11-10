# Roadmap

This is the execution status for the product described in
[`PRODUCT.md`](PRODUCT.md). `DESIGN.md` describes the visual system and
[`PLAN.md`](PLAN.md) contains the implementation plan. The earlier T0-T30 files
remain useful as historical implementation notes, but they are not the current
product contract.

Last reviewed: **2026-09-16**

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

- Terrarium web app with notes, projects, tags, search, and graph.
- Existing snapshot-based garden and GitHub XP engine.
- Four-stage botanical creature UI and item drawer.
- Public creature JSON API and static README badge.
- Browser extension for public GitHub pages.
- Built-in Markdown editor and local File System Access folder mounting.
- GitHub sign-in and derived-state sync foundation.
- GitHub source selection, baseline-aware activity sync, server-issued verified
  event receipts,
  and duplicate-safe reward messaging.
- PokeAPI sprite adapter with local fallback.

### Just verified

- All 36 currently configured default Pokémon sprite IDs returned live animated
  GIF assets.
- The adapter now reads Pokémon and species metadata, including form name,
  default-form state, static/animated asset URLs, and evolution-chain ID.
- Alternate forms with no animation use their static PokeAPI sprite.
- Legacy cache entries refresh once to gain the new metadata, then remain
  cache-first.
- `npm run typecheck` passes.
- New product engine tests pass: 640 tests across 56 files.
- `npm run build` succeeds.

### Living companion, first slice (2026-11-03)

Implemented from `docs-plan/PLAN-living-companion.md`, phases P1 (partly), P2
and P3. The plan itself remains a draft; the parts that shipped are recorded in
`PRODUCT.md` §12 and `DECISIONS.md`.

- **Care core** (`apps/web/src/lib/game/care/`): `needs`, `mood`, `items`,
  `actions`, `scene`, `state`, all pure and client-safe, with 87 tests covering
  the 0/100 boundaries, a clock that goes backwards or runs ahead, corrupt
  timestamps, per-day item caps across a timezone shift, replay safety, the
  inventory maximum, and cross-device merging.
- **Red-team pass**, folded back in as `care/red-team-regressions.test.ts`. Two
  findings mattered: the cupboard was derived from a bounded mint log, so the
  longest-playing users' inventory emptied itself (now a lifetime granted/spent
  counter); and minting was not idempotent past that bound, which turned the
  House's "persist when the minted state changed" effect into a save loop. Also
  fixed: a timezone change could re-mint a day's surplus, one malformed ledger
  record crashed the sort, a future timestamp on one device pinned hunger and
  mood on all of them, and a corrupt care counter discarded the whole profile.
- **Condition in sync**: `care` on the guest profile, `condition` on the product
  snapshot, merged newest-timestamp-per-need (with `startedAt` keeping the
  earlier value). The snapshot also now unions `eggs` and `assignments`, which
  `mergeGuestWithServer` was silently dropping.
- **The House** on `/companions`: the companion, one object per action, a
  day/night window, labelled meters, the cupboard, and this week's activity.
- **Known gaps, stated rather than hidden**: health and cleanliness have no
  producer yet and read "not measured yet"; the room is a flat elevation, not
  the planned 2.5D isometric art; dormancy is implemented as specified but is
  nearly unreachable under the current energy formula (`PRODUCT.md` §12.5).
- **Not attempted**: P1's server-side assignment rendering in
  `/api/creature` / `/api/creature.svg`, per-repo XP routing (D3), and all of
  P4/P5/P6 (Tauri desktop shell, background sync and local git watch, notes
  source v2).

### New product loop shipped

- Companions arrive as **eggs**. A draw used to land straight in the collection and
  announce itself in a panel the user read; it now becomes an egg in an inventory
  that the user opens. Tapping it plays a shake, a crack, and a burst of light in
  the species' colours before the companion appears. The animation is CSS keyframes
  and SVG with no new dependency, and the sequence is driven by timers rather than
  animation events, so a user who prefers reduced motion still ends up with an
  opened egg instead of a stuck one. An **unhatched companion is not in the
  collection**: the collection is what the assignment bound counts, so counting an
  egg would let a user dress a repository with a companion they have never met.
  Hatching moves it in keyed on the same draw id, so its identity is unchanged.
  Duplicates never become eggs, because they were already banked as Essence and an
  egg that opened onto "you already had this" would be a reward that punishes. The
  navbar carries a badge for waiting eggs, because an egg nobody notices is the
  same as no egg (`lib/game/companion-eggs.ts`, `components/game/EggHatch.tsx`).
- A **daily draw** is granted for opening the app on a new local calendar day, so
  growing a collection no longer depends only on a hidden meter that fills from 100
  events. It reuses the existing `advanceEncounter` trigger path rather than adding
  a second draw path, and the day is gated by a `daily:<YYYY-MM-DD>` trigger id in
  the existing `processedTriggerIds`, so the day is its own record of being claimed.
  The boundary is **local**, not UTC (`lib/game/daily-draw.ts`).
- A companion can be **dressed onto a repository**, bounded by how many companions
  the user owns, with each companion spent on exactly one. The bound is
  `collection.length` rather than distinct species, because the activity panel
  already says "N companions" and counting species instead would make that number a
  lie. Enforced on read as well as write, because the profile lives in
  `localStorage`. The picker on `/repos` shows spent companions disabled with the
  repository they are on, rather than hiding them, so the list shrinking as
  repositories are dressed is explained by display instead of by a refusal
  (`lib/game/repo-assignments.ts`, `components/game/CompanionPicker.tsx`).
- **Two things were called "collection".** `/companions` rendered one generated
  creature per GitHub repository under the heading "Garden collection", and a user
  with 24 repositories read 24 tiles as 24 companions they owned. They owned one.
  The generated creatures are a view over where activity came from, not over what
  the user owns, so they moved to `/repos` and `/companions` now shows the actual
  collection, with the active companion settable from that page.
- The mounted-folder source raises its scan in one shared place
  (`lib/garden-fs/scan-dispatch.ts`), and the built-in editor now raises one
  after a save and after a delete. It previously raised none, so a note written
  in `/write` earned nothing until the page was reloaded: the ledger only
  advances on a scan, and the only automatic scan was the one on mount. A user
  watching the counter had every reason to read that as a broken feature.
- `/write` also carries a **Rescan** control in the workspace status strip, for
  a note written in another app (Obsidian, a sync client, a plain editor) while
  the page is open. Activity is detected on read, not on write, and the control
  makes that explicit instead of implying XP arrives live.

- The activity log lists what each companion earned, from which repository or
  folder, and when. It is a read model over the ledger (no new storage), scoped
  per active companion. Rows a daily cap rejected are listed with zero XP and
  the reason, because a log that hides its own exclusions makes a capped day
  look like a broken feature. Repository names are recorded as identifiers on
  GitHub event metadata; note text, titles, and paths remain unrecorded.

- Guest onboarding creates an immediate local starter without authentication.
- The `/write` route now exposes starter selection, recoverability warning, and
  a local activity panel.
- Mounted Markdown scans are recursive, baseline-aware, and emit local,
  idempotent events without uploading note text.
- Per-companion XP, hidden encounter progress, deterministic draws, duplicate
  Essence, and free active-companion switching have provider-neutral contracts.
- The prototype catalog now references real PokeAPI Pikachu → Raichu and Ditto
  assets; animation and static fallback are resolved at the provider boundary.
- A derived-only product snapshot and guest/server merge adapter are ready for
  the account API; the legacy sync endpoint remains backward compatible.
- The extension can consume both the legacy creature payload and the future
  public companion payload with provenance labels.
- The `/github` source screen now explains the XP map and shows recent verified
  receipts. A live smoke test awarded 50 XP from a post-baseline release and
  active-workday event, then kept XP at 50 on a repeated sync.
- The `/github` picker is a searchable repository browser with
  all/individual/organization filters, per-owner grouping, and approved versus
  tracked counts. Tracks come from GitHub's fetched list rather than typed
  names, an organization must be opted into individually, and re-enabling a
  paused repository resets its baseline so paused activity is never awarded
  retroactively.
- Supabase project/schema and server-only adapters now provide a durable hosted
  storage path for Vercel; signed-in GitHub browsers can hydrate blank account
  namespaces from the cloud snapshot; SQLite remains the local/single-server
  fallback. Product snapshots now key by immutable GitHub ID, protect writes
  with optimistic timestamps, and keep restored event IDs replay-safe.
- A bounded GitHub scan that reaches its page ceiling is now reported as
  **truncated** instead of failed, so a long-history repository records its
  baseline and can earn XP. Previously every such repository reported `partial`,
  the baseline was withheld indefinitely, and the account stayed at zero XP no
  matter how often the user synced.
- CI checks are read from merged pull request head and merge commits rather than
  by walking the default branch, removing roughly ninety to two hundred requests
  per repository. GitHub's `403` is now reported as a rate limit rather than as
  revoked access, and an empty repository's `409` is treated as a successful
  empty read.
- `POST /api/github/sync` streams newline-delimited progress, so the `/github`
  surface shows the repository being read out of a known total, a live request
  counter, and a cancel control instead of an indefinite spinner.
- Every tracked repository is reachable. The old ceiling of 25 repositories left
  19 of a 44-repository account permanently unbaselined, so none of their
  activity could ever award XP; the window is now derived from GitHub's hourly
  request budget and the checkpoint's event capacity, and repositories that
  still need a baseline are read first, so the whole set is covered a window at
  a time.
- A large account's sync can commit its baseline again. The signed checkpoint
  rejected more than 500 event IDs at *issuance*, which failed the whole sync
  in-band, and it was delivered in a request header that tens of kilobytes
  cannot fit -- the `/api/sync/product` call that commits the deferred baseline
  came back as a bodyless 500. The checkpoint's event bound is now the sync
  window's own worst case (derived, so the route cannot build a list its own
  validator rejects) and it travels with the snapshot in the request body, still
  HMAC-signed, account-bound, and checked against the stored baseline.
- The `/github` panel offers the documented automatic-sync cadence (manual,
  5, 15, and 30 minutes; 15 is the default) while the page is open, and budgets
  the GitHub requests each cycle actually reported so a cadence that would
  overdraw the account's hourly ceiling pauses with an explanation and resumes
  when the rolling hour window clears.
- `/github` no longer re-lists repositories on every visit. The last successful
  listing is cached in the browser (instant paint on return) and on the server
  per account (five minutes fresh, one hour retention, in-process, keyed by
  GitHub ID and never by token), revalidated on demand with **Refresh list**,
  and labelled with how old it is. Only successful listings are cached, a
  listing that fills the fifth page is stored with a `truncated` flag and never
  treated as complete, a failed read serves the last known list marked `cached ·
  unavailable`, re-authorizing GitHub purges the entry, expired entries are
  swept and the map is capped, and a sync never prunes a repository baseline
  from a listing it could not refresh. The browser copy is bound to its GitHub
  account ID: a copy from another account is discarded, a `401` clears it, and
  a failed read keeps showing only a list the server confirmed for the account
  it answered for. **Disconnect
  GitHub** is now a real control: it removes the token and sync checkpoints,
  keeps earned XP and repository selections, and stays distinct from deleting
  synced data. Signing out, a revoked token, or a GitHub outage never
  disconnects or deletes anything.
- The `/github` panel turns the account's identity-guard `409` into an explicit
  choice instead of a dead end. Both copies are described from their snapshots
  (events, companions, XP, created date) and the user picks **Keep both**
  (adopt the account's guest identity, keep local progress, re-upload),
  **Use this browser** (delete the cloud row and re-upload the browser copy,
  behind a two-step confirmation), or **Use the account** (replace local
  product state with the cloud snapshot and adopt its identity). The guard
  itself is unchanged, and each action reports its outcome in the sync summary.

### Known gaps after the repository cache

- The `If-None-Match` / `304` revalidation fast path is not implemented. The
  server cache entry has room for an ETag, but `fetchGithubRepositories` does
  not return the response ETag yet, so a past-fresh-window refresh still
  re-reads up to five pages instead of one conditional request.
- The server cache is a module-scope `Map`, so it is per instance and is lost
  on restart or cold start; a multi-instance deployment gets one copy each.
  That is the same caveat as the `/api/creature` cache and is a request-budget
  guard rather than a shared cache. Entries are swept on write and capped at
  `GITHUB_REPOSITORY_CACHE_MAX_ENTRIES` accounts.
- Accounts with more than 500 repositories get a truncated listing. The
  `/user/repos` walk stops at five pages; the flag stops pruning and unselection
  from it, but repositories past page 5 still need a narrower listing to become
  trackable.

### Known prototype mismatch

The old `SPECIES_LINES` configuration is a visual progression, not a set of
canonical Pokémon evolution families. For example, its current line combines
Pichu, Pikachu, Electabuzz, and Electivire. This must be replaced by provider
configurations that declare real families and valid evolution paths before the
collection is considered final.

### Companion catalog and per-tile sprites (shipped)

The daily draw was effectively a two-day feature. With two catalog entries, a viewer who
owned both received a duplicate on every later day, and a duplicate pays only Essence,
which the interface does not surface anywhere. Two changes fixed it: the draw now prefers
entries the viewer does not own, and the catalog holds twelve.

Measured over 120 simulated days: a viewer owning only the starter went from a companion on
**32.5%** of days to **100%**, and the runway went from **two days to twelve**. The rule
falls back to the full table once everything is owned, which is what keeps duplicates (and
Essence) reachable at all.

Collection tiles also rendered one shared sprite, the garden stage's sporeling, for every
companion: a card labelled "Pikachu family" showed a grass lizard. The grid is a client
component and the sprite component reaches `node:fs`, so a single server-rendered node had
been threaded through and reused. Tiles now resolve their own companion's sprite through a
client-safe resolver, with each sprite's dimensions measured from the file itself.

### UX review pass (shipped)

The production build read as a signed-out stranger found six defects. All six are fixed;
the rules they produced are in `PRODUCT.md` section 11.

- **Numbers were unattributed.** `50 / 3500 xp` on the stage bar against `Total 1550 xp`
  in the ledger below it. Both correct, neither explained. The bar now reads
  `50 of 3,500 xp into Mossling`, and `XpBar` requires a stage name.
- **Two gardens, one click apart.** `/` showed the owner's garden (1,550 xp, Mossling),
  `/companions` the viewer's (0 xp, Sporeling), neither labelled.
- **No `<h1>` on `/`.** The outline began at the creature's name.
- **Landing page led with a nine-row XP ledger.** Folded behind its own total.
- **Ten tap targets under 44 px** at 390 px: theme toggle, hamburger, brand, nav rows,
  footer links.
- **`/graph` had no filters** on the surface that stops scaling first. Now filters by tag
  and maturity, prints `N of M nodes`, and drops links whose far end was filtered out.

Two regressions are pinned by tests because both fail silently: `components/game/xp-bar.test.ts`
(the label and every call site) and `lib/graph/filter.test.ts` (endpoint resolution still
works after the force engine rewrites ids into objects).

### Calmer UI, phase 1: copy trims (2026-11-04, in review)

Users found the UI overwhelming because of how much text it showed. Phase 1 changes
only wording, with no layout or logic changes. The rules are in `DESIGN.md` section 7.
The plan and the remaining phases are in `docs-plan/PLAN-calmer-ui.md`.

- Page intros cut to one line: `/companions`, `/repos`, `/leaderboard`, `/species`,
  `/preview`, `/progression`, `/notes`.
- `/companions` related pages are a link row instead of links inside a sentence.
- "A new companion arrives each day you visit" now appears once (the companions grid
  empty state), not three times.
- Design rationale removed from the working surfaces: the leaderboard anti-farming
  reasoning, sprite-source details, and the repo-creature versus companion explanation
  repeated three times on `/repos`.
- Empty states and profile notices shortened to what is missing plus one action.

### Calmer UI, phase 2: disclosure patterns (2026-11-04, in review)

- New shared components in `components/ui/`: `InfoDisclosure`, `StatusNote`, and
  `RelatedLinks`, plus `lib/copy.ts` for sentences shared across surfaces.
- The House: meter captions appear only when a need wants attention. The per-need
  rules and the "condition never removes XP" guarantee moved into one "How condition
  works" disclosure. Room objects no longer repeat their action verb, except to say
  "unavailable". The caption logic is a pure module (`care-captions.ts`) with tests.
- `/companions`: the related-pages row and the account-condition notice use the shared
  components.
- `/write` connect screen: the privacy paragraph is down to one line plus a
  "How it works" disclosure. The unsupported-browser and expired-permission messages
  are one line each.

### Calmer UI, phase 3: the GitHub page (2026-11-04, in review)

- The page leads with status: headline, one line, a "What Terrarium reads" disclosure,
  the sync button, the status strip, then the latest sync outcome. The outcome used to
  render below the entire repository list.
- Sync results are a short headline (`Synced 4 repos · +12 events.`) with limits,
  truncation, and the backup outcome under Details. A failed account backup is still
  named in the headline.
- The repository picker is a **Tracked repos** fold (open when nothing is tracked,
  folded otherwise, with unsaved choices flagged on the summary). Automatic sync and
  Disconnect moved into a **Settings** fold.
- The three reassurance captions, the approved-versus-tracked paragraph, the
  auto-include captions, the "Repository sources" line under each owner, and the
  default tile labels (`available`, `public`, `readable`) are gone. Their content is
  in the disclosure or in `/guide#github-sync`.
- Recovery keeps its action and full explanation, now behind Details. The cloud-copy
  chooser and disconnect confirmation keep their full wording.
- The planned `Chip` component was not needed: removing the captions was enough.

### Calmer UI, phase 4: the guide holds the explanations (2026-11-04, in review)

- New `/guide` sections: Condition (a needs table), GitHub sync, Privacy, and
  Leaderboard, plus the daily-companion and repo-dressing rules under Companions.
- An inline contents list on small screens (the sidebar list is desktop-only).
- The House, GitHub, and `/write` disclosures link to their guide section. The
  leaderboard and the unverified-XP note link to theirs.
- `calmer-ui.test.ts` checks that every guide anchor exists and that no `/guide#…`
  link is broken.

### Dressed repositories on GitHub (2026-11-04, in review)

- `/api/creature?repo=` adds a `dressed` object, and `/api/creature.svg?repo=`
  draws the dressed companion (sprite embedded as a PNG data URI), for a public
  repository whose owner opted in. Otherwise both are unchanged.
- New opt-in: *Show dressed companions on GitHub* on `/repos`
  (`/api/profile/repo-badges`, table `repo_badge_display`), with a Copy badge
  button per dressed public repo.
- The extension's page badge and popup show the dressed companion through one
  shared `creatureDisplay` helper.
- Opted-in owners get a five-minute CDN window instead of an hour.
- QA fixes (2026-11-05, `docs-plan/PLAN-dressed-repo-qa-fixes.md`):
  - Dressing pushes itself to the server (`/api/profile/repo-assignments`), and each row shows its state.
  - Signed-out `/repos` offers sign-in and makes no failing requests.
  - The badge footer no longer clips.
  - Timing copy is corrected.
  - The SVG route sends `X-Cache`.
  - A GitHub failure gets the short cache window.
  - Sprite URLs are checked in canonical form.
- Not fixed here: the egg-hatch `setState` warning, which predates this branch (separate PR).
- Known gap, not fixed here: a restored profile's assignments keep the raw
  reference while its collection holds hashed ones (`PRODUCT.md` §6.3).

### Desktop companion, first slice (2026-11-06, in review)

The first part of P4 in `docs-plan/PLAN-living-companion.md` §6, in `apps/desktop/` (Tauri 2). Optional: the core experience still needs no desktop app.

- A transparent, click-through strip docked above the taskbar; the companion walks, sits and sleeps along it. Only the companion and its bubble take clicks.
- Reads the public `/api/creature?user=&repo=` payload, the same one the README badge uses, and picks dressed-vs-automatic through the extension's `creatureDisplay`, so all three agree. Refreshes every ten minutes.
- First run asks for a GitHub username and a repo, kept in the webview's storage. The tray menu offers Open Terrarium, Change companion, Refresh, Quiet mode and Quit.
- Not in this slice: sign-in, background sync (XP with the browser closed), local git-watch reactions, hiding on fullscreen apps, and taskbars on other edges or monitors. Windows only so far.

## Delivery order

| Phase | Goal | Status |
|---|---|---|
| 0 | Product and data contracts | **complete** |
| 1 | Guest onboarding and local profile | **partial, usable on `/write`** |
| 2 | Event ledger and basic XP | **partial, Markdown and GitHub wired; broader surfaces pending** |
| 3 | Companion catalog, forms, and encounters | **partial, engine and PokeAPI bridge shipped** |
| 4 | Recursive Markdown and Obsidian mounting | partial, needs upgrade |
| 5 | GitHub verification and guest sync merge | **partial, Feature A, repository browser, and hosted hardening shipped; Vercel/Supabase deploy verification and profile migration pending** |
| 6 | Collection UI, profiles, extension integration | **partial, extension adapter shipped; surfaces pending** |
| 7 | Licensed marketplace providers and original art | future |

The detailed acceptance criteria for each phase are in [`PLAN.md`](PLAN.md).

## Immediate next work

### 1. Finish persistent local source snapshots

**Done.** The scan's memory of "what did this folder look like last time" lived
in a `useRef`, so closing the tab discarded it, the next visit treated every file
as new, re-baselined, and awarded nothing. A user writing in Obsidian daily and
opening the site occasionally earned XP for almost none of it. It is now
`lib/game/scan-summary-store.ts`: per-file summaries (path, content hash, body
word count, link count, link targets, mtime) persisted per folder, with the oldest
folders evicted past eight and a corrupt entry degrading to a re-baseline rather
than a broken page. The raw note boundary is unchanged: a hash says a note
changed and nothing about what it now says.

`normalizeMarkdownEvents` now takes summaries for its `previous` side, so the
normalizer cannot read an old note's text even in principle.

### 2. Verify hosted GitHub persistence and ledger checkpoints

The GitHub source now has repository selection, encrypted server credentials,
stable-ID baselines, attributed commit evidence, a `/github` sync surface, and
server-issued verified event receipts. Supabase storage, immutable account
keys, optimistic writes, and replay-safe product IDs are now implemented.
Deploy and exercise OAuth, repository selection, baselines, XP, cloud restore,
a second device, account rename, revoked access, and a redeploy before calling
the hosted path production-ready.

The progress timezone described in [`PRODUCT.md`](PRODUCT.md) section 5 is **not
implemented**: days and sessions are currently bucketed in UTC, so a commit made
late in the local evening can land on the previous day for a user east of UTC.
The sync window is also bounded by page ceilings, so only the newest page of each
activity list is read; the sync reports this as truncation rather than claiming a
complete catch-up. Repository pagination beyond the collection cap, and a first
real Vercel plus Supabase deployment verification, remain open.

### 3. Complete public profile privacy and account lifecycle

Gate `/u/[handle]`, leaderboard rows, and extension payloads behind the existing
opt-in visibility policy.

**Partially shipped:** `/u/[handle]` and the leaderboard rows are now gated by a
persisted per-account visibility choice (`profile-visibility-store.ts`, keyed by
immutable GitHub id, default PRIVATE). The owner can toggle it via
`GET`/`PUT /api/profile/visibility`, and a hidden profile reveals nothing — not
the creature, not the counts. Still to do: gate the extension payload, add a
visibility control to the account surface, and add explicit disconnect,
cloud-delete, guest export, and account-switch flows before exposing public
companion state widely.

### 4. Replace legacy collection surfaces

**Partially shipped.** `/companions` now shows the user's actual collection rather
than one generated creature per repository, and `/repos` carries the generated
repository and cluster archive under its own name. The active companion is settable
from `/companions`.

`/repos` also lists those two generated kinds as **two labelled sections** rather than
one grid. It previously rendered both collections merged, clusters first, so a
tag-cluster card appeared directly beneath the dress control's "No tracked
repositories yet" message. Both statements were true -- no repository was tracked, and
the tag did reach the cluster threshold -- but nothing on the page said the card was a
cluster rather than a repository, and the tile's own line omitted the member count, so
it gave no reason for existing. Each section now carries its own heading, blurb and
empty state, and a cluster tile states `Cluster of <n> notes`: the number that earned
it, and the same threshold the page copy describes.

**Open, and deliberately deferred by the owner:** a repository's assigned companion
is **stored but not yet rendered**. `/api/creature` and `/api/creature.svg` still
select a species line automatically from the repository's language and ignore the
assignment. Wiring it is not a one-line change, and the reasons are worth writing
down so the next attempt does not rediscover them:

- **Two art systems that never meet.** A catalog companion (Pikachu, Ditto) carries
  PokeAPI asset keys on its forms (`pokeapi:pokemon:pikachu:25`); a species line
  (grass, ember, …) resolves through `CreatureSprite(speciesLineId)`. The badge and
  OLED renderers consume the second and cannot currently draw the first.
- **The public endpoints are cached per `user/repo`** with no notion of whose
  assignment is being read, so injecting a per-user choice into that cache would
  serve one person's companion to another.
- **Assignments live in browser `localStorage`.** An edge device or OLED has no
  `localStorage` and would have to read them from the server.
- **`PRODUCT.md` makes public companion visibility opt-in**, and gating the
  extension payload behind that policy is already an open item in section 3. Exposing
  an assigned companion publicly must go through that gate rather than around it.

The owner's decision on the deferred work: the device shows **the assigned**
companion, not a fallback. Until the wiring lands, the automatic species choice is
what the badge and any device will show.


The account archive now reads the trusted product-sync snapshot when one exists,
keeps synced XP separate from the local garden/cache archive, and reports an
explicit not-synced state instead of displaying the global legacy GitHub cache
as account progress. The remaining migration is the full provider-neutral
collection and sprite presentation: add a quiet encounter meter, persisted
weighted draws, duplicate conversion, one active companion, free switching,
and per-companion XP to the legacy collection surface. Test refreshes, repeated
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
npm run typecheck
npm test
npm run build
```
