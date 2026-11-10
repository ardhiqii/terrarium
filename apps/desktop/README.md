# Terrarium desktop companion

Your Terrarium companion, walking along the top of the Windows taskbar. A Tauri 2 app; the plan is `docs-plan/PLAN-living-companion.md` §6.

## Run it

Needs Node, Rust (`rustup`) and the Visual Studio C++ Build Tools.

```powershell
cd apps/desktop
npm install
npm run dev
```

The first build compiles Rust and takes a few minutes. If `cargo` is "not found", the terminal predates the Rust install: restart it, or run `$env:Path += ";$env:USERPROFILE\.cargo\bin"` first.

`npm run build` makes an installer under `src-tauri/target/release/bundle/nsis/`.

## How it works

- The window is transparent, frameless and always on top, stretched across the primary monitor's work area just above the taskbar. It ignores the mouse except over the companion, its bubble, and the settings form.
- First run asks for a GitHub username and a repository. The app reads `GET /api/creature?user=&repo=`, the public payload behind the README badge, and shows the dressed companion when there is one, otherwise the repo's automatic companion. The choice is made by `GardenCreatures.creatureDisplay` from `apps/extension/common/core.js`, copied into `src/vendor/` before every dev run and build (`scripts/sync-core.mjs`), so the desktop, the extension and the badge agree.
- The request is made from Rust (`fetch_creature`), because the API does not send CORS headers for the webview's origin. Only `https://` addresses, or `http://localhost`, are accepted.
- Tray menu: Open Terrarium, Change companion…, Refresh, Quiet mode (hide), Quit.

## Not yet

Sign-in, background sync, local git-watch reactions, hiding while a fullscreen app is focused, and taskbars on other edges or monitors.

## Tests

Movement logic is pure (`src/walker.js`) and runs with the repo's Vitest suite:

```powershell
npx vitest run apps/desktop
```
