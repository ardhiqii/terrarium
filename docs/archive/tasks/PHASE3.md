# Phase 3: product foundation

Phase 3 turns the personal garden prototype into an offline-first companion
product. The authoritative rules are in [`PRODUCT.md`](../../PRODUCT.md). The
ordered engineering work is in [`PLAN.md`](../../PLAN.md).

## Decisions locked for the first product prototype

| Decision | Rule |
|---|---|
| First use | Guest mode. No authentication gate and no desktop requirement. |
| Starter | A companion appears immediately on the first visit. |
| First companion | Work-based weighted choice, fully random choice, or connect later. |
| History | Existing notes/GitHub history may choose identity and origin, but gives no retroactive XP. |
| Active state | One active companion receives XP; the collection can contain many. |
| Switching | Free and lossless. Every companion keeps its own XP and ledger. |
| Encounters | Activity fills a quiet meter and triggers one persisted random result. |
| Duplicates | Convert to family-specific Essence. No paid rolls in the prototype. |
| Notes | Built-in editor or mounted Markdown folder. No Obsidian plugin initially. |
| Privacy | Note contents remain local and are never uploaded by default. |
| GitHub | Optional source for verified public activity, sign-in, recovery, sync, and extension display. |
| AI | AI-assisted work is not detected or penalized. Rules reward evidence and outcomes. |
| Assets | PokeAPI is prototype-only. Marketplace assets require explicit artist licensing. |

## 3A. Guest and local sources

Build the no-account experience first. It must work offline after the initial
app load and must warn users that unsynced guest state can disappear on a new
device or cleared browser profile.

Support:

- built-in Markdown editor;
- recursive `.md` and `.mdx` folder mounting;
- Obsidian, Logseq, and ordinary Markdown folders;
- `.obsidian` and hidden-folder exclusion;
- permission-revocation recovery;
- source baseline and on-demand rescans;
- net changes rather than repeated full-file rewards.

The website scans while open or when requested. Continuous monitoring while the
browser is closed is not required for the first version.

## 3B. Event ledger and XP

Normalize local note changes and GitHub activity into stable, replay-safe events.
Apply the basic rates in `PRODUCT.md`, per-source caps, and provenance labels.
The UI must be able to answer “why did this companion gain XP?” for every point.

Test empty commits, unchanged saves, generated-only changes, tiny commit bursts,
duplicate deliveries, repeated scans, offline mode, and a large vault or many
repositories.

## 3C. Catalog and encounters

Create a provider-neutral catalog with family, progression, forms, assets,
encounter tags, rarity, license, and fallback metadata. The PokeAPI adapter can
populate a prototype catalog, but no game rule may depend directly on PokeAPI.

Implement weighted deterministic draws, persisted results, duplicate Essence,
free active-companion switching, and per-companion XP.

## 3D. GitHub identity and sync

Add optional GitHub sign-in. On first sign-in, merge a local guest ledger into a
new account. If server state already exists, merge by event ID, union the
collection, preserve per-companion XP, and make the server snapshot authoritative
after the merge.

Sync only derived state. Reject note content at the schema boundary. Public
profiles and the extension show evidence and verification status, not private
notes or a hidden quality score.

## 3E. Distribution

Update the website collection, public profile, extension, and README badge to use
the new state model. The extension reads public synced state only and never reads
local folders. The badge is static and must not imply that local note activity was
independently verified.

## 3F. Marketplace

After the core loop is fun, add a provider workflow for original artist assets:
license, attribution, progression metadata, forms, tags, rarity, previews,
moderation, versioning, and takedown. Pokémon assets must be removed before
commercial distribution.
