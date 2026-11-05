# Plan — fix the QA bugs on dressed repositories

**Status:** Implemented (2026-11-05), uncommitted. Bug A is still a separate PR.
**Branch:** `feat/dressed-repo-creature` (same PR; these are fixes to the unmerged feature)
**Source:** the user-level QA pass on 2026-11-04 (headless Edge, desktop + 390px, local SQLite).
Screenshots from that pass are in the session scratchpad, not in the repo.
**Related:** `docs-plan/PLAN-dressed-repo-creature.md`, `docs/PRODUCT.md` §6.3

Scope is **only the bugs** found in QA. The improvement ideas (a live badge preview, a canonical
origin for Copy badge, real creature names, and unified stage words) are listed at the end as out of
scope.

---

## Summary

| ID | Bug | Severity | In this PR? |
|----|-----|----------|-------------|
| D | Dressing never reaches GitHub until a sync that `/repos` cannot start | Medium | Yes (fix 1) |
| B | The badge footer `@owner/repo` is clipped at the bottom edge | Low–medium | Yes (fix 2) |
| C | Copy says "within ten minutes"; opting in can take up to an hour | Low | Yes (fix 3) |
| E | Signed-out `/repos` gives a dead instruction and fires two 401s | Low | Yes (fix 4) |
| F | Plural/aria copy, a missing `X-Cache` on the SVG, the undressed badge `<title>` | Low | Yes (fix 5) |
| G | The extension's sprite-prefix check can be bypassed with `../`; it accepts `step.index` 0 | Low (hardening) | Yes (fix 6) |
| H | Stale route comment; a GitHub rate-limit failure serves opted-in badges undressed for 1h | Low | Yes (fix 7) |
| A | React "setState while rendering" when an egg hatches | Medium | **No.** It predates this branch, so it gets a separate PR (§ Separate) |

Order of work: fix 1 (the one that makes the feature look broken), then 2–5 (copy and render), then
6–7 (hardening).

---

## Fix 1 — Dressing reaches GitHub without visiting `/github` (bug D)

### AS IS
- Dressing or taking back writes `assignments` to the local guest profile (localStorage) only.
- The product snapshot, which the public routes read through `getProductStore().get(githubId)`, is
  uploaded only by the full sync in `GitHubSourcePanel.tsx` (`uploadProductSnapshot`, ~L493).
- `/repos` says "after your next sync" but has no sync control and no "not synced yet" state.
- Result: the user dresses a repo, copies the badge, and sees the automatic creature, with no hint why.

### TO BE
- Dressing, taking back, or turning the badge setting on pushes the dressing to the server right away.
- Each dressed row shows its real state:
  - `· shown on GitHub`: synced, opted in, public
  - `· saving…`: sync in flight
  - `· not on GitHub yet — retry`: the push failed; a button retries it
  - `· private, not shown`: unchanged

### Approach (recommended): a narrow endpoint that pushes dressing only
Do not reuse the full snapshot upload from `/repos`. That path carries checkpoints, receipt repair,
and blocked-event handling (`GitHubSourcePanel.tsx` L300–560). Replaying it from a second page risks
racing a running sync and duplicating receipts.

Add **`PUT /api/profile/repo-assignments`**:
- Session-only. Writes the caller's own snapshot (`session.githubId`); any id in the body is ignored,
  the same rule as `/api/profile/repo-badges`.
- Body: `{ assignments: Array<{ repositoryId, referenceId, companionId, assignedAt }> }`. Validate
  strictly:
  - at most N entries (N = the existing repo cap);
  - `repositoryId` is a numeric string;
  - the strings have bounded lengths;
  - `assignedAt` is ISO;
  - reject unknown fields.
- Server behaviour:
  - Load the stored snapshot.
  - If there is none, return `409 { reason: 'never-synced' }`. The UI then says "Sync once from
    GitHub first" and links to `/github`. The first sync is still what creates the collection.
  - Replace **only** `snapshot.assignments`; never touch events, the collection, or XP. Write it back.
- Ownership is not trusted from the body. `resolveDressedCompanion` already re-checks it on read: an
  assignment whose reference is not in the stored collection is ignored. A test pins that.
- Clear the 60s dressed-lookup cache entry for this owner (`dressed:${ownerId}:*`) on success. That
  only works in the same process; the CDN window is still 5 min, which the copy already says.
- Rate limit 30/min, `no-store`, and 401/400/409/503 like the badge route.
- Keep the reference id as the full sync stores it, raw, so the two writers agree. The
  hashed-vs-raw gap (bug I in QA, already in `docs/PRODUCT.md` §6.3) is not fixed here.

Client (`CompanionPicker.tsx`):
- After a successful local dress or take-back, debounce for 800ms, then PUT the full current
  `assignments` list. Last write wins, and the full list makes it idempotent.
- Track `pushState: 'idle' | 'saving' | 'error' | 'never-synced'` and render it in each row label.
- Turning the badge setting on also triggers one push, so a user who dressed before opting in is
  covered.
- Signed out: no push (see fix 4).

### Alternative (not chosen)
Call the existing full sync from `/repos`. It reuses code but pulls the whole receipt and checkpoint
machinery into a second page, and a sync can take seconds to minutes.

### Tests
- Route (`apps/web/src/app/api/profile/repo-assignments/route.test.ts`):
  - 401 without a session.
  - 400 matrix: non-array, too many entries, a non-numeric `repositoryId`, an extra field.
  - 409 when there is no snapshot.
  - Replaces assignments only; events, collection, and companions stay byte-equal.
  - A `githubId` in the body is ignored.
- Lookup: an assignment pushed with a reference that is not in the collection still resolves to `null`.
- Picker: a pure helper for the row-label state (`dressedRowLabel(pushState, optedIn, isPrivate)`),
  unit-tested in the node env (the suite has no DOM).

### Docs
- `docs/PRODUCT.md` §6.3: dressing syncs on its own, and the first sync is still required.
- The guide section "Dressing a repo": drop "after your next sync".
- `docs/DECISIONS.md`: one line on why there is a narrow endpoint instead of the full sync.

---

## Fix 2 — The badge footer is clipped (bug B)

### AS IS
`svg-render.ts:257` (automatic badge) and `:334` (dressed badge) draw `@owner/repo` at `y="120"` in
an SVG that is 120px tall. The baseline sits on the edge, so descenders (`g`, `p`, `y`) are cut and
the text touches the border.

### TO BE
*(As built: the XP line moved to `y=100` and the footer to `y=114` (`BADGE_HEIGHT - 6`); the badge stays 120px.)*
The footer baseline sits at `y="112"`, leaving 8px below it. Check that it does not collide with the
XP bar above it. If it does, grow the badge to 128px instead and keep `y="120"`, applied to both
badges through the shared `height` used in `svg-render.ts:196`.

### Tests
`svg-render.test.ts`: for both badge kinds, parse `height` and the footer text's `y` and assert that
`y <= height - 6`. This guards any later resize.

---

## Fix 3 — Timing copy (bug C)

### AS IS
- `guide/page.tsx:475` and the "What this shows" disclosure in `CompanionPicker.tsx` say changes
  appear "usually within ten minutes".
- `api/profile/repo-badges/route.ts:15` already says opting in can take up to an hour, because the
  undressed badge was cached with `s-maxage=3600` plus SWR.

### TO BE
The copy matches the cache, in one short sentence each:
- Changing which companion is dressed, or opting out: "within a few minutes".
- Turning the badge on for the first time: "can take up to an hour. GitHub also caches images on its
  side".

Keep it short; the calmer-UI work (PR #81) cut text on purpose.

### Tests
None beyond the typecheck. This is a copy change only.

---

## Fix 4 — Signed-out `/repos` (bug E)

### AS IS
- It shows "No tracked repos yet. Pick some under GitHub."
- "GitHub" is plain text, and a guest cannot pick repos without signing in.
- The page fires `GET /api/profile/repo-badges` and `GET /api/github/repositories`. Both return 401
  and show up as console errors.

### TO BE
- Without a session, the empty state reads "Sign in with GitHub to dress your repos" with the
  existing sign-in link (`/api/auth/login`).
- Neither fetch runs without a session. Gate both on the session state the page already knows; the
  header account menu reads it.
- Signed in with no tracked repos: "No tracked repos yet. Pick some on GitHub", where "GitHub" is a
  link to `/github`.

### Tests
A pure helper `repoEmptyState({ signedIn, repoCount })` returning the copy key, unit-tested.

---

## Fix 5 — Small copy and markup (bug F)

| Where | AS IS | TO BE |
|-------|-------|-------|
| The synced condition card on `/companions` | "Collection 1 companions" | Plural-aware: "1 companion" / "N companions" |
| The egg's aria-label | "1 taps left" | "1 tap left" / "N taps left" |
| `api/creature.svg/route.ts` | no `X-Cache` header | `X-Cache: HIT \| MISS`, the same as the JSON route (`api/creature/route.ts:146`) |
| The undressed repo badge `<title>` | "Sporeling, Stage 1 of 4, octocat" | Includes the repo: "…, octocat/Hello-World" |

Use one shared `plural(n, one, many)` helper if `lib/copy.ts` does not already have one; check
first. "Pikachu family" as a display name is **not** in scope: it is a naming decision, listed under
out of scope.

### Tests
- `plural` unit test.
- SVG route test asserting `X-Cache`.
- `svg-render.test.ts` asserting the repo is in the `<title>`.

---

## Fix 6 — Extension sprite URL hardening (G)

### AS IS
`apps/extension/common/core.js:262-266` (`creatureDisplay`) checks
`url.startsWith('https://raw.githubusercontent.com/PokeAPI/sprites/')`. A value such as
`…/PokeAPI/sprites/../../evil/repo/x.png` passes the check and the browser resolves it elsewhere. It
also accepts `step.index` 0, which shows "L0". This only matters if the API itself is compromised.

### TO BE
- Parse the URL with `new URL(url)` and require all of:
  - protocol `https:`;
  - host `raw.githubusercontent.com`;
  - the *resolved* `pathname` starts with `/PokeAPI/sprites/`;
  - the raw string contains no `..` or `%2e`.
- `step.index` must be an integer ≥ 1 and ≤ `step.count`; otherwise fall back to the automatic pick.
- Apply the same check to `stillUrl`.
- Mirror the resolved-path check server-side in `sprite-data-uri.ts`, whose prefix test has the same
  shape.

### Tests
- `core.test.js`: the `../`, `%2e%2e`, wrong-host, and index 0 cases each fall back to the automatic
  pick.
- `sprite-data-uri.test.ts`: the `../` case returns `null` without calling `fetch`.

---

## Fix 7 — Rate-limit fallback and the stale comment (H)

### AS IS
- `freshRepoMeta` refetches `/repos/{o}/{r}` once metadata is older than 5 minutes, even on a creature
  cache HIT. The comment near `api/creature/route.ts` ~L120 still says a fresh hit makes no GitHub
  call.
- If that refetch fails (for example, the 60/h unauthenticated limit), the lookup returns
  `optedIn=false`. An opted-in owner's badge is then served undressed with the long 1h + 24h-SWR
  window.

### TO BE
- On a refetch failure, fall back to the last known metadata (`cachedRepoMeta`, stale) **only** for
  the cache-window decision. The dressed decision still requires fresh, owner-checked metadata, as
  the earlier red-team fix intended.
- When the dressed decision cannot be made (a fetch failure), use the **short** window
  (`s-maxage=300`), so a transient GitHub error never pins an undressed badge for a day.
- Update the route comment to say a refetch happens when metadata is over 5 minutes old.

### Tests
`dressed.test.ts`: GitHub `/repos` returns 403 (rate limit) on the second request → the response is
the automatic creature with `s-maxage=300`, not 3600.

---

## Gates

```bash
npx vitest run apps/web/src/app/api/profile apps/web/src/app/api/creature apps/web/src/lib/game apps/extension
npm run typecheck
npm test
npm run build
```

Expected known failures, unchanged:
- the CRLF test in `product-activity-panel.test.ts`;
- a possible cold-import timeout in a creature route test, which passes on its own.

Manual check (`npm run dev`, signed in):
1. Dress a repo on `/repos` and watch the row go from `saving…` to `shown on GitHub` without visiting
   `/github`.
2. Open `/api/creature.svg?user=&repo=` and check that the dressed companion shows and the footer is
   not clipped.
3. Sign out, open `/repos`, and check for the sign-in prompt and no 401s in the console.

The red-team runs again before push (AGENTS.md). Focus: the new `repo-assignments` endpoint (whether
one account can write another's assignments, oversized bodies, whether it overwrites the collection
or events) and the URL check in fix 6.

---

## Separate PR — the egg-hatch setState error (bug A)

Not part of this branch, because the code predates it.

- **Repro:** go to `/companions` and tap the egg 3 times. The dev overlay shows "Cannot update a
  component (`EggBadge`) while rendering a different component (`EggHatch`)".
- **Cause:** side effects run inside state updater functions:
  - `EggHatch.tsx:89-95` calls `onHatched()` inside the `setTaps` updater.
  - `OwnedCompanionGrid.tsx:117-124` writes localStorage and dispatches
    `terrarium:guest-profile-updated` inside the `setProfile` updater.
- **Fix:**
  - Compute the next value, call `setX(next)`, then run the side effect in the event handler, or in a
    `useEffect` keyed on the hatched state.
  - Updaters must stay pure; React may call them twice in Strict Mode, which would also
    double-dispatch the event.
- **Branch:** `fix/egg-hatch-setstate` from `origin/main`.

---

## Out of scope (QA recommendations, not bugs)

- A live badge preview (`<img>`) per dressed row.
- Copy badge using a canonical public origin instead of `window.location.origin`, wrapping the badge
  in a link, resetting "Copied" after a few seconds, and offering a selectable field when the
  clipboard is blocked.
- A "No free companion — take one back or hatch an egg" state instead of selects whose options are
  all disabled.
- Real creature names instead of "Pikachu family", and one set of stage words (Sporeling, Seedling,
  and Beginning currently appear together).
- An error style for picker messages, and clearing them on the next success.
- Restore keeps hashed collection references next to raw assignment references (`docs/PRODUCT.md`
  §6.3 gap).
- Setting `turbopack.root` to silence the stray `C:\Users\LGSM124\package-lock.json` warning.
