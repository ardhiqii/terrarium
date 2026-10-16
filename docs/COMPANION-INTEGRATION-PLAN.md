# Companion Integration Plan

**Status:** T0–T8 implementation, red-team remediation, and final gates are
complete; PR delivery remains. The feature work is on `feat/companions`, with
changes intentionally uncommitted until the final staged review.

**Plan review:** Re-audited against the repository code, `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, `PLAN.md`, `ROADMAP.md`, `DECISIONS.md`, and the integrated runtime. T7 reconciled the starter, authority, activation, and migration contracts.

**T0 artifact:** `docs/COMPANION-MIGRATION-FIXTURE.md` contains the exact fixture, arithmetic, ownership rules, retry behavior, and required assertions. T1/T2 must implement that contract; they must not invent a second migration algorithm.

**Purpose:** Make companion identity, active selection, XP, progression, collection, images, storage, sync, and page presentation consistent without losing data or creating a second XP system.

This document is self-contained for future sessions and delegated agents.

---

## 1. Authority and scope

The repository already contains a partially shipped product engine. This task is an **integration and migration task**, not a rewrite of every source or sync feature.

### 1.1 State authority by surface

| Surface | Authoritative companion state | Allowed fallback |
|---|---|---|
| `/` as guest | Hydrated browser `ProductState` | Server loading shell; legacy garden data may be shown as evidence only |
| `/` signed in | Account product state after account hydration | Explicit loading/not-synced state; never silently use global legacy cache as account XP |
| `/companions` as guest | Hydrated browser `ProductState` | Starter/loading state |
| `/companions` signed in | Trusted account product snapshot | Explicit `not synced` or `unavailable` state |
| `/write` | Shared guest/account browser runtime | Clear storage-error state |
| `/github` | Shared account-aware runtime and verified sync state | Existing recovery and retry states |

`CreatureState` and the legacy `github-cache.json` remain useful for garden evidence and one-time migration input. They must not continue rendering a competing companion identity or competing account XP bar after integration.

The shared client runtime must not import server-only filesystem or path code. Server-rendered pages must handle local-storage hydration without hydration mismatch.

### 1.2 In scope

- Random base-stage starter selection for new profiles.
- One active companion at a time.
- All **qualifying** new source XP assigned to the active companion.
- Existing Pikachu + legacy Mossling migration for the current profile.
- Shared active-companion projection on `/` and `/companions`.
- Image rendering for active and owned companions.
- Activation controls on `/companions`.
- Collection count and roster correctness.
- Browser, account, snapshot, and migration safety.
- Tests and required product/design/decision/testing documentation.

### 1.3 Explicitly not silently changed

- No automatic upload of note contents.
- No AI quality score.
- No paid random rolls.
- No direct `main` changes.
- No removal of existing receipt, checkpoint, recovery, privacy, or server trust boundaries.
- No live PokeAPI calls from unit tests.
- No generic legacy collection data presented as account-owned product companions without an adapter.
- Unverified local encounter draws, Essence, and encounter-only collection references are not imported into an account snapshot; the server cannot prove them without note contents. The browser/account conflict UI states this boundary explicitly.

---

## 2. Locked product behavior

### 2.1 New users

A new user receives exactly one random companion **family**, at its base form.

- The random choice is limited to explicitly starter-eligible base-stage definitions.
- The choice is persisted immediately.
- Refreshing, navigating, or reopening the page never rerolls it.
- The selected starter is active automatically.
- The starter begins with `0 XP`.
- Random selection is per profile, not global.
- Mossling is not the universal starter.

Example:

```text
User A -> Grass family, base form
User B -> Pikachu family, base form
User C -> Ditto family, base form
```

A Grass-family starter may later reach the `Mossling` form through XP progression. A new user must not start directly at an evolved or mastery form.

The integrated docs now describe the confirmed behavior: the new joiner flow is
automatic random base-stage assignment. Existing profiles may receive the
versioned legacy migration; they do not share that credit with new profiles.

### 2.2 Current existing profile

The current profile must preserve both existing collection members:

```text
Collection:
- Pikachu
- Mossling

Active companion:
- Mossling
```

This is a migration result for an existing profile, not a global default. The migration must derive a legacy companion from the existing legacy state and must not hardcode Mossling for every user.

### 2.3 Active companion and XP

- A profile may own many companions.
- Exactly one companion is active.
- Only the active companion receives newly accepted source XP.
- New source events must capture the active companion ID at event creation time.
- Switching changes the destination for future XP.
- Switching must not delete earned progression.
- A newly encountered companion starts at `0 XP`.

“Source XP” means XP from qualifying normalized events. Raw signals such as arbitrary tag counts, backlinks, unchanged saves, reading, or an unchanged scan must not be silently converted into new XP merely because they are visible on the garden page. Existing event-category rules remain authoritative; signals may influence encounter weighting or evidence presentation.

### 2.4 Existing-data migration rule

The old main-page aggregate and the product event ledger are different representations. The migration must never calculate progression by blindly adding rendered values such as `50 + 800`.

T0 must produce the exact migration fixture and algorithm before implementation begins. The algorithm must:

1. Preserve all valid collection membership.
2. Add the derived legacy Grass/Mossling companion with a stable migration reference when it is absent.
3. Make the legacy companion active for the current fixture.
4. Reconcile accepted source evidence exactly once.
5. Preserve stable event IDs, proofs, baselines, checkpoints, and trusted ownership wherever the existing contract requires it.
6. Rebind old events only when they are demonstrably legacy default ownership; never silently move a deliberately user-selected companion's history.
7. Use a stable migration namespace/version so retrying migration is safe.
8. Preserve the pre-migration state for recovery if migration fails partway.

The resulting fixture must have one canonical active-companion projection and no duplicate XP. The exact numeric result is a T0 exit criterion and must be recorded in a test fixture, not invented independently by UI agents.

### 2.5 Progression and bars

Both main and Companions surfaces use the same active-companion projection.

The UI must distinguish:

```text
Total XP: 1,550
Progress to next form: 50 / 3,500 XP
```

The progress bar is XP inside the current progression step. It is not total XP.

Encounter progress is separate:

```text
Encounter progress: 61 / 100
```

It means progress toward discovering another companion, not evolution XP. It must never become a second ambiguous level bar.

### 2.6 Collection and activation

The product collection is the user's owned companion roster, including duplicate encounter references according to the existing Essence contract. The UI may group duplicate references by family, but it must not discard their ownership or Essence meaning.

The Companions page should use archive/specimen presentation rather than generic dashboard cards:

```text
Your companions

Mossling image     Mossling     Active
Pikachu image      Pikachu      Activate
```

- Active state is visually obvious.
- Inactive owned companions have an `Activate` button.
- The active companion does not need an Activate button.
- Activation happens on `/companions`.
- Main page displays the active companion and links to management.
- The old `Garden collection: 0` message must not appear when a starter or migrated companion exists.
- Legacy repository/tag entries remain a separate archive only until they are explicitly adapted into product-owned companion references.

---

## 3. Canonical catalog and asset mapping

T0 must freeze these IDs before T1 edits the catalog. The following is the proposed canonical mapping for the existing legacy Grass line:

| Stable family | Display family | Legacy line | Form | Provider entity | Provider ID/form | Threshold |
|---|---|---|---|---|---|---:|
| `grass-family` | Mossling family | `grass` | Sporeling | Bulbasaur | PokeAPI `1` | `0` |
| `grass-family` | Mossling family | `grass` | Mossling | Ivysaur | PokeAPI `2` | `1500` |
| `grass-family` | Mossling family | `grass` | Bracken | Venusaur | PokeAPI `3` | `5000` |
| `grass-family` | Mossling family | `grass` | Heartwood/mastery | Mega Venusaur | PokeAPI `10033` | `12000` |

The IDs must be verified against the existing sprite/species tests and cache. `Heartwood` is a static mastery form because the animated ceiling does not apply to Mega forms.

The unified catalog version must use one shared progression curve for all families, with each family stopping at its final valid form. The current prototype Pikachu `0/100` progression must not remain as a second incompatible curve on integrated surfaces. If a family has only one or two valid forms, its final valid form is the last step in that shared curve.

PokeAPI remains prototype-only. Provider references are opaque to the game rules, and future licensed artist manifests must be able to replace them.

The asset layer must expose a serializable descriptor to client components. The client must not import server-only cache/filesystem modules.

---

## 4. Current implementation gap

The original split paths have been integrated:

1. `/` uses the account product projection when signed in and the shared guest
   runtime otherwise; legacy garden counters remain evidence/item input only.
2. `/companions` renders the owned product roster, provider assets, progression,
   encounter progress, and activation controls.
3. `/write` and the GitHub source panel use the same product domain rules,
   with account namespace and server activation safeguards kept at their
   existing boundaries.
4. The catalog includes canonical Grass/Mossling, Pikachu, and Ditto families;
   fallbacks use injected starter selection rather than first-catalog order.
5. Account hydration never substitutes a global legacy cache or guest storage for
   a missing account product row; stale account-local verified events are not
   rendered as trusted before server reconciliation.
6. Editor mutations rescan through the same local event path as mounted-folder
   reads, and mounted sources use a persisted opaque identity rather than their
   display name.
7. Bounded GitHub activity reads fail closed as retryable incomplete windows;
   they do not advance a baseline or mint a checkpoint until the window is
   complete. Closed linked issues are proven through GitHub timeline references.

Implementation and red-team validation are complete. Remaining work is the
final gates, branch/PR delivery, and recording the browser smoke results.

---

## 5. Task graph and dependencies

Agents must not edit another task's owned files in parallel.

```text
T0  Migration + authority contract (lead, serial)
 |
 v
T1  Domain model, catalog, starter selector, migration
 |
 +---------------------+
 |                     |
 v                     v
T2  Persistence/sync   T3  Asset descriptors/renderers
 |                     |
 +----------+----------+
            v
T4  Shared browser runtime + source attribution
            |
      +-----+-----+
      |           |
      v           v
T5  Main page   T6  Companions page/collection
      +-----+-----+
            v
T7  Docs + browser acceptance contract
            |
            v
T8  Red-team review
            |
            v
Lead fixes findings, runs final gates, opens/merges one PR
```

Parallel work is allowed only after the dependency interface is frozen:

- T2 and T3 may run in parallel after T1.
- T5 and T6 may run in parallel after T4.
- T7 waits for the final behavior and owns all documentation changes.
- T8 is serial after the complete diff exists.

---

## 6. Agent tasks and file ownership

### T0 — Migration and authority contract

**Owner:** Lead, serial before parallel implementation.

Produce a written fixture and decision artifact before T1 begins. It must specify:

```text
Before:
- legacy family/line and current form
- legacy total and breakdown metadata
- product profile collection
- product active ID
- product ledger event IDs, owners, provenance, and accepted XP
- encounter state
- snapshot/checkpoint/proof state

After:
- collection references
- active ID
- per-companion XP
- event ownership
- migration version
- exact expected projection
- retry/partial-failure behavior
```

The fixture must cover the current case: legacy Mossling plus product Pikachu, resulting in Pikachu + Mossling with Mossling active.

No implementation agent is allowed to invent a different migration algorithm.

### T1 — Domain model, catalog, starter selector, and migration

**Owner:** Agent A

**Owns:**

- `apps/web/src/lib/game/companion-catalog.ts`
- `apps/web/src/lib/game/product-state.ts`
- `apps/web/src/lib/game/guest-profile.ts`
- `apps/web/src/lib/game/events.ts` if the event contract changes
- `apps/web/src/lib/game/stages.ts` if the shared curve changes
- new `apps/web/src/lib/game/companion-migration.ts`
- model/catalog/migration tests

**Work:**

- Add explicit starter eligibility.
- Add the canonical Grass/Mossling family and provider forms.
- Freeze catalog version and shared progression thresholds.
- Add injected deterministic starter selection.
- Filter random starters to base forms only.
- Persist and validate active membership.
- Remove all first-catalog-item assumptions from the pure domain layer.
- Implement the T0 migration contract idempotently.
- Preserve duplicate encounter/Essence semantics.
- Keep switching safe and preserve existing history according to the migration contract.

**Required tests:**

- starter filtering and injected RNG
- no reroll after persistence
- active ID must be owned
- switch behavior and future ownership
- exact migration fixture
- migration retry/partial-failure behavior
- duplicate encounter to Essence behavior
- progression boundary and invalid-number behavior

### T2 — Storage, snapshots, sync, and recovery

**Owner:** Agent B

**Depends on:** T1

**Owns:**

- `apps/web/src/lib/game/product-browser-storage.ts`
- `apps/web/src/lib/sync/product-snapshot.ts`
- `apps/web/src/lib/sync/trusted-product-snapshot.ts`
- `apps/web/src/lib/sync/product-store.ts`
- `apps/web/src/lib/game/github-repair-projection.ts`
- `apps/web/src/lib/game/github-legacy-event-migration.ts` if required
- `apps/web/src/app/api/sync/product/route.ts`
- `apps/web/src/app/api/github/sync/route.ts`
- `apps/web/src/app/api/github/repair/route.ts`
- all related sync/recovery tests

**Work:**

- Persist starter, active selection, catalog/migration version, and recovery state.
- Add snapshot up-conversion and validation for the new family.
- Remove order-dependent catalog fallbacks.
- Validate that a catalog-valid active ID is also owned by the profile.
- Preserve guest/account namespace isolation.
- Preserve trusted collection union during merge; keep unverified encounter
  rewards device-local instead of minting account ownership.
- Preserve optimistic version and immutable GitHub account identity rules.
- Preserve server receipt, proof, checkpoint, blocked-event, and repair behavior.
- Keep `storage_unavailable` distinct from an empty account.
- Keep note contents and detailed local telemetry out of sync payloads.

**Required tests:**

- forged snapshot and catalog-valid-but-unowned IDs
- stale version/optimistic conflict
- immutable account identity conflict
- repair replay and blocked receipts
- storage outage
- guest/account namespace isolation
- cloud restore and migration retry
- repeated sync does not award XP twice

### T3 — Asset descriptors and safe renderers

**Owner:** Agent C

**Depends on:** T1

**Owns:**

- new pure companion asset descriptor module
- new `apps/web/src/components/game/CompanionSprite.tsx`
- `apps/web/src/lib/game/pokemon-provider.ts` if required
- sprite/provider tests

**Work:**

Create separate pure descriptor, server-resolution, and client-rendering boundaries where necessary. Do not force the existing async server `CreatureSprite` directly into a client bundle.

Support:

- current progression form
- Grass/Mossling mapping
- Pikachu mapping
- animated sprite preference
- static fallback
- local fallback
- accessible labels
- integer pixel scaling
- reduced-motion behavior

**Required tests:**

- correct entity/form IDs
- animation preference
- static fallback
- local fallback
- animated ceiling `<= 649`
- Heartwood/Mega static exception
- stale cache refresh behavior
- no live network in tests
- client-bundle safety

### T4 — Shared browser runtime and source attribution

**Owner:** Agent D

**Depends on:** T1 and T2

**Owns:**

- new `apps/web/src/components/game/CompanionRuntimeProvider.tsx`
- new companion runtime hook/context files
- `apps/web/src/components/game/GuestProductRuntime.tsx`
- `apps/web/src/components/game/GitHubSourcePanel.tsx`
- `apps/web/src/components/game/GuestCompanionOnboarding.tsx`
- `apps/web/src/components/game/ProductActivityPanel.tsx`
- `apps/web/src/components/game/CompanionSwitcher.tsx`
- `apps/web/src/components/game/EncounterReveal.tsx` if activation/reveal wiring changes
- `apps/web/src/lib/game/markdown-events.ts`
- `apps/web/src/components/garden/ConnectGarden.tsx` if scan event wiring changes
- source attribution/runtime tests

**Work:**

Create one shared runtime boundary for:

- profile hydration
- guest/account namespace selection
- event ledger and encounter loading
- migration invocation
- active switching
- cross-tab/page notifications
- source event attribution
- local/cloud authority selection
- loading, unavailable, and storage-error states

Replace onboarding's manual/default-first-catalog behavior with automatic random base-stage assignment, unless T0 explicitly records a compatibility path for an already-created profile.

Tags, backlinks, unchanged saves, and raw garden metrics must not be turned into XP events unless the existing normalized event contract explicitly allows them.

**Required tests:**

- guest hydration
- account hydration
- migration event
- cross-tab active update
- activation persistence
- source event receives current active ID
- repeated mounted-folder scan
- offline/storage failure behavior

### T5 — Main page projection

**Owner:** Agent E

**Depends on:** T3 and T4

**Owns:**

- `apps/web/src/app/page.tsx`
- `apps/web/src/components/game/SpecimenPlate.tsx`
- `apps/web/src/components/game/XpBar.tsx`
- `apps/web/src/components/game/XpLedger.tsx` if it must be relabeled or replaced
- new home active-companion projection component

**Work:**

Use the shared runtime/view model. Remove the independent legacy companion/XP rendering path from the main page.

Garden signals may remain as an evidence/observation section, but they must not produce a competing active companion or conflicting progression bar. The home page must have a hydration-safe loading state and must not import server-only state into a client component.

**Acceptance:**

- Current fixture shows Mossling.
- Main page and `/companions` use the same active ID and projection for the same authority context.
- No independent stale `50` bar remains.
- Empty garden still shows the starter.
- Hydration has no mismatch.
- Account not-synced/unavailable states are explicit.

### T6 — Companions page and owned roster

**Owner:** Agent F

**Depends on:** T2, T3, and T4

**Owns:**

- `apps/web/src/app/companions/page.tsx`
- new `CompanionCollection.tsx`
- new `CompanionArchiveRow.tsx` or specimen presentation component
- `apps/web/src/components/game/CollectionGrid.tsx` only if it is removed or explicitly relabeled
- page-specific tests/view-model tests

**Work:**

Replace the split product panel plus misleading legacy Garden collection with an owned companion roster derived from the shared product projection.

The visual treatment should follow the archive/specimen design language, not a generic dashboard card grid.

Show:

- active companion image, name, form, XP, and progress
- each owned inactive companion image and Activate button
- collection count
- encounter progress with its own explanation
- provenance/source explanation
- duplicate/Essence meaning where applicable
- explicit not-synced/unavailable state for account data

**Acceptance:**

- Current profile displays Pikachu and Mossling.
- Mossling is active.
- Activate Pikachu changes the shared active state.
- Main page reflects the switch.
- A valid starter cannot render as an empty collection.
- Legacy repo/tag data is not mislabeled as the account product collection.
- Images have safe fallbacks.

### T7 — Documentation and acceptance contract

**Owner:** Agent G

**Depends on:** T5 and T6

**Owns only:**

- `docs/PRODUCT.md`
- `docs/DESIGN.md`
- `docs/PLAN.md`
- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/TESTING.md`
- `docs/COMPANION-INTEGRATION-PLAN.md`
- `docs/COMPANION-MIGRATION-FIXTURE.md`

Update all old manual-starter statements to the confirmed random base-stage behavior. Record:

- new-user random selection
- current-profile migration
- one active companion
- active-only new XP
- collection and duplicate semantics
- image/activation behavior
- progress-bar meaning
- local/account authority
- migration limitations
- manual browser acceptance steps
- `main-aufa` PR delivery workflow

### T8 — Red-team review

**Status:** complete. The red-team reported four genuine data-integrity issues:
editor mutations did not rescan, display-name source IDs could collide,
concurrent encounter merges could lose draws/Essence/progress, and bounded
GitHub catch-up could silently skip activity (including missing closed-issue
linkage). The fixes add post-mutation scans, persisted opaque garden IDs,
trigger-distinct encounter IDs with union-safe merge math, fail-closed partial
syncs, paginated releases/issues, CI/commit truncation detection, and timeline
linkage tests. Account hydration now filters stale local GitHub records before
rendering; local encounter rewards remain explicitly device-local rather than
being forged into server ownership. No privacy, client-bundle, Next 16, or
secret-leak issue was confirmed.

A complete read-only report recommended no-ship before those fixes. The
follow-up remediation is covered by the regression suite; the final gates now
pass, with only the documented repository-wide lint debt remaining.

**Owner:** Lead-controlled red-team agent, serial after the full diff exists.

Attack in this order:

1. Wrong family/form/provider ID or stale cache mapping.
2. Animated/static/local fallback failures.
3. Starter selection choosing an evolved/mastery form.
4. Starter reroll on refresh or namespace change.
5. Active-only XP attribution failure.
6. XP boundary, zero-division, NaN, empty-garden, and empty-collection failures.
7. Migration double-counting, event rebind errors, partial failure, or retry corruption.
8. Duplicate encounter/Essence regressions.
9. Client imports of `node:fs`, `path`, `os`, or other Node modules.
10. Invalid and forged snapshot IDs.
11. Secrets, tokens, note contents, or detailed telemetry leaking to clients/logs.
12. Next 16 `params` Promise handling.
13. `useSearchParams` Suspense requirements.
14. `allowedDevOrigins` and tunnel asset hydration.
15. Runtime artifacts or environment files.
16. PR branch/base/mergeability mistakes.

The red-team must return a written report. Any genuine weakness requires a fix or a failing regression test before final gates.

---

## 7. Test matrix

### Model and migration

- base-stage-only starter candidates
- injected deterministic RNG
- starter persistence/no reroll
- empty garden still has one companion
- exact current Pikachu + Mossling fixture
- exact migration version and retry behavior
- partial migration failure recovery
- active selection precedence
- duplicate encounter and Essence conversion
- old product events/proofs/checkpoints remain safe

### XP and progression

- only active companion receives new source events
- switching changes future ownership
- previously accepted event ownership is handled by the migration contract
- total XP versus stage-local progress
- thresholds at `0`, `1499`, `1500`, `1550`, `4999`, `5000`, and final form
- NaN, negative, and zero-denominator safety
- encounter meter never presented as evolution XP
- tags/backlinks/unchanged scans do not silently award unsupported XP

### Images and species integrity

- Grass/Mossling forms map to the correct provider IDs
- Pikachu forms map correctly
- animated sprite preferred
- static fallback
- local fallback
- animated ceiling and Heartwood static exception
- stale cache refresh
- accessible alt text
- reduced-motion behavior
- no live network calls in tests

### Sync and security

- guest namespace
- account namespace
- guest-to-account merge with explicit unverified-encounter boundary
- active selection persistence
- catalog-valid but unowned ID rejection
- forged snapshot rejection
- immutable account identity
- optimistic version conflict
- receipt/checkpoint replay
- blocked receipt preservation
- storage unavailable state
- no note content or secret leakage

### Browser acceptance

1. Create a clean guest profile.
2. Confirm one random base-stage starter.
3. Refresh and confirm the starter does not change.
4. Confirm an empty garden still shows the starter.
5. Load the current migration fixture.
6. Confirm collection contains Pikachu and Mossling.
7. Confirm Mossling is active.
8. Confirm main and Companions show the same image, form, and projection.
9. Activate Pikachu from `/companions`.
10. Generate qualifying source activity.
11. Confirm only Pikachu receives the new XP.
12. Activate Mossling again.
13. Confirm future XP returns to Mossling.
14. Reload and verify persistence.
15. Test guest/account merge and conflict states.
16. Test offline and storage-unavailable behavior.
17. Verify no dead buttons under the tunnel/dev origin.

Vitest is the automated logic gate. Browser steps are manual smoke acceptance and must be recorded in the PR body until a dedicated E2E harness exists.

### Recorded local browser smoke

Using the pi-chrome Edge bridge against `http://localhost:3000` in the signed-in
`ardhiqii` session:

- `/companions` rendered the migrated Mossling and Raichu roster with XP,
  encounter progress, and an `ACTIVATE` control only for the inactive row.
- Activating Raichu showed `Active companion updated.`, and `/` plus `/write`
  immediately projected Raichu; the test then restored Mossling and verified the
  feedback and shared projection again.
- `/write` showed the account projection (including Raichu while it was active),
  not the removed legacy XP bar. `/github` completed a sync and showed verified
  receipts, active-companion progression, and no dead controls after hydration.
- The remaining clean-profile, offline, storage-unavailable, second-account,
  and tunnel-origin cases are covered by unit/API guards and remain manual-E2E
  follow-ups; no claim is made that those destructive/environmental cases were
  exercised in the signed-in browser session.

---

## 8. PR delivery plan

This feature is delivered as **one classified PR**, not one PR per agent or task.

### Scope of the one PR

The PR contains the complete companion integration unit:

- shared active-companion runtime
- random base-stage starter selection
- Grass/Mossling catalog and migration
- current Pikachu + Mossling collection preservation
- active-only new XP attribution
- image and fallback behavior
- main-page integration
- Companions-page activation UI
- sync/recovery changes
- tests
- all required documentation, including this plan

### Branch and target

- Development branch: `feat/companions` (based on `origin/main-aufa`).
- Open one PR from this feature branch into `main-aufa`.
- Do not push directly to `main-aufa`; the PR is the delivery boundary.
- Classify it as `feat(companions)`.
- Keep commits atomic inside the one PR.
- `main` is the real final-product branch and is out of scope. Do not push to or merge into `main` for this task.
- Never push directly to `main-aufa`.

### PR body

The PR body must include:

1. What the integrated flow does.
2. An explicit `AS IS -> TO BE` description.
3. The current Pikachu + Mossling migration behavior.
4. The state-authority and XP rules.
5. Commands and results for all gates.
6. Browser smoke results.
7. Red-team findings and resolutions.
8. Known gaps, if any.

### Merge procedure

After implementation, red-team review, and final gates:

1. Check `git status --short`.
2. Review and stage explicit intended paths only.
3. Run `git diff --cached --check`.
4. Push the feature branch.
5. Create the single PR with base `main-aufa` and verify its URL/number.
6. Verify the PR head SHA and mergeability.
7. If conflicts exist, rebase the feature branch onto the current `origin/main-aufa`, resolve intentionally, rerun gates, and push with `--force-with-lease` only.
8. Stop after verifying the PR URL, head SHA, and mergeability; the repository owner controls the merge.
9. Do not deploy, promote to `main`, close the PR, or perform unrelated cleanup.

---

## 9. Final gates

After red-team findings and fixes, the lead runs once:

```bash
npm run typecheck   # pass
npm test            # 88 files / 1,019 tests pass
npm run build       # pass; existing Turbopack NFT-trace warning only
npm run lint        # known pre-existing failures outside this feature
                     # (.agents/GardenGraph.t21.tsx, apps/web graph/theme,
                     # generated extension icon scripts, and no pages directory)
git diff --check    # pass
git status --short
```

A targeted ESLint run over the feature paths passes with warnings only. The
full lint failure is not hidden: it is pre-existing repository-wide debt and
was not changed as unrelated cleanup. The build must be run in the local
development environment, not on the resource-constrained home server.

During planning and implementation, do not create the PR early. The PR is created only after the complete feature, tests, documentation, red-team review, and final gates are complete.
