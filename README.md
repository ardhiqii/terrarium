# ardhiqi·garden

Aufa's digital garden — a personal space to pour out ideas, document projects, and see how things connect. Not a blog. Notes are messy, projects are real, everything is linked.

Built with Next.js 16, MDX, and a force-directed graph. Deploys to Vercel as a fully static site.

---

## What's inside

| Feature | How it works |
|---|---|
| **Notes & Projects** | MDX files in `content/` — write in Markdown, use React components inline |
| **Wikilinks** | `[[Note Title]]` auto-links to other notes and shows up as a backlink on the target |
| **Backlinks** | Every note shows a "Linked from" section — what else points to it |
| **Graph view** | Force-directed graph at `/graph` — nodes are notes/projects, edges are wikilinks |
| **Tags** | Add tags in frontmatter, browse at `/tags`, linked from the homepage |
| **Search** | Live full-text search across titles, descriptions, and tags at `/search` |
| **Dark mode** | Follows system preference, toggle in the navbar |

---

## Project structure

```
content/
├── notes/           ← short ideas, observations, learnings
│   └── *.mdx
└── projects/        ← longer writeups about things you've built
    └── *.mdx

src/
├── app/             ← Next.js App Router pages
├── components/      ← UI components (Navbar, GardenMark, graph, search, etc.)
└── lib/
    ├── content.ts   ← reads and parses all MDX files
    ├── backlinks.ts ← builds the wikilink map and backlinks
    ├── graph.ts     ← builds node/edge data for the graph
    └── mdx.ts       ← renders MDX, extracts table of contents
```

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

Open any `.mdx` file in `content/notes/` or `content/projects/`, edit it, save. That's it — changes reflect immediately in dev mode, and on the next deploy in production.

To update the date when you revise a note, just change the `date` field in the frontmatter.

---

### Rename or delete content

- **Rename:** Change the filename. The old URL will 404 — if you've shared the old link somewhere, add a redirect in `next.config.ts`.
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

- The title must match the `title` field in the target's frontmatter (case-insensitive)
- The target note automatically gains a "Linked from" entry pointing back to you
- If the target doesn't exist yet, the link still renders but goes to `#` — fix it later by creating the file

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
- New tags appear automatically — no registration needed

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
| `title` | ✓ | Display title — also used to resolve `[[wikilinks]]` |
| `date` | ✓ | ISO date `YYYY-MM-DD` — controls sort order on the feed |
| `description` | ✓ | Short summary shown on cards and in `<meta>` tags |
| `tags` | ✓ | Array of strings, can be empty `[]` |
| `type` | ✓ | `"note"` or `"project"` — controls badge color and collection |
| `image` | — | Cover image path, e.g. `/images/cover.png` |

---

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Building for production

```bash
npm run build
npm start
```

## Deploying to Vercel

1. Push the repo to GitHub
2. Import it at [vercel.com](https://vercel.com)
3. Vercel auto-detects Next.js — no extra configuration needed
4. Every push to `main` triggers a new deploy

---

## Tech stack

- **[Next.js 16](https://nextjs.org)** — App Router, static export
- **[Tailwind CSS v4](https://tailwindcss.com)** — styling
- **[next-mdx-remote](https://github.com/hashicorp/next-mdx-remote)** — MDX rendering
- **[gray-matter](https://github.com/jonschlinkert/gray-matter)** — frontmatter parsing
- **[rehype-pretty-code](https://rehype-pretty-code.netlify.app)** + **[shiki](https://shiki.style)** — code syntax highlighting
- **[react-force-graph-2d](https://github.com/vasturiano/react-force-graph)** — graph view
- **[next-themes](https://github.com/pacocoursey/next-themes)** — dark/light mode
