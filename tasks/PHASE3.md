# Phase 3: Terrarium as a product

Phases 1 and 2 built a personal garden with a creature system. This phase turns it into something another developer can use without cloning a repo.

---

## Decisions locked

These were argued through and settled. Do not relitigate them mid-build; if one turns out to be wrong, say so explicitly and stop.

| Decision | Why |
|---|---|
| **Notes are plain markdown files on the user's disk** | Portable, git-friendly, openable in Obsidian or any editor. No lock-in. |
| **Folder access via the File System Access API** | The site reads and writes a real folder the user picks. Nothing uploads. Chromium only, which is acceptable since the extension is Chrome-only already. |
| **A built-in editor is required** | Not everyone uses Obsidian, and "install another app first" is a bad first run. |
| **Notes NEVER leave the device** | Gardens are half-diary. Uploading them by default creates a privacy problem, an unbounded storage cost, and a moderation burden. |
| **Sync carries derived state only** | Stage, XP, companions, counts. A few hundred bytes per user. Friends see the creature, not the writing. |
| **Auth is GitHub OAuth** | The audience all have GitHub, the handle is already the identity, and you never touch passwords. |
| **Leaderboard is friends-only, using the GitHub following graph** | A global board would be farmed by bots within a week. Friend-scoped removes the incentive, makes cheating socially visible, and needs no friend-request UI. |
| **Multi-device is the user's own cloud folder or git** | Dropbox, iCloud, or a repo. Solves the two-laptop case completely for zero infrastructure. |
| **Mobile is read-only** | The File System Access API does not exist on mobile browsers. Creature renders, writing does not. |
| **Companions come from bodies of work, XP from activity** | A repo past a threshold or a tag cluster of 5+ notes hatches one. Everything else is XP. Automatic thresholds, never a per-note choice. |

---

## Phase 3A: Connect a folder

**No server. Works entirely offline.**

The user clicks "connect garden", picks a directory, and the app reads every `.md` and `.mdx` in it, computes their creature and clusters **client-side**, and renders it.

Why this is cheap: `src/lib/game/` is already pure TypeScript over content, with no React and no server dependency. `stats.ts`, `xp.ts`, `stages.ts`, `clusters.ts`, and `species-assign.ts` can run unchanged in a browser. The only new work is a content source that reads from a directory handle instead of the filesystem.

- Persist the directory handle (IndexedDB) so reconnecting does not re-prompt.
- Detect and handle permission revocation without a crash.
- **Non-Chromium browsers must degrade, not break.** Show the commits-only creature and explain why.
- Any markdown folder works: an Obsidian vault, a Logseq graph, a plain folder. They are all just markdown.

## Phase 3B: The editor

**Still no server.**

Notion-feel WYSIWYG that serialises to plain markdown. The user should never see `**asterisks**`. Use a real editor library rather than a textarea; verify current versions rather than trusting anyone's memory of them.

Must do all of:
- **Create** with frontmatter as form fields (title, tags, maturity), not raw YAML
- **List** every note with tags and maturity
- **Edit** existing notes
- **Delete**, actually removing the file
- **Rename** — and this is the trap: rewrite every `[[Old Title]]` in the garden, or renaming silently breaks the graph, backlinks, and XP. Obsidian does this; yours must too.
- **`[[` autocomplete** over existing notes. Nearly free, and without it people do not link enough, which is the whole mechanic.

**Hard constraint:** output must be openable in Obsidian tomorrow. Standard frontmatter, plain markdown, no proprietary extensions.

Worth considering: show live XP as they write ("+100 note, +40 words, +30 links"). It puts the game at the moment of writing, which is where engagement actually lives.

## Phase 3C: Accounts, sync, profiles, leaderboard

**This is where a server first appears.** Do not start it until 3A and 3B have real use.

- **GitHub OAuth.**
- **Sync endpoint** taking the derived snapshot only. Reject anything resembling note content at the schema level, so a future change cannot quietly start collecting it.
- **Public profile** at `/u/<handle>`: creature, stage, XP, companions.
- **Leaderboard** scoped to people the user follows on GitHub who also use Terrarium. Read the following list from the GitHub API; build no friend-request system.
- **Verification asymmetry, be honest about it.** Commit XP can be verified server-side against public GitHub data. Garden XP cannot, since notes are local. Friends-only scope makes this tolerable. If a global board ever appears, this becomes a real problem and needs solving first.
- Extension reads profiles so creatures appear on GitHub for synced users.

Storage stays tiny: one row per user holding a JSON snapshot.

## Phase 3D: Desktop app

A **viewer**, not an editor. Taskbar Hero shape: small always-on-top window, creature reacts as you work.

- Points at the same local folder, computes with the same engine, works offline.
- No folder configured? Fall back to the public API by GitHub handle.
- No note editing. Writing happens in the web editor or Obsidian.

Largest remaining piece: packaging, signing, auto-update. The engine reuse makes it far cheaper than starting cold, but it is still a second application.

## Phase 3E: The guide

Users cannot see the rules, so the game is invisible. Needs a page explaining what earns XP and at what rate, the four stages and thresholds, how companions hatch, and what items unlock.

Pull every number from `src/lib/game/types.ts` at build time rather than hardcoding, so it cannot drift.

---

## Order and honest cost

```
3A  connect folder      small, no server, unlocks everything else
3B  editor              medium, no server, the rename/wikilink case is the hard part
3E  guide               small, worth doing early since it makes the game legible
3C  accounts + sync     large, and the first ongoing operational cost
3D  desktop app         largest, a second application
```

3A and 3B are the ones that make Terrarium usable by someone who is not you. 3C is what makes it social. 3D is what makes it delightful. In that order.

**Before any of this: deploy.** The site is finished and running on localhost. The extension points at `localhost:3000`, so nothing works for anyone else, and the README badge cannot be used in a real README. Everything above assumes a deployed origin exists.
