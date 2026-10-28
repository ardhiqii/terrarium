# Design: note maturity history (and what it makes auditable)

Status: **proposal, not built.** Written before any code so the data-model decisions can be
reviewed first.

## 1. The problem, in the code's own words

`apps/web/src/lib/game/xp.ts` (lines 17-23) admits it:

> `promoted-budding` / `promoted-evergreen` are derived from the current maturity snapshot
> rather than a historical event log, since nothing in this codebase records *when* a note
> changed maturity, only what it is now. A note currently `evergreen` is treated as having
> passed through the budding promotion on its way there... This is a **cumulative-credit
> reading of a snapshot, not a literal replay of history**.

Three consequences follow, and only the first is cosmetic:

1. No growth graph is possible. There is no timeline to plot.
2. XP earned from promotions cannot be attributed to a day, so it cannot be audited.
3. **A downgrade silently erases XP.** Set a note back from `evergreen` to `seedling` and the
   promotion XP disappears with no record that it was ever awarded. Nothing is wrong with the
   arithmetic; there is simply no history to replay.

## 2. Why there is no history

`MarkdownFileSummary` (`scan-summary-store.ts`) is the persisted memory of the previous scan,
and it does **not** carry maturity:

```
path · hash · words · links · linkTargets · modifiedAt
```

`normalizeMarkdownEvents` diffs current files against those summaries. With no maturity on the
previous side, "did this note's maturity change" is not a question the diff can answer. So
promotions are recomputed from the current snapshot every time instead.

Maturity itself is **authored frontmatter** (`types.ts`: "Optional in frontmatter; absent means
`seedling`"), set by the user, not derived by the app.

## 3. The gap is one field, and adding it is allowed

Adding `maturity` to `MarkdownFileSummary` is what unlocks the diff. Section 4.2 of
`PRODUCT.md` rules out persisting note contents, and the summary is deliberately content-free
("this function cannot read an old note's text even in principle").

Maturity does not violate that. It is a **label the user wrote**, the same class of data as
`linkTargets` — already persisted for exactly the same reason: a set/side comparison needs the
value, and a count cannot reconstruct it. It is a word from a fixed three-value vocabulary,
not prose.

## 4. What exists and is reusable

- **The event ledger** (`events.ts`) already carries timestamped, deduplicated events with a
  provenance (`local` / `verified`), a cap key, and XP rates per category. Nine categories
  exist; **none is a promotion.**
- **XP-over-time is already derivable** for ledger events, because they carry `occurredAt`.
  The promotion entries are the only XP in the model that cannot be dated.
- **The diff machinery exists** — `normalizeMarkdownEvents` already compares links, words and
  hashes against summaries and emits normalized events with stable IDs.

So this is not a new subsystem. It is one field on an existing summary plus one event category.

## 5. Three coupling points that make it more than a one-liner

1. **The summary is persisted and unversioned.** `terrarium:markdown-scan-summaries` holds
   summaries with no `schemaVersion`. A new field must be **optional on read and defaulted on
   load**, so an existing stored summary stays valid. A read that throws would wipe the scan
   memory and re-award `new-note` for the whole vault.
2. **Two XP paths, and only one can be dated.**
   - `computeGardenXp(stats)` — snapshot-based. Feeds the `/write` XP display
     (`EditorPane`) *and* creature staging (`repo-creature.ts`). This is where the promotion
     entries live.
   - the event ledger — event-based, fed by scans and GitHub.
   Moving promotion XP to the ledger therefore touches **staging numbers**, not just a label.
3. **The history has to survive the guest and account paths.** The scan summary and the ledger
   are both carried through the guest→account transition and the product sync. The new field
   must survive both, and a guest who later signs in must not be awarded the same promotion
   twice.

## 6. Options

### Option A — record the history, leave XP alone (recommended first step)

Add `maturity` to the summary; when the diff sees a change, emit a dated
`promoted-maturity` event carrying the from/to values. Keep `computeGardenXp` as it is.

- **Gets:** a real timeline, a growth graph, and an audit trail that can be compared against
  what the snapshot claims. Downgrades become visible instead of silent.
- **Does not get:** XP itself replayed from history. The snapshot stays the XP source, so
  "the claim" is still cumulative-credit — but now it is *checkable*.
- **Risk:** low. Nothing that currently computes a number changes behaviour.

### Option B — history becomes the XP source

Everything in A, plus `computeGardenXp`'s promotion entries are replaced by the ledger's
promotion events.

- **Gets:** promotions are truly replayed, and a downgrade no longer erases earned XP.
- **Costs:** existing users have no history, so their promotions need a **migration decision**:
  seed the log from the current snapshot (grandfathering today's claim, which preserves the
  cumulative-credit reading once and then freezes it), or start empty and let already-earned
  promotion XP vanish. Staging numbers move for anyone mid-ladder.

### Option C — A plus reconciliation

A, plus a comparison surface that reports where the snapshot's promotion claim disagrees with
the log. Useful once the log has real data; premature before it does.

**Recommendation: A now, and decide B once the log has a few weeks of real promotions in it.**
A is the foundation either way and cannot be wasted work; B is the one with a migration
decision that deserves to be made against real data rather than in the abstract.

## 7. Shape of the change, as built

Status: **built** (option A). Four points where this differs from the sketch above, all in the
direction of correctness.

- **The event is `maturity-changed`, not `promoted-maturity`.** A downgrade is not a promotion, and
  this event records both directions. Metadata carries `path`, `from`, `to`.
- **A missing maturity means "not observed", NOT `seedling`.** This is the OPPOSITE of what section
  6 said, and it is the difference between working and re-baselining the whole vault. Summaries
  written before the field existed must load with `maturity` absent, and the diff must skip the
  comparison entirely. Defaulting to `seedling` would emit a change for every already-evergreen
  note on the first scan after deploy, and making the missing field fatal would discard every
  stored summary and re-award `new-note` for every note. Both failure modes have a test.
- **`occurredAt` comes from the scan's trusted clock, not `file.modifiedAt`.** Every other content
  event in `markdown-events.ts` dates itself from mtime, and this one must not: the event is
  cap-free, and `budgetDayOf` in `events.ts` falls back to `occurredAt` for a cap-free event, so a
  user-settable mtime would inject a forged day into the daily budget. A history is also worthless
  if its timestamps are chosen by the thing being audited.
- **The event ID carries both content hashes** (`path:fromHash:toHash:to`), so a repeated
  transition after a round trip is a distinct event, while replaying the same transition is a
  no-op. Keying on `to` alone (or `from`+`to`) would collapse the repeat and turn a history into a
  set.

`'maturity-changed': 0` in `XP_BY_EVENT_CATEGORY`, and no `cap`. The zero is the contract of
option A: history is recorded, nothing is paid.

## 8. Test list

- a stored summary with no `maturity` loads and is treated as `seedling`, not as a change;
- a note that goes `seedling -> budding` emits one event, dated from the trusted clock;
- a note that goes `evergreen -> seedling` emits one event, so a downgrade is recorded;
- a first scan of a folder emits **no** promotion events for any starting value;
- replaying the same scan is a no-op (idempotent by event ID);
- a promotion survives the guest→account path exactly once.

## 9. Not in scope

- Changing what XP a promotion is worth (`XP_RATES`).
- Rendering the graph in this change; the timeline is the prerequisite for it.
- Recording per-note content, which `PRODUCT.md` 4.2 forbids and this design does not need.
