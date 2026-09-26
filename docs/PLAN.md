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
- one account-level progress timezone with future-effective changes and no
  retroactive event reassignment;
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
- progressive browser support: persistent folder mounting where available, and
  local one-time directory selection or drag-and-drop scanning elsewhere;
- baseline-aware net word, note, and resolved-link events;
- safe rename and delete behavior;
- conservative identity matching that avoids duplicate new-note rewards;
- no note-content upload.

The website scans while open or on demand. A persistent folder handle is a
progressive enhancement; one-time directory selection or drag-and-drop scanning
must remain available where that API is unsupported. Monitoring a closed
browser is out of scope for this phase.

**Status: partial — verified event normalization, GitHub OAuth credential storage, repository selection, the first activity-sync slice, the Supabase durable-store adapter, and cloud product hydration are implemented; production deployment verification and broader account/profile migration remain.**

## Phase 5. GitHub identity and sync

**Depends on:** Phases 1 and 2.

Add optional GitHub sign-in and derived-state sync:

### Feature A slice currently implemented

- GitHub OAuth is scope-free: `/api/auth/login` sends only `client_id`,
  `state`, and `redirect_uri`, and identity comes back from `GET /user`.
  Repository discovery is bounded by the GitHub App's fine-grained read
  permissions and by where the app is installed rather than by an OAuth scope,
  and the classic `repo` scope is deliberately never requested. The explicit
  install/permission-request flow remains open work;
- the OAuth token is encrypted in the server-side account store and never
  placed in the browser session cookie or API response;
- `/github` lists the repositories GitHub makes available in a searchable
  browser with all/individual/organization filters and per-owner grouping,
  keeps approved and tracked state distinct, and supports explicit selection
  plus automatic inclusion for future personal repositories or selected
  organizations. Re-enabling a repository that was untracked or excluded
  clears its baseline, so activity from the paused window is never awarded
  retroactively;
- `/api/github/sync` reads only tracked, non-archived repositories, records a
  first-use baseline per stable repository ID, filters old activity, and
  returns verified provider-neutral events for the active companion; manual
  exclusions override automatic personal/organization inclusion;
- commit evidence, merged pull requests, releases, and successful CI are
  connected to the event normalizer; attribution is filtered at the GitHub
  boundary and the existing account-wide caps/deduplication remain in force;
- sync fan-out is bounded per request, partial reads do not create a new
  baseline, and a signed deferred checkpoint advances the GitHub baseline only
  after the derived product condition is stored; failed receipt, checkpoint,
  or product writes leave the prior checkpoint intact. Linked-issue timeline
  extraction remains a follow-up.

The current prototype expects a GitHub App registration with fine-grained read
permissions for metadata, contents, pull requests, issues, checks/actions, and
the required organization approval. It deliberately does not request the
classic `repo` scope, which grants broader write-capable access. Before
production, keep `SUPABASE_URL` and the server-only `SUPABASE_SECRET_KEY` in the
deployment secret store and apply all three
`supabase/migrations/20260914000000_initial_sync.sql`,
`supabase/migrations/20260914000001_harden_product_identity.sql`, and
`supabase/migrations/20260918000000_github_accounts_disconnect.sql`. The
migrations enable RLS and grant access only to the server role.

The Supabase adapter covers the public sync snapshot, GitHub account/settings,
and product snapshot stores. The browser restores a blank account namespace
from the cloud snapshot and merges same-guest local/cloud history while keeping
source identities local. Product snapshots use immutable GitHub IDs, optimistic
write checkpoints, server-issued GitHub event receipts, and replay-safe event
IDs. The local SQLite adapter remains suitable for the persistent home-server
path and local development, but not for a multi-instance/serverless
deployment. Remaining hosted work includes public-profile visibility
enforcement, SQLite-to-Supabase migration for existing users, and a
restart/redeploy end-to-end test.

- GitHub OAuth identifies the user and protects recovery;
- selected public and private GitHub events are server-verified;
- attribute GitHub XP to the connected user and explicitly linked AI identities,
  excluding teammates and unrelated bots;
- deduplicate co-authored commits and tie CI rewards to eligible
  user-attributed commits or pull requests;
- repository access comes from an explicit picker, with opt-in automatic
  inclusion for future personal repositories or selected organizations;
- explain approved-versus-tracked repository state before authorization and in
  source settings;
- use quiet, state-change-only reminders for untracked new repositories and
  revoked permissions, with dismissal persistence;
- support one active GitHub account per Terrarium profile, archiving previous
  accounts with preserved owner history and fresh baselines on switch;
- preserve repository continuity by stable GitHub repository ID across renames,
  pause after lost access or transfer, and preserve XP after archive/deletion;
- support bounded GitHub catch-up from the approval/baseline checkpoint, apply
  caps by activity date, summarize return updates, and never guess unavailable
  history;
- newly discovered repositories begin at a fresh baseline and never award
  retroactive XP;
- local note events remain labelled local/unverified;
- sync payloads reject note contents and detailed local-note telemetry at the
  schema boundary;
- local-note sync is opt-in and uploads only a private condition snapshot and
  sync checkpoint;
- support manual sync or scheduled scan-then-sync while the website is open,
  with a 15-minute default interval and 5-minute/30-minute alternatives; the
  GitHub source implements this schedule today (browser-local cadence, timer
  only while the page is open, paused by a rolling hourly request budget);
- skip scheduled cloud writes when a scan produces no relevant derived changes
  (local-note cloud sync only; GitHub cycles are a full activity read);
- make clear that a closed browser cannot scan or sync a mounted folder;
- first sign-in imports the current companion condition when no server state
  exists;
- GitHub state merges by event ID, while local-note condition reconciles by
  checkpoint without double-counting;
- irreversible progression merges automatically, while mutable preference
  conflicts offer a local-versus-cloud choice;
- companion XP remains per companion after merge;
- separate disconnect, source removal, local reset, and cloud deletion controls
  with an export-before-delete safeguard;
- account deletion hides public state and stops integrations immediately, then
  permanently purges cloud profile, companion, sync, and GitHub-token data after
  a recoverable 30-day period without touching local notes;
- early first evolution, slower later evolution, and more frequent encounters;
- shared XP evolution curve across companion families;
- server state becomes authoritative after a completed merge.

Do not make sign-in a prerequisite for using the editor, mounting notes, or
earning local XP.

**Status: partial — `/write` onboarding/activity and extension payload compatibility are shipped; public collection/profile migration remains.**

## Phase 5.1. GitHub receipt recovery and checkpoint repair

**Status: implementation complete; hosted replay verification remains deployment work.**

This is a recovery plan for the long-running case where GitHub activity appears
in the browser but account XP and the last checkpoint do not move. It must be
completed without clearing browser storage, disconnecting GitHub, deleting the
cloud snapshot, or silently downgrading verified GitHub events to local events.

### Confirmed incident evidence

Observed on the signed-in `ardhiqii` browser session at
`terrarium-aufa.vercel.app`:

- GitHub access is healthy: **45 of 48 repositories** are tracked.
- The browser ledger contains **38 verified GitHub events**, including events
  from 23/09/2026, and 38 stored receipts.
- The account API still reports `lastSyncedAt` on **18/09/2026**.
- `GET /api/sync/product` returns a cloud snapshot with **0 events and 0 XP**.
- The browser's retained diagnostic response records HTTP 400 with **four
  `receipt-mismatch` events**.

The checkpoint is the last successful server-side commit, not the number of
sync button presses. The product route rejects the whole snapshot when one
verified event has an invalid receipt; the signed GitHub checkpoint is advanced
only after that product write succeeds. Therefore the current flow is:

```text
GitHub scan succeeds
  -> events and receipts are kept locally
  -> one legacy receipt fails product validation
  -> whole product upload is rejected
  -> checkpoint stays at 18/09
  -> cloud snapshot stays at 0 XP
```

The original mismatch came from the old product-snapshot round trip: opaque cap
keys could be hashed twice and receipt-bound metadata hashes could be dropped.
The stable round-trip fix prevents new mismatches, but it does not repair the
already-stored browser events whose old receipts are now incompatible.

### Recovery design

1. **Capture the failure without mutating state.**
   - Record the `/api/github/sync` response, checkpoint token metadata, product
     upload status, bounded receipt-failure IDs, and payload digests.
   - Never clear `terrarium:guest-event-ledger:*`, proof storage, encounters,
     or the account snapshot as a diagnostic shortcut.
   - Confirm whether the user is on the Vercel deployment or the GHCR-backed
     custom domain; deploy and verify the same host the user actually opens.

2. **Add a server-authoritative receipt repair path.**
   - `POST /api/github/repair` accepts only a bounded list of failed stable
     event IDs, the active companion, and either the short-lived signed checkpoint
     that originally named those IDs or a preserved old server receipt; it never
     accepts client-supplied event facts or XP totals.
   - Re-read and re-normalize the matching activity from GitHub using the
     account's token, attribution rules, repository ownership, and current
     canonical snapshot payload.
   - Mint fresh server receipts for events that GitHub independently confirms.
   - Preserve the original event ID, activity timestamp, cap, active-companion
     ownership, and deduplication identity.
   - Refuse events that cannot be recovered; never convert a failed GitHub event
     into `local` provenance merely to make the upload pass. The repair scan uses
     the same server-approved, 16-repository window as normal sync and reports
     events outside that window as blocked.

3. **Replay the preserved local condition and checkpoint.**
   - Persist the exact product snapshot, signed checkpoint, bounded failure IDs,
     and payload digests in the account namespace before upload.
   - Replace only repaired receipt values in the browser ledger; retain every
     other local event and encounter.
   - Rebuild the product snapshot and retry the existing signed checkpoint.
   - Commit the checkpoint only after the repaired product snapshot is stored.
   - Keep optimistic row-version and baseline guards active so a stale repair
     cannot overwrite newer account progress. A blocked projection may upload
     unrelated valid events without a checkpoint, but the full browser ledger
     remains local and retryable.

4. **Make the failure visible and recoverable.**
   - Show the number of blocked receipts and a repair/retry action instead of a
     generic “cloud condition was not saved” message.
   - Distinguish “new GitHub activity found locally” from “account backup
     committed successfully.”
   - Show the last successful checkpoint separately from the last attempted sync.

5. **Deploy and verify the correct runtime.**
   - Deploy the repaired client and server routes to the host used by the user.
   - Apply and verify all three Supabase migrations before authenticated replay:
     `20260914000000_initial_sync.sql`,
     `20260914000001_harden_product_identity.sql`, and
     `20260918000000_github_accounts_disconnect.sql`.
   - Verify the GHCR-backed production image and the Vercel deployment are not
     being confused; the previous GHCR workflow does not by itself update the
     Vercel project.

### Required regression coverage

- Repair succeeds for an old cap/metadata receipt mismatch without losing the
  local ledger or encounter state.
- A repair cannot mint a receipt for invented activity, an unowned repository,
  another GitHub account, or a client-modified XP value.
- A mixed batch of repaired and new events stores once, advances the checkpoint
  once, and does not double-award XP on replay.
- An unrecoverable event remains visible as blocked and cannot poison unrelated
  valid progress forever.
- Stale checkpoint, guest identity, row-version, concurrent-device, empty
  ledger, zero-event, and 16-repository scan cases remain safe.
- Client-bundle safety continues to exclude receipt secrets and Node-only trust
  code from client components.

### Acceptance criteria

This incident is resolved only when all of the following are true:

1. Existing browser storage remains intact; no GitHub disconnect or cloud reset
   is required.
2. The preserved local events can be repaired or are explicitly reported as
   unrecoverable with no silent deletion.
3. `POST /api/sync/product` returns success for the repaired snapshot and the
   signed checkpoint advances beyond 18/09/2026.
4. `GET /api/sync/product` contains the preserved verified events and a
   server-recomputed non-zero XP total.
5. `/companions` shows the same persisted progression after reload and on a
   second device/session.
6. Repeating Sync does not duplicate events or XP, and a forged receipt remains
   rejected.
7. `npm run typecheck`, `npm test`, `npm run build`, `npx vitest run apps/web/src/app/api/github/repair/route.test.ts apps/web/src/app/api/sync/product/github-sync-roundtrip.test.ts`,
   the scoped repair tests,
   production deployment checks, and the Supabase migration verification all
   pass.

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
