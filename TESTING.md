# How to test this

Everything below you can run yourself. Start with the automated layer, since it takes seconds and covers the most.

---

## 1. Automated (30 seconds)

```bash
npm test            # 208 tests across 12 files
npx tsc --noEmit    # type check, should print nothing
npm run build       # production build
```

All three should pass with no output-worthy errors. If `npm test` drops below 208, something regressed.

### Are the tests any good?

```bash
npm run test:mutation
```

This runs Stryker, which deliberately introduces bugs into the XP engine and checks whether the tests notice. A "survived" mutant is a bug your tests would miss.

Report opens at `reports/mutation/mutation.html`.

Current: **70.69%** across 7 modules. Do not chase 100%. A large share of survivors are provably equivalent mutants, meaning no input can distinguish them, and a good chunk of the rest are blanked display strings the suite intentionally does not assert. `reports/mutation/mutation.html` shows exactly which.

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
| `/bestiary` | Four stages, unreached ones greyed with "Not yet reached", XP thresholds visible |
| `/notes`, `/projects` | **No creature UI at all.** Reading surfaces stay clean, that separation is deliberate |
| `/graph` | Force graph renders and is draggable |

Then toggle **dark mode** in the navbar and walk the same pages. Both themes are supposed to hold up.

### Reduced motion

This one is easy to get wrong, so it is worth checking. In Chrome DevTools: `Ctrl+Shift+P`, run "Show Rendering", set **Emulate CSS prefers-reduced-motion** to `reduce`, then reload `/bestiary`.

The creature should go **completely still**. A CSS media query cannot pause a GIF, so this works by swapping to a static PNG. If it still moves, that fix broke.

---

## 3. The API

With the dev server running:

```bash
# Your creature: garden XP plus commit XP
curl "http://localhost:3000/api/creature?user=ardhiqii"

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
curl "http://localhost:3000/api/creature.svg?user=ardhiqii" -o badge.svg
```

Open `badge.svg` in a browser. You should see the sprite, name, stage, and XP bar.

It is **static by design**. GitHub proxies README images through its camo cache, which strips SVG animation, so an animated badge would simply not animate for anyone else.

To use it once deployed:

```markdown
![My creature](https://YOUR-DOMAIN/api/creature.svg?user=ardhiqii)
```

---

## 5. The extension

**This is the only part no test covers.** Its logic is unit tested, but nothing verifies it renders on a real GitHub page. That check needs you.

1. Make sure the dev server is running on **port 3000**. The extension defaults to `http://localhost:3000`, so it shows nothing if the API is on a different port.
2. Chrome → `chrome://extensions/`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select the `extension/` folder in this repo
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

## 6. What is not done

Not bugs, deliberate calls:

- **Not deployed.** Everything runs locally. Until it is on Vercel and the extension points at a public origin, none of it works for anyone but you.
- **Not on the Chrome Web Store.** Publishing distributes Pokemon sprites under your developer identity, which is a different posture from a personal project. The `SpriteSource` abstraction exists so swapping to original art is one file.
- **Variant traits** (DESIGN.md 3.5) were dropped on purpose rather than half-built.
- **`/graph` node labels overlap** on first render. Pre-existing, from the force-layout library settling.
- **Em-dashes in your own note prose.** Flagged and left alone. That is your writing, and the no-em-dash rule targets generated UI copy.
