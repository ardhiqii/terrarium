# How work gets run

Three ways to execute a task from `ROADMAP.md`. They mix freely.

## 1. Tell the orchestrator here (default)

You say "run group A" in this session. The orchestrator (Opus) spawns Sonnet subagents, one per task, reviews what comes back, sends feedback, and iterates until the work passes.

Use for: parallel work, anything needing review, most things.

Cost shape: expensive model plans and reviews, cheap model writes code. Planning and review are where judgment is needed and they are a small fraction of the tokens. Code generation is the bulk and it is the part a cheaper model does fine **when the spec is exact**.

## 2. A fresh session per task

Open a new Claude Code session and say: **"Read ROADMAP.md and tasks/T5.md, then do T5."**

Use for: picking work up on another day, a task big enough to want its own full context, or when you want to drive it yourself.

This works only because the specs are on disk. A new session has no memory of this conversation. `ROADMAP.md`, `DESIGN.md`, `tasks/*.md`, and `src/lib/game/types.ts` are the shared memory, which is why they are written to be read cold.

## 3. Background agents

Long-running work you check back on later. Same as option 1, but you are not waiting.

---

## The review loop

This is the part that makes cheap models safe.

```
  spec (Opus)
      │
      ▼
  implement (Sonnet subagent)
      │
      ▼
  automated gates ── fail ──┐
      │ pass               │
      ▼                    │
  review (Opus)  ── reject ─┤
      │ accept             │
      ▼                    │
   merged            feedback to
                     same agent ──┘
```

**Automated gates** run before a human or Opus looks at anything. A task is not eligible for review until:

```
npx tsc --noEmit      # zero errors
npm run build         # passes
npm test              # passes, once tests exist
```

**Opus review** then checks the things a compiler cannot:
- Does it match the spec, or did it solve a different problem
- Contract drift: did it duplicate a type instead of importing from `types.ts`
- Failure paths: does every external call have one that returns instead of throwing
- Design rules: em-dashes, accent lock, both themes, reduced motion
- Did it silently narrow scope and report success

**Feedback** goes back to the *same* subagent, which keeps its full context and fixes rather than restarting cold. Restarting loses everything it learned.

---

## Why specs are written the way they are

A cheaper model succeeds or fails on spec quality. Four things decide it:

1. **Exact file paths.** Never "put it somewhere sensible."
2. **Exact signatures.** The interface is given, not invented. This is what stops two parallel agents from building incompatible things.
3. **A runnable done-when.** A command that passes or fails, not a vibe.
4. **An explicit do-not-touch list.** This is what makes parallel execution safe.

Anything genuinely ambiguous gets decided in the spec, or the agent is told to stop and ask rather than guess.

---

## The gap worth closing

**This project has no tests.** Every gate today is `tsc` plus `build`, which catches type errors and nothing about behaviour. The XP engine is pure functions over fixed inputs, which is the easiest possible thing to test and the highest value to lock down, since silent XP math changes are exactly the kind of bug that survives a build.

Recommended: add Vitest and cover `xp.ts`, `stages.ts`, and `items.ts` before the surface tasks land. Roughly one task's worth of work, and it upgrades every future review from reading code to running a suite.
