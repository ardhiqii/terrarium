# Companion Migration Fixture

**Status:** T0 complete. This fixture is the migration contract for the companion integration.

**Migration namespace:** `legacy-creature:v1`

This is a deterministic test fixture, not a claim about every user's historical data. It prevents UI totals from being added together and gives T1/T2 one exact contract to implement.

## Input

### Legacy garden state

```ts
const legacyStats = {
  noteCount: 10,
  projectCount: 0,
  totalWords: 500,
  resolvedWikilinks: 10,
  backlinksReceived: 11,
  tagCount: 1,
  maturityCounts: {
    seedling: 9,
    budding: 0,
    evergreen: 1,
  },
  maxBacklinksOnSingleNote: 3,
  firstPublishedAt: '2026-08-01T00:00:00.000Z',
  lastPublishedAt: '2026-08-27T00:00:00.000Z',
}

const legacyGithub = {
  login: 'fixture-user',
  totalCommits: 3,
  commitsByDay: {
    '2026-08-26': 2,
    '2026-08-27': 1,
  },
  gardenCommitsByDay: {},
  currentStreakDays: 2,
  fetchedAt: '2026-08-27T23:59:00.000Z',
}
```

The legacy calculation is:

```text
Notes/projects:       10 * 100 = 1000
Words:                 5 * 10  =   50
Wikilinks:            10 * 15  =  150
Backlinks:            11 * 10  =  110
Tags:                  1 * 25  =   25
Budding promotions:    1 * 50  =   50
Evergreen promotions:  1 * 150 =  150
                              --------
Garden total:                    1535

GitHub commits:        3 * 5   =   15
                              --------
Legacy total:                    1550
```

The legacy projection is therefore:

```text
stage: Mossling
xpIntoStage: 50
xpForNextStage: 3500
progress: 50 / 3500
```

Legacy stats have no stable source-event IDs. The migration must not pretend that tags, backlinks, maturity counts, or the aggregate total are replayable normalized product events.

### Product state

```text
guestId: guest-migration-fixture

collection:
- guest-migration-fixture:starter -> pikachu-family, acquisition starter

activeCompanionId: pikachu-family

product events:
- built-in-editor:guest-notes:note-11
  companion: pikachu-family
  category: new-note
  provenance: local
  XP: 25

- github:github-account%3A42:pr-101
  companion: pikachu-family
  category: merged-pull-request
  provenance: verified
  XP: 25
  proof: preserved

encounters:
- meter: 61
- totalProgress: 61
- draws: []
- processedTriggerIds: []
- essenceByFamily: {}

source baselines, checkpoint, and proof records: preserved
```

Product XP before migration is `Pikachu = 50`.

## Expected migrated state

```text
migrationVersion: legacy-creature:v1

collection:
- original Pikachu starter reference
- migration:legacy-creature:v1:grass-family -> grass-family, acquisition history

activeCompanionId: grass-family

legacy credit:
- creditId: migration:legacy-creature:v1:grass-family
- companionId: grass-family
- totalXp: 1550
- sourceFingerprint: stable fingerprint of the legacy input

per-companion XP:
- grass-family: 1550
  stage: Mossling
  xpIntoStage: 50
  xpForNextStage: 3500
- pikachu-family: 50

ledger:
- same event IDs
- same companion owners
- same provenance, caps, metadata, and proofs

encounters:
- byte-for-byte unchanged
```

The active projection is **1550 XP**, not `1550 + 50`. Pikachu retains its historical `50 XP`; future events follow the active companion.

## Algorithm

1. Recompute legacy XP from the validated legacy stats and GitHub snapshot. Never trust a rendered total or stage.
2. Create one versioned legacy credit under `legacy-creature:v1` with a stable source fingerprint.
3. Add one Grass/Mossling history reference if the migration reference is absent.
4. Preserve all existing product events, proofs, caps, baselines, checkpoints, and encounter state.
5. Do not convert unsupported legacy signals into normalized product events.
6. Keep explicitly Pikachu-owned product events on Pikachu. Only events carrying explicit legacy-default ownership evidence may be rebound, and verified GitHub events cannot be rebound client-side because their proof binds the companion ID.
7. Activate Grass for this fixture because Pikachu is the untouched starter. A deliberately selected active companion must win for later profiles once selection provenance exists.
8. Do not call encounter advancement during migration.
9. Persist profile, legacy credit, ledger, encounters, and migration marker atomically. Keep a recovery copy until the write succeeds.
10. On retry, the existing migration credit/reference makes the operation a no-op.

## Required assertions

- Garden arithmetic returns `1535`; commit arithmetic returns `15`; total is `1550`.
- `resolveStage(1550)` returns Mossling with `50 / 3500` local progress.
- Collection contains Pikachu plus one Grass history reference.
- Grass is active; Pikachu remains at `50 XP`.
- No projection reports `1600 XP` for the active companion.
- Event IDs, owners, provenance, caps, metadata, proofs, baselines, checkpoints, and encounters remain unchanged.
- Applying migration twice changes nothing the second time.
- Replaying the two product events changes neither XP nor encounters.
- A new event while Grass is active awards XP only to Grass.
- After switching to Pikachu, a new event awards XP only to Pikachu.
- A serialize/restore/snapshot round trip preserves the legacy credit and Grass's `1550 XP`.
- A persistence failure before the migration marker restores the original state and allows a clean retry.

## Implementation consequence

The product model needs a persisted, versioned legacy-credit field. Adding `1550` only to a rendered companion object is incorrect because `ProductState` currently recomputes XP from the normalized event ledger and snapshot restore ignores rendered `companions[].xp`.
