# ardhiqi·garden

Aufa's digital garden - a personal space to pour out ideas, document projects, and see how things connect. Not a blog. Notes are messy, projects are real, everything is linked.

Writing notes and shipping code both feed a pixel creature that evolves as the garden grows. The creature is a readout of real work, not decoration: it is computed at build time from your content and your public GitHub activity, nothing invented.

Built with Next.js 16, MDX, and a force-directed graph. Deploys to Vercel.

---

## What's inside

| Feature | How it works |
|---|---|
| **Notes & Projects** | MDX files in `content/` - write in Markdown, use React components inline |
| **Wikilinks** | `[[Note Title]]` auto-links to other notes and shows up as a backlink on the target |
| **Backlinks** | Every note shows a "Linked from" section - what else points to it |
| **Graph view** | Force-directed graph at `/graph` - nodes are notes/projects, edges are wikilinks |
| **Tags** | Add tags in frontmatter, browse at `/tags`, linked from the homepage |
| **Search** | Live full-text search across titles, descriptions, and tags at `/search` |
| **Dark mode** | Follows system preference, toggle in the navbar |
| **The creature** | A pixel specimen on the homepage and `/companions` that levels up from your writing and commits |
| **Public API** | `/api/creature` computes the same creature for any public GitHub handle |
| **README badge** | A static SVG version of the creature, embeddable anywhere Markdown renders |
| **Browser extension** | Injects creatures into GitHub repo lists, `extension/`, loads unpacked |

---

## Project structure

```
content/
├── notes/           ← short ideas, observations, learnings
│   └── *.mdx
└── projects/        ← longer writeups about things you've built
    └── *.mdx

src/
├── app/
│   ├── (pages)              ← Next.js App Router pages
│   ├── companions/             ← full evolution line, items archive
│   └── api/
│       ├── creature/         ← GET /api/creature - JSON creature state
│       └── creature.svg/     ← GET /api/creature.svg - README badge
├── components/       ← UI components (Navbar, GardenMark, graph, search, game/, etc.)
└── lib/
    ├── content.ts    ← reads and parses all MDX files
    ├── backlinks.ts  ← builds the wikilink map and backlinks
    ├── graph.ts      ← builds node/edge data for the graph
    ├── mdx.ts        ← renders MDX, extracts table of contents
    └── game/         ← the creature: XP engine, stages, items, GitHub fetch, sprites

extension/            ← Manifest V3 browser extension, self-contained
```

---

## The creature system

The creature is not a mascot bolted onto the site. It is a specimen plate showing what the garden's growth looks like: how much you've written, how densely it's linked, and how consistently you show up in commits.

### Evolution

Four stages, gated by cumulative XP. Numbers below are read directly from `src/lib/game/types.ts`, the single source of truth:

| Stage | XP threshold | What it means |
|---|---|---|
| **Sporeling** | 0 | The garden exists. A few scattered notes. |
| **Mossling** | 1,500 | Notes are accumulating and starting to link. |
| **Bracken** | 5,000 | A real body of work with dense interconnection. |
| **Heartwood** | 12,000 | An established garden. |

### XP sources

From the garden, computed at build time from `content/`:

| Event | XP |
|---|---|
| Note or project published | 100 |
| Per 100 words of body copy | 10 |
| Outgoing wikilink that resolves to a real note | 15 |
| Backlink received | 10 |
| New tag introduced | 25 |
| Note promoted from seedling to budding | 50 |
| Note promoted from budding to evergreen | 150 |

From GitHub, fetched at build time and cached to JSON:

| Event | XP |
|---|---|
| Commit to any public repo | 5, capped at 100/day |
| Commit to this garden's own repo | 10, same daily cap |

The design intent: XP rewards *connection*, not volume. Wikilinks and backlinks score well because they're evidence the garden is actually being used, not just written into. Word count is deliberately worth very little per unit, so padding a note is a poor way to level up. The daily commit cap exists so a scripted commit loop can't farm the creature either.

### Items

Alongside the stages there's a small set of unlockable items, shown as a specimen drawer: locked ones dimmed with their requirement and progress, unlocked ones shown at full color. Each item is tied to a specific milestone in either your garden (publishing, linking, tagging, reaching evergreen) or your commit activity. The exact list lives in `src/lib/game/items.ts` and is visible in full on `/companions` - it's left out of this table deliberately since it's still being tuned and would go stale here faster than the code.

---

## Setup

```bash
npm install
```

Create `.env.local` (gitignored):

```bash
GITHUB_TOKEN=your_personal_access_token
GITHUB_LOGIN=your-github-handle
```

To enable "Sign in with GitHub" (which gates sync, profiles, and the leaderboard), add:

```bash
GITHUB_CLIENT_ID=your_github_app_client_id
GITHUB_CLIENT_SECRET=your_github_app_client_secret
SESSION_SECRET=at_least_32_random_characters
```

All three are required together; with any of them missing the site runs signed out and the sign in control is hidden rather than offering a button that cannot work. Generate the secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

These come from a **GitHub App** (Settings, Developer settings, GitHub Apps), not an OAuth App. Either protocol works for login, but a GitHub App accepts several callback URLs, so `http://localhost:3000/api/auth/callback` and the deployed callback can coexist without re-registering. The app needs **no repository, organization, or account permissions**: identity comes back from `GET /user` on a bare user token, and everything else the product reads is public. Set "Where can this GitHub App be installed" to **Any account**, or nobody but you can ever sign in. Behind a proxy that rewrites the origin, set `AUTH_BASE_URL` to the public origin so the callback URL matches what is registered.

`GITHUB_TOKEN` and `GITHUB_LOGIN` are optional, but without `GITHUB_TOKEN` the build falls back to GitHub's unauthenticated public events feed, which as of this writing **undercounts real commit activity by roughly 10x**. This isn't a guess: GitHub's `PushEvent` payloads no longer reliably carry a `commits` array or even a `size` field, so the fallback path has to floor every push to "1 commit" when nothing richer is available, and a 12-commit push scores the same as a 1-commit push. A token unlocks the GraphQL contributions path instead, which returns real per-day commit counts. No scopes are required since only public data is read. `GITHUB_LOGIN` tells the site and the API which handle is "you" - it's what makes your own garden stats show up instead of a zeroed stranger's view (see "The API" below).

Then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Opening it from your phone, or showing someone else

`next dev` prints a `Network:` URL alongside the local one. That address works
from any device on the same network, and over a VPN like Tailscale you can use
the tailnet IP instead.

One thing to know, because the failure is silent: Next blocks cross-origin
requests to its `/_next/*` dev assets, allowing only the host the server
booted with. Reaching the dev server by IP without allowing that host serves
the HTML with a `200` while every JS chunk gets a `403`. The page renders and
then does nothing at all — no menu, no theme toggle, no search, and `/graph`
sits on "Loading graph." forever, because nothing hydrates.

Private ranges, including Tailscale's, are already allowed in
`next.config.ts` under `allowedDevOrigins`, so this should just work. If you
reach it from some other host, add it there and **restart** the dev server —
the config is read at boot. The dev server logs `Blocked cross-origin request`
naming the exact host to add, so check the terminal before assuming the page
is broken. This is dev-only; `next build` and `next start` ignore it.

---

## Writing content

### Add a note

1. Create a new file in `content/notes/`. The filename becomes the URL slug.

   ```
   content/notes/my-new-idea.mdx   →   /notes/my-new-idea
   ```

2. Paste this starter template and fill it in:

   ```mdx
   ---
   title: "My New Idea"
   date: "2026-04-23"
   description: "One sentence summary."
   tags: ["design", "thinking"]
   type: "note"
   ---

   Write your content here in Markdown.

   You can link to other notes with [[Note Title]].
   ```

3. Save the file. If you're running `npm run dev`, the page appears instantly at `/notes/my-new-idea`. No restarts, no registration, no config.

---

### Add a project

Same as a note but goes in `content/projects/` with `type: "project"`:

```
content/projects/my-project.mdx   →   /projects/my-project
```

```mdx
---
title: "My Project"
date: "2026-04-23"
description: "What this project is about."
tags: ["web", "tools"]
type: "project"
---

Write about what you built, why you built it, what you learned.
```

---

### Update existing content

Open any `.mdx` file in `content/notes/` or `content/projects/`, edit it, save. That's it - changes reflect immediately in dev mode, and on the next deploy in production.

To update the date when you revise a note, just change the `date` field in the frontmatter.

---

### Rename or delete content

- **Rename:** Change the filename. The old URL will 404 - if you've shared the old link somewhere, add a redirect in `next.config.ts`.
- **Delete:** Delete the file. The page disappears on the next build.

---

### Add a cover image

1. Drop the image into `public/images/`
2. Reference it in frontmatter:

   ```mdx
   ---
   title: "My Note"
   image: "/images/my-cover.png"
   ---
   ```

   It renders as a full-width cover at the top of the page.

---

### Link notes together (wikilinks)

Use `[[Title]]` anywhere in your content to link to another note or project by its title:

```md
This idea builds on [[What Is a Digital Garden?]].
See also: [[Graph View]], [[My Project]].
```

Use `[[Target|display text]]` when you want the link text to read differently from the target's title:

```md
See [[What Is a Digital Garden?|this earlier note]] for background.
```

- The target must match the `title` field in the target's frontmatter (case-insensitive)
- The target note automatically gains a "Linked from" entry pointing back to you
- If the target doesn't exist yet, the link still renders but goes to `#` - fix it later by creating the file

---

### Add tags

Tags go in the frontmatter array. Use lowercase, keep them short:

```mdx
---
tags: ["design", "web", "thinking"]
---
```

- Tags appear as chips on cards and on the note page
- They're searchable
- Browse all tags at `/tags` or click any tag chip to filter by it
- New tags appear automatically - no registration needed

---

### Use MDX components

These are available in any note or project file without importing:

```mdx
<!-- Callout boxes -->
<Callout type="info" title="Good to know">Some text here.</Callout>
<Callout type="warning">Watch out for this.</Callout>
<Callout type="tip">Pro tip.</Callout>
<Callout type="danger">Danger zone.</Callout>

<!-- Image with optional caption -->
<Figure src="/images/photo.png" alt="Description" caption="Caption text" />

<!-- YouTube embed (use the video ID from the URL) -->
<Youtube id="dQw4w9WgXcQ" title="Video title" />
```

---

### Frontmatter reference

| Field | Required | Description |
|---|---|---|
| `title` | ✓ | Display title - also used to resolve `[[wikilinks]]` |
| `date` | ✓ | ISO date `YYYY-MM-DD` - controls sort order on the feed |
| `description` | ✓ | Short summary shown on cards and in `<meta>` tags |
| `tags` | ✓ | Array of strings, can be empty `[]` |
| `type` | ✓ | `"note"` or `"project"` - controls badge color and collection |
| `image` | - | Cover image path, e.g. `/images/cover.png` |
| `maturity` | - | `"seedling"`, `"budding"`, or `"evergreen"`. Defaults to `"seedling"` when absent. Feeds both the maturity glyph on the note and the promotion XP in the creature system |

---

## The API

`GET /api/creature?user=<github-handle>` returns that handle's creature as JSON: stage, XP, XP breakdown, items, and (for the configured owner only) full garden stats. Any other handle gets the same shape with garden stats zeroed out and items omitted, since a stranger's note count and word count are not public data this site should be handing out.

```bash
curl "http://localhost:3000/api/creature?user=octocat"
```

`GET /api/creature?user=<github-handle>&repo=<repo-name>` returns a creature driven only by that single repo's commit activity, rather than the handle's full account.

```bash
curl "http://localhost:3000/api/creature?user=octocat&repo=Hello-World"
```

Both work for **any public GitHub handle**, not just the site owner's. That's the point: it's what lets the browser extension and the README badge show a real creature for anyone.

Caching: `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400` on every response, plus an in-process cache so a burst of identical requests makes at most one GitHub call an hour per handle. If GitHub itself is unreachable or rate-limited, the endpoint serves a stale cached response (or a zero-XP fallback if nothing is cached) rather than erroring - the JSON body carries `"degraded": true` in that case, but the status stays 200.

`GET /api/creature.svg?user=<github-handle>` is the same data rendered as a static SVG badge instead of JSON, meant for embedding. See below.

---

## The README badge

`/api/creature.svg` renders the creature as a static SVG, suitable for dropping into any Markdown that renders images, including a GitHub README:

```md
![My garden creature](https://your-deployment.example.com/api/creature.svg?user=your-github-handle)
```

Add `&repo=<name>` to badge a single repo instead of the whole account, and `&theme=dark` for a variant that reads on a dark README background.

It's static, not animated, on purpose: GitHub proxies README images through its camo cache, which strips SVG animation and caches aggressively. A static image is the version that actually renders reliably everywhere. If you want it to update, add a throwaway query param (`&v=2`) to force camo to refetch.

---

## The browser extension

`extension/` is a self-contained Manifest V3 extension that injects a creature next to each repo in a GitHub user's repo list and pinned-repos grid, using the same `/api/creature` endpoint above. Its popup works as a small pokedex: your garden creature, your repo creatures, and the item drawer.

It is not published to the Chrome Web Store. To try it:

1. Open `chrome://extensions`
2. Enable Developer mode (top right)
3. Click "Load unpacked" and select the `extension/` folder
4. Visit a GitHub repo list page

If GitHub changes its page structure and the extension's selectors stop matching, it fails silently and injects nothing - it will never break the underlying GitHub page.

One neutral note on the sprites: creature art loads from PokeAPI's CDN at runtime and is never bundled into this repo or the extension.

---

## Development

```bash
npm test
```

Runs the Vitest suite, mostly XP engine and stage/threshold logic.

```bash
npx tsc --noEmit
```

Type-checks the project without emitting output.

```bash
npm run build
```

Builds for production. Every route is statically generated except `/api/creature` and `/api/creature.svg`, which are dynamic by design since they serve live data for arbitrary GitHub handles.

```bash
npm start
```

Serves the production build.

If you're picking up remaining work on the creature system, the task specs live in `tasks/*.md`, and `ROADMAP.md` has the full build plan, current status, and known gaps.

### Keeping `node:fs` (and friends) out of client bundles

Four separate times, a `'use client'` component ended up importing a Node
built-in (`fs`, `path`, `child_process`, ...) two or three modules down and
took the entire build down -- Turbopack fails the whole compilation on one
bad module, not just the offending route, and `tsc --noEmit`/`npm test` both
stay green while it happens, since neither loads the browser bundle.

`src/lib/client-bundle-safety.test.ts` guards against this. It finds every
`'use client'` file, walks its import graph (relative and `@/` imports,
following the graph transitively, not just the file's own direct imports),
and fails with the full chain (e.g.
`ConnectGarden.tsx -> repo-creature.ts -> github.ts -> node:fs`) the moment
something reachable imports `fs`, `path`, `os`, `child_process`, or
`node:crypto` (bare `crypto` is exempt -- it's ambiguous with the real
browser Web Crypto global).

If this test trips, the fix is not to remove the import -- it's to extract a
pure module with no `fs`/`path`/etc. at module scope and depend on that
instead. This project already has the pattern in four places:
`stats-from-items.ts`, `clusters-from-items.ts`, `streak.ts`, and
`pokeapi-pure.ts` each split "compute from an in-memory value" away from
"read this from disk/network", so the client-safe half can be imported on
its own.

---

## Deploying to Vercel

1. Push the repo to GitHub
2. Import it at [vercel.com](https://vercel.com)
3. Set `GITHUB_TOKEN` and `GITHUB_LOGIN` as environment variables in the Vercel project settings
4. Vercel auto-detects Next.js - no extra configuration needed
5. Every push to `main` triggers a new deploy

---

## Tech stack

- **[Next.js 16](https://nextjs.org)** - App Router
- **[Tailwind CSS v4](https://tailwindcss.com)** - styling
- **[next-mdx-remote](https://github.com/hashicorp/next-mdx-remote)** - MDX rendering
- **[gray-matter](https://github.com/jonschlinkert/gray-matter)** - frontmatter parsing
- **[rehype-pretty-code](https://rehype-pretty-code.netlify.app)** + **[shiki](https://shiki.style)** - code syntax highlighting
- **[react-force-graph-2d](https://github.com/vasturiano/react-force-graph)** - graph view
- **[next-themes](https://github.com/pacocoursey/next-themes)** - dark/light mode
- **[flexsearch](https://github.com/nextapps-de/flexsearch)** - client-side search
- **[Vitest](https://vitest.dev)** - tests for the creature/XP engine
