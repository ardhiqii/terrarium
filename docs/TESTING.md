# How to test this

Everything below you can run yourself. Start with the automated layer, since it takes seconds and covers the most.

---

## 1. Automated (30 seconds)

```bash
npm test            # full web + extension suite
npm run typecheck   # type check, should print nothing
npm run build       # production build
```

All three should pass with no output-worthy errors. If the test count drops unexpectedly, something regressed.

### Are the tests any good?

```bash
npm run test:mutation
```

This runs Stryker, which deliberately introduces bugs into the XP engine and checks whether the tests notice. A "survived" mutant is a bug your tests would miss.

Report opens at `reports/mutation/mutation.html`.

Current: **69.00% overall / 71.01% of covered mutants** across 7 legacy game modules. The latest full run had 559 killed, 229 survived, 23 with no coverage, 2 timeouts, and 0 errors. Do not chase 100%. A large share of survivors are provably equivalent mutants, meaning no input can distinguish them, and a good chunk of the rest are blanked display strings the suite intentionally does not assert. `reports/mutation/mutation.html` shows exactly which.

### Hosted sync validation

The Supabase adapter has a separate focused mutation run because the default
configuration still targets the legacy game modules:

```powershell
npx vitest run apps/web/src/lib/sync/supabase-client.test.ts apps/web/src/lib/sync/supabase-store.test.ts apps/web/src/lib/sync/supabase-product-store.test.ts apps/web/src/lib/sync/supabase-github-account-store.test.ts apps/web/src/app/api/sync/product/route.test.ts
```

The focused integration contracts cover adapter serialization, normalization,
errors, product POST/GET/DELETE, optimistic writes, server-issued GitHub
receipts, deferred checkpoint recovery, replay-safe merging, guest conflicts,
payload validation, repository selection, browser receipt persistence, and size
limits. Keep the focused command above scoped to the changed files when adding
new sync hardening tests.

The large-account baseline path has its own end-to-end contract:
`apps/web/src/app/api/sync/product/github-sync-roundtrip.test.ts` drives both
real routes and both SQLite stores with only the GitHub providers mocked. It
pins the failures that made a 44-repository account unable to bank XP: the
whole tracked set is baselined window by window with no repository stranded, a
checkpoint over more than 500 event IDs is issued and committed, and the
checkpoint reaches `/api/sync/product` in the request body rather than a request
header. `apps/web/src/lib/sync/sync-schedule.test.ts` pins the automatic-sync
cadence and its GitHub request budget (a window's worth of repositories, not the
whole tracked set, so the documented choices stay affordable) and the derived
window invariant (`MAX_SYNC_REPOSITORIES` x `MAX_EVENTS_PER_REPOSITORY` must fit
inside `MAX_CHECKPOINT_EVENT_IDS`);
`apps/web/src/app/api/github/sync/route.test.ts` proves a heavy full window is
never rejected by the checkpoint validator. `apps/web/src/lib/sync/github-sync-checkpoint.test.ts`
proves a full window of worst-case events plus 500-entry baseline maps still fits
the signed-token bound.
The latest focused mutation run covered the Supabase adapters and cloud
rehydration helper with **61.08% overall mutation score, 67.26% of covered
mutants, 0 timeouts, and 0 errors**. Survivors are reported so they remain
visible; this score is not a claim that the hosted path is fully hardened.

The real Supabase project was checked manually in the SQL editor on 2026-09-14:
all three tables (`synced_users`, `github_accounts`, `product_snapshots`) exist,
and all three report `rls_enabled = true`. Tests must continue using mocks or
local SQLite; do not put live Supabase calls in the Vitest suite.
`apps/web/src/lib/sync/supabase-schema.test.ts` is the guard against a schema
drift the mocked-client suite cannot see: it records every column the Supabase
adapter selects, filters on, or writes and asserts each one is declared by a
file under `supabase/migrations/`. Apply all migrations, including
`20260918000000_github_accounts_disconnect.sql` (`github_accounts.disconnected_at`).

---

## 2. The site

```bash
npm run dev
```

Open http://localhost:3000. If it says port 3000 is in use, an old server is stuck. Kill it:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Check these by eye:

| Page | What should be true |
|---|---|
| `/` | Creature sprite is **animated**, stage and XP bar show real numbers, item drawer shows locked and unlocked items |
| `/companions` | Four stages, unreached ones greyed with "Not yet reached", XP thresholds visible |
| `/notes`, `/projects` | **No creature UI at all.** Reading surfaces stay clean, that separation is deliberate |
| `/graph` | Force graph renders and is draggable |

Then toggle **dark mode** in the navbar and walk the same pages. Both themes are supposed to hold up.

### Reduced motion

This one is easy to get wrong, so it is worth checking. In Chrome DevTools: `Ctrl+Shift+P`, run "Show Rendering", set **Emulate CSS prefers-reduced-motion** to `reduce`, then reload `/companions`.

The creature should go **completely still**. A CSS media query cannot pause a GIF, so this works by swapping to a static PNG. If it still moves, that fix broke.

---

## 3. The API

With the dev server running:

```bash
# Your creature: garden XP plus commit XP
curl "http://localhost:3000/api/creature?user=octocat"

# Someone else: commit XP only, garden stats must be ZERO
curl "http://localhost:3000/api/creature?user=torvalds"

# A single repo's creature
curl "http://localhost:3000/api/creature?user=torvalds&repo=linux"

# Errors
curl -i "http://localhost:3000/api/creature"                 # 400
curl -i "http://localhost:3000/api/creature?user=zzz-no-such" # 404
```

**The one to actually look at:** in the `torvalds` response, every field under `stats` must be `0` or `null`, and `items` must contain no garden items. If your note count shows up in a stranger's creature, that is the leak this project has already had twice.

---

## 4. The README badge

```bash
curl "http://localhost:3000/api/creature.svg?user=octocat" -o badge.svg
```

Open `badge.svg` in a browser. You should see the sprite, name, stage, and XP bar.

It is **static by design**. GitHub proxies README images through its camo cache, which strips SVG animation, so an animated badge would simply not animate for anyone else.

To use it once deployed:

```markdown
![My creature](https://YOUR-DOMAIN/api/creature.svg?user=octocat)
```

---

## 5. Browser smoke / E2E

There is no Playwright/Cypress runner in this repository yet, so this is a
real-browser smoke check rather than a committed automated E2E suite. On the
local Next server, the home, companions, notes, projects, graph, and preview
pages loaded without runtime errors. The creature API returned 200 for a valid
handle, 400 for a missing handle, and 404 for an unknown handle. The hosted
`/github` page also rendered the authenticated repository picker and account
settings.

Cloud restore still needs to be exercised after this branch is deployed with
the Vercel Supabase variables; the current browser deployment predates the
uncommitted adapter changes.

Repository-cache and Disconnect smoke checks (manual, on the local Next server):

1. Open `/github`. The picker paints the last known list and labels it with how
   old it is; the count and freshness label appear above the repository browser.
2. Reload `/github`. The list must be on screen in the first frame — no
   “Checking GitHub access…” flash — and the network tab must still show one
   `GET /api/github/repositories` (the paint is a cache, not the source).
3. Click **Refresh list**. The label updates and the request carries
   `?refresh=1`.
4. Go offline (devtools or network), reload. The list stays visible and the
   label reads `cached · unavailable · updated …`.
5. Open `/github` in a browser profile that has previously used a different
   GitHub account. The second account must never see the first account's
   repository names, not even for a frame after a failed refresh.
6. Click **Disconnect GitHub**, then **Confirm disconnect**. The status turns to
   “Not connected”, the message says earned XP was kept, and the companion and
   activity panels stay visible. `DELETE /api/github/repositories` answers 204
   and `DELETE /api/sync/product` is not called.
7. Sign in again. The token is stored afresh, the repository choices are still
   selected, and the first sync re-baselines instead of backfilling XP.

Automated guards for the same paths (offline, no live calls):

- `apps/web/src/lib/sync/github-repositories.test.ts` — a short page with
  `Link: rel="next"` keeps walking instead of ending the listing early; a walk
  that reaches the page ceiling with a successor is `truncated`; a mid-walk
  failure discards the pages already read instead of caching a partial list.
- `apps/web/src/lib/sync/github-repository-cache.test.ts` — concurrent reads
  for one account share a single provider call; a purge (disconnect, re-auth)
  is never undone by an in-flight read; a backwards clock revalidates instead
  of serving the entry as fresh; a concurrent read for a different account is
  independent.
- `apps/web/src/lib/game/github-repository-browser-cache.test.ts` — a degraded
  response cannot replace a newer stored listing; the failed-refresh decision
  keeps the visible list only for the account the server answered for and
  drops it for a different account.
- `apps/web/src/app/api/github/repositories/route.test.ts` — an oversized
  chunked body answers 413 even without a `content-length` header; refresh
  values that are not `1`/`true` keep the cache entry; malformed settings,
  prototype keys, tracked+excluded conflicts, and unknown IDs still answer 400;
  automatic failed reads never clear the credential; a stale listing reports
  its original read time.
- `apps/web/src/lib/sync/github-account-store.test.ts` — opening the store on a
  legacy development database adds the disconnect column without losing rows,
  and disconnect leaves another account's choices untouched.

## 6. The extension

**This is the only part no test covers.** Its logic is unit tested, but nothing verifies it renders on a real GitHub page. That check needs you.

1. Make sure the dev server is running on **port 3000**. The extension defaults to `http://localhost:3000`, so it shows nothing if the API is on a different port.
2. Chrome → `chrome://extensions/`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select the `apps/extension/` folder in this repo
5. Visit `https://github.com/torvalds?tab=repositories`

Expected: a small creature next to each repo in the list.

Then check:
- Click the extension icon. The popup should show a creature and a repo list.
- Reload the page. It should be instant, since results cache for an hour.
- Switch GitHub to dark mode (Settings → Appearance). Creatures should still be legible.
- **Disable the extension and reload.** GitHub must look completely untouched.

### If nothing appears

Almost always the API base. Open the popup, check the API base URL setting, and confirm `curl http://localhost:3000/api/creature?user=torvalds` returns JSON. Second most likely: GitHub changed its DOM, in which case the extension injects nothing on purpose rather than breaking the page.

---

## 7. What is not done

Not bugs, deliberate calls:

- **This branch is not deployed.** The Vercel Supabase variables and schema are ready, but the adapter and cloud-restore changes remain uncommitted on `main-aufa`. A deployment verification is still required.
- **Hosted sync still has follow-up work.** Public-profile visibility enforcement, SQLite-to-Supabase data migration, and a real restart/redeploy end-to-end check remain open.
- **Not on the Chrome Web Store.** Publishing distributes Pokemon sprites under your developer identity, which is a different posture from a personal project. The `SpriteSource` abstraction exists so swapping to original art is one file.
- **Variant traits** (DESIGN.md 3.5) were dropped on purpose rather than half-built.
- **`/graph` node labels overlap** on first render. Pre-existing, from the force-layout library settling.
- **Em-dashes in your own note prose.** Flagged and left alone. That is your writing, and the no-em-dash rule targets generated UI copy.
