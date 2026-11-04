# Plan: show the dressed companion on the repo

> Status: **Implemented, uncommitted** (2026-11-04), on `feat/dressed-repo-creature`.
> §8 resolved with the proposed answers. §2 was wrong on one point: the snapshot
> hashes `collection[].referenceId` but not `assignments[].referenceId`, so the
> resolver compares both hashed (see `PRODUCT.md` §6.3, "Known gap"). The CDN
> window for an opted-in owner is five minutes, as proposed in the follow-up.
> Closes the gap listed as **Deferred** in `docs/PRODUCT.md` §6.3. Once the open questions in §8 are
> answered, the decisions move into `docs/DECISIONS.md` and the phases into
> `docs/PLAN.md` / `docs/ROADMAP.md`.

## 1. Why

Inside Terrarium a user can **dress** a companion onto a repository (PRODUCT.md
§6.3, `lib/game/repo-assignments.ts`). Nothing outside Terrarium shows that
choice. Every public surface still picks the creature itself:

| Surface | How it picks the creature today |
|---|---|
| `GET /api/creature?user=&repo=` | `assignSpeciesLine` from repo language, age, size (`app/api/creature/route.ts:254`) |
| `GET /api/creature.svg?user=&repo=` (README badge) | the same automatic pick, rendered as SVG |
| Extension content badge on github.com | reads `speciesLineId` from `/api/creature` (`extension/content/content.js:337`) |
| Extension popup repo list | `speciesLineId` from the API, or a local FNV hash fallback (`extension/popup/popup.js:192`) |

So dressing Pikachu onto `my-repo` changes the House and the collection, but a
visitor to `github.com/me/my-repo` still sees whatever the hash picked. The
feature is half-built: the choice exists, the display ignores it.

**Goal:** when the owner has dressed a repo and has opted in, every public
surface for that repo shows the **dressed companion** at its real stage. When
nothing is dressed (or the owner hasn't opted in), behaviour stays exactly as it
is today.

| In scope | Out of scope |
|---|---|
| The two `/api/creature*` routes reading the owner's synced assignments | Changing the assignment rule (bound, spending, one per repo) |
| A public-display opt-in for dressed repos | Dressing repos you don't own, or org repos |
| Extension content badge and popup using the new fields | Animated SVG badge, new badge layouts |
| Docs and tests | Showing other collection details publicly (eggs, Essence, full collection) |

## 2. What already exists (verified 2026-11-04)

- **Assignments are synced.** `ProductSnapshot.assignments` is
  `{ repositoryId, referenceId, companionId, assignedAt }[]`
  (`lib/sync/product-snapshot.ts:171`), and the server keeps the latest snapshot
  per account in the product store (`lib/sync/product-store.ts`, keyed by
  `githubId`, with `handle` stored alongside).
- **`repositoryId` is GitHub's numeric id**, stable across renames. The routes
  receive `owner` + `repo` name, so they need the numeric id.
  `fetchRepoMeta` (`lib/game/creature-route-shared.ts:176`) already calls
  `/repos/{owner}/{repo}` but does not keep `id` yet.
- **Per-companion XP is synced** (`snapshot.companions`), and
  `companion-catalog.ts` can resolve XP → progression step.
- **The extension already prefers the server's answer** over its local hash, so
  most of the extension work is consuming one new field.
- **Profile privacy is opt-in, default private** (`lib/sync/profile-visibility.ts`).
  `collection` and `encounters` are on `NEVER_PUBLIC_FIELDS`.

## 3. The two traps to design around

### 3.1 Two different creature id spaces

The automatic pick returns a **species line** from `lib/game/sprites/species.ts`
(`grass`, `ember`, `current`, … with the T19 stage ladder `STAGES`). A dressed
companion is a **catalog entry** from `lib/game/companion-catalog.ts`
(`pikachu-family`, `bulbasaur-line`, …) with its own progression steps and form
ids, rendered by `lib/game/companion-sprite.ts`.

Neither maps onto the other. Forcing a companion into `speciesLineId` would
either lie about the species or pick the wrong sprite. **Decision:** the API
gains a separate, optional `dressed` object. Clients render `dressed` when it is
present and fall back to `speciesLineId` + `stage` otherwise. The frozen
`CreatureState` shape stays untouched, just like `degraded` and `speciesLineId`.

```jsonc
// GET /api/creature?user=ardhiqii&repo=terrarium  (dressed and public)
{
  "...CreatureState": "unchanged",
  "speciesLineId": "ember",          // still sent; old clients keep working
  "dressed": {
    "companionId": "pikachu-family",
    "name": "Pikachu",
    "step": { "id": "evolved", "name": "Charged" },
    "xp": 140,
    "spriteUrl": "https://…/25.gif", // already resolved server-side
    "static": false
  }
}
```

`referenceId` is **not** sent. It is internal identity, and the public needs
nothing it would add.

### 3.2 Publishing a private choice

Today nothing about a user's collection is public. A dressed badge reveals one
companion and its progress per repo. That is a small disclosure, but it is a
new one, and AGENTS.md / PRODUCT.md make every public surface opt-in.

**Decision (proposed, see Q1):** add a separate toggle, **"Show dressed
companions on my repos"**, default **off**, stored beside profile visibility. It
is independent of the public profile, because a user may want badges without a
browsable profile. Until it is on, the routes behave exactly as today, and the
response does not reveal whether a repo is dressed at all.

## 4. AS IS → TO BE

```
AS IS
visitor ── GET /api/creature?user=u&repo=r
            └─ assignSpeciesLine(language, age, size) ──► speciesLineId ──► sprite

TO BE
visitor ── GET /api/creature?user=u&repo=r
            ├─ fetchRepoMeta(u, r)  → { id, language, … }   (already called; now keeps id)
            ├─ resolveDressedCompanion(u, repoId)
            │    ├─ account for handle u?            no  → null
            │    ├─ dressed-display opt-in on?       no  → null
            │    ├─ snapshot.assignments has repoId? no  → null
            │    └─ companion still owned + known?   no  → null
            │         yes → { companionId, step, xp, spriteUrl }
            ├─ speciesLineId (unchanged, always computed)
            └─ body = { …state, speciesLineId, dressed? }
```

The repo owner on GitHub (`u`) must be the Terrarium account that dressed it.
Only the account whose GitHub login matches `u` is consulted, so nobody can
dress someone else's repo onto their badge. Because `repositoryId` is numeric
and the route uses the id GitHub returns for `u/r`, a renamed or transferred
repo resolves correctly, and a repo transferred to another owner stops showing
the old owner's companion.

## 5. Phases

### Phase 1: resolver and opt-in (server only, no visible change)

1. `fetchRepoMeta` returns `id` (GitHub's numeric repo id) as well. Update the
   `RepoMeta` type and its test.
2. New pure module `lib/game/dressed-companion.ts`:
   - `resolveDressedCompanion(snapshot, repositoryId, catalog) → DressedCompanion | null`
   - Applies `pruneAssignments` semantics on read: an assignment whose
     `referenceId` is no longer in `collection` returns null (PRODUCT.md §6.3,
     "enforced on read").
   - Resolves XP from `snapshot.companions` (XP follows the species), then step
     and sprite through the catalog and `companion-sprite.ts`.
   - Returns null, never throws, for an unknown companion id or missing sprite.
3. Dressed-display preference:
   - Extend the visibility record with `dressedRepos: 'private' | 'public'`
     (default `private`), in both the SQLite and Supabase stores, with a
     migration that defaults existing rows to private.
   - Extend `PUT /api/profile/visibility` to accept it, with validation.
4. A handle → `githubId` lookup for the product store, if one doesn't exist yet
   (the store keeps `handle`; add `getByHandle` or reuse the leaderboard's path).
5. Tests: resolver unit tests (dressed, not dressed, orphaned reference, unknown
   companion, zero XP, XP past the last threshold) and preference
   validation/default tests.

### Phase 2: the routes

1. `/api/creature` (repo branch) and `/api/creature.svg` (repo branch) call the
   resolver after `fetchRepoMeta`, and attach `dressed` or render it.
2. **Caching:**
   - The in-process cache key stays `creature:u/r`. The cached body already
     includes `dressed`, so a hit costs nothing extra.
   - **Staleness:** a user who dresses or undresses a repo would wait up to the
     1 h `s-maxage` plus the in-process TTL. On a successful product sync that
     changes `assignments` or the opt-in, evict that user's `creature:u/*`
     in-process entries. The CDN edge still lags up to an hour; say so in the UI
     ("Badges update within an hour").
   - README images go through GitHub's camo proxy, which caches on its own. The
     `&v=` cache-buster the badge already supports is the documented escape
     hatch. Mention it in the guide.
3. **Failure behaviour is unchanged:** any resolver or store failure means
   `dressed` is omitted and the automatic pick is shown. The SVG route still
   never returns non-200.
4. **The garden creature is untouched:** the handle-level branch (no `repo`)
   doesn't change. Its owner/stranger asymmetry is the riskiest code in the repo.
5. SVG: `renderCreatureBadgeSvg` gains a dressed variant (companion sprite, name,
   step name). Keep the static fallback rule: animated only when the sprite has
   a GIF, otherwise the static image.
6. Tests: route tests with a mocked product store and visibility store for:
   - opt-in off → no `dressed` key at all
   - opt-in on, repo dressed → `dressed` present
   - repo not dressed → no `dressed`
   - store throws → automatic pick, 200
   - handle with no account → automatic pick
   - another account dressed a repo with the same name but a different id → ignored

   No live network calls: `fetchRepoMeta` and the GitHub client are mocked.

### Phase 3: extension

1. `content.js` badge: when `state.dressed` is present, use
   `state.dressed.spriteUrl` and show `dressed.name` / `dressed.step.name`.
   Otherwise keep the current `spriteUrl(stage, speciesLineId)`.
2. `popup.js` repo list: same rule. The local FNV hash fallback is kept only for
   old API responses.
3. `core.js`: add a small `creatureDisplay(state)` that returns
   `{ spriteUrl, title, subtitle }`, so the content script and the popup can't
   drift. Cover it in `core.test.js`.
4. Reduced motion: the existing freeze-to-canvas path works on any `<img>`;
   confirm it with a dressed GIF.

### Phase 4: the owner's side of the UI and docs

1. Where dressing happens (`OwnedCompanionGrid.tsx`, and the repo tiles in
   `GitHubSourcePanel.tsx`), show one line on a dressed repo, following the
   calmer-UI copy budget (DESIGN.md §7):
   - opt-in off: "Only you see this. Show on GitHub" (links to the setting)
   - opt-in on: "Shown on GitHub" plus copy-badge-markdown
2. Settings: the toggle sits beside the profile visibility control, with an
   `InfoDisclosure` ("What this shows": one companion, its stage and XP per
   dressed repo; nothing else from your collection).
3. Guide: a short "Dressing a repo" section under `GUIDE_ANCHORS`, including the
   one-hour delay and the `&v=` tip.
4. Docs:
   - `PRODUCT.md`: §6.3 replaces the Deferred bullet with the shipped rule, and
     §9 updates "README badge".
   - `DECISIONS.md`: the separate `dressed` object and the separate opt-in.
   - `ROADMAP.md`: shipped entry.

## 6. Red-team focus (for the PR, per AGENTS.md)

- **Privacy:** with the opt-in off, does any response, header, status code,
  timing or cache key reveal that a repo is dressed? Does `referenceId`,
  `guestId` or any other collection entry leak?
- **Ownership:** can account A's assignment surface on a repo owned by B? Look at
  name collisions, renames, transfers, case-different handles, and a handle that
  was renamed on GitHub and then reclaimed by someone else.
- **Stale or forged snapshot:** an assignment pointing at an unowned
  `referenceId`, two assignments on one repo, or one companion spent twice. The
  resolver must apply the read-side rule.
- **Sprite integrity:** a catalog form with no sprite id, the `<= 649` animated
  ceiling, a static-only form, and the PokeAPI cache returning an old id.
- **Math:** XP 0, XP exactly on a threshold, XP past the last step, NaN or
  negative XP from a hand-edited snapshot.
- **Caching:** a cached response from before the opt-in was turned off still
  being served. Eviction must cover that case, or the response must not be
  cached past the toggle.
- **Client-bundle safety:** the resolver must stay pure. The store and `node:fs`
  access stay in the route.

## 7. Acceptance

- Dress a repo, turn the opt-in on, sync. Within the cache window, `/api/creature`
  returns `dressed`, the README badge shows the companion, and the extension
  badge and popup show it.
- Turn the opt-in off and sync. After eviction, the repo shows the automatic pick
  again, and the response has no `dressed` key.
- Undress the repo, or the companion leaves the collection: the repo falls back to
  the automatic pick.
- Repos that aren't dressed, users without an account, and the handle-level
  garden creature are byte-for-byte unchanged.
- `npm run typecheck`, `npm test` and `npm run build` pass, and the extension
  tests pass.

## 8. Open questions

| # | Question | Proposed answer |
|---|---|---|
| Q1 | Separate opt-in for dressed badges, or reuse public-profile visibility? | **Separate, default off.** Badges are useful without a browsable profile. |
| Q2 | Which stage does the badge show: the companion's own XP, or this repo's commit activity? | **The companion's own XP.** That is what the user grew. Repo commit stats stay in `state` for anything that reads them. |
| Q3 | Show the companion's nickname if one is set? | **No, not in v1.** Nicknames are user text; keep them off public surfaces until there is a reason. |
| Q4 | When dressing changes, is waiting up to an hour acceptable, or is a short-TTL bypass needed for the owner's own preview? | Accept the hour publicly, and show the live state inside Terrarium. |
| Q5 | Repos in an organisation the user belongs to? | Out of scope. The owner segment must match the account's login. |
