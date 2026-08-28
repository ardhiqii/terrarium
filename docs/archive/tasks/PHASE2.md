# Phase 2: prototype cleanup and companion model

This file used to describe the first visual prototype. Its old T17-T20 notes
are preserved in Git history. The current product direction is in
[`PRODUCT.md`](../../PRODUCT.md), with implementation work in [`PLAN.md`](../../PLAN.md).

## What Phase 2 proved

- The extension can display public creature state on GitHub.
- The website can render local and remote sprite sources.
- The existing XP engine can compute a garden snapshot.
- PokeAPI assets are usable for local prototyping, but the current species lines
  are visual combinations rather than canonical evolution families.

## What replaces the old Phase 2 scope

The next companion work is not “one creature per repository.” Repositories and
notes are sources of evidence. They can influence a first companion and future
encounter weighting, but the user owns one collection and chooses one active
companion to receive XP.

The implementation must add:

1. A guest profile and immediate starter companion.
2. A source baseline so existing history does not become retroactive XP.
3. A normalized, idempotent event ledger.
4. Per-companion XP and a quiet account-level encounter meter.
5. Persisted random encounters with duplicate-to-family-Essence conversion.
6. Provider-neutral companion definitions with real evolution paths and forms.
7. Evidence and verification labels for public activity.

## Explicitly out of scope for this phase

- Paid companions or paid random rolls.
- AI quality scoring or AI-use detection.
- Required authentication or required desktop installation.
- An Obsidian plugin.
- Uploading note contents.
- Commercial use of Pokémon names, designs, or sprites.

## Acceptance test

A new user can open the website without signing in, receive a companion, connect
or mount a source later, earn explainable XP, encounter another companion, switch
between companions without losing XP, refresh without rerolling, and see which
events are local versus GitHub-verified.
