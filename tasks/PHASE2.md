# Phase 2

Phase 1 built the system. Phase 2 fixes what is broken and turns it into something with actual play in it.

Four tasks. T17 first, because a broken extension makes everything else moot.

---

## The name

You left this to me. My pick: **Terrarium**.

A terrarium is a sealed little world you tend and observe. It holds plants *and* small creatures, which is exactly this product: a garden you grow, with things living in it. It works as a noun ("my terrarium"), it is concrete rather than abstract, and it is not another SaaS-sounding coinage.

"Digital Garden" is a category, not a name. Every one of these projects is a digital garden, so it is unsearchable and says nothing about the creature system. Terrarium says both halves at once.

Wordmark stays lowercase with the accent separator, matching the current treatment: `terrarium`, or `terra.rium` if the dot device is worth keeping. One line in `src/lib/site-config.ts`.

---

## T17. Extension: NOT BROKEN, cancelled

Confirmed working on a live GitHub profile. Badges render right-aligned in each repo row
("Mossling L2" beside `linux`), and the console shows every repo resolving from cache with zero
network calls, which is exactly the intended batching behaviour.

The apparent failure was the popup panel overlaying the right-hand column where the badges sit.
The empty sprite box in the popup was the pre-load state, before pressing Load.

**Two lessons worth keeping:**
1. The silent-failure design made a *working* system look broken, because there was no positive
   signal either. Consider a single "injected N creatures" debug line on success, not just on error.
2. Verify against a screenshot of the actual surface before writing a fix plan. This nearly cost a
   full agent run chasing a bug that did not exist.

---

## T18. Brand: name, wordmark, favicon

Depends on T17 only for ordering, not technically.

**The favicon is too detailed to read at 16px.** The 11x11 pixel sprout has one-pixel features that disappear entirely in a browser tab, which is why it currently looks like a smudge on a white square.

Rules for a favicon that works:
- **Three shapes maximum.** At 16px there is no room for a stem, two leaves, a bud, and a ground line.
- Fill the frame. The current mark floats in the middle of a paper square with heavy margin, wasting most of the pixels.
- High contrast against both light and dark browser chrome.
- Design it **at 16px first**, then scale up. Designing at 180px and shrinking is how you get a smudge.

Suggested direction: a single bold sprout glyph, or just the bud shape in accent on a solid ground, at roughly 3 pixels of margin. Test at actual size in a real tab before declaring it done.

Also update: `src/lib/site-config.ts` (name and wordmark), `icon.tsx`, `apple-icon.tsx`, `GardenMark.tsx`, README.

---

## T19. Multiple creatures

The interesting one, and the architecture already supports most of it.

**The insight:** repo creatures already exist. T6 built `/api/creature?user=X&repo=Y`, and every repo already computes its own creature from that repo's commit activity. What is missing is that they are all **the same four species**, so a collection of them is a collection of identical Oddishes.

**Confirmed live.** On `github.com/torvalds?tab=repositories`, all twelve repos render the identical
badge: "Mossling L2". Twelve repos, one creature. That screenshot is the entire argument for this
task, and it is also why this matters more than the graph or the favicon: the collection is the
product, and right now there is no collection.

**What to build:**

1. **Species assignment.** Map a repo's characteristics onto a different PokeAPI species, deterministically, so the same repo always gives the same creature. Reasonable inputs: primary language, repo age, commit cadence, size. Language is the most legible one, a Rust repo and a Python repo should visibly differ.

   Deterministic means hash the repo identity, do not randomise. A creature that changes on refresh is not a collection.

2. **Widen the species pool.** Currently four hardcoded ids in `STAGE_TO_POKEMON_ID`. This needs evolution *lines*, so a repo's creature still evolves through stages as its XP grows. Grass lines are the obvious start, and the pool should be data, not scattered constants.

   Keep the ids at 649 or below. Animated sprites only exist for generations 1 to 5.

3. **The collection view.** `/bestiary` currently shows one line of four. It should show every creature you have, which repos produced them, and which stage each has reached. This is the pokedex, and it is the reason to come back.

4. **Extension popup** should show the collection, not a single creature.

**Design constraint that must hold:** the garden creature stays the *main* one, driven by notes plus all commits. Repo creatures are the collection around it. Do not flatten those into one undifferentiated list, or writing notes stops mattering and the whole garden premise dies.

---

## T20. Redesign the graph

`/graph` is currently the stock `react-force-graph-2d` look: labels overlapping on load, no visual hierarchy, physics still settling while you look at it.

**Problems to fix:**
- Labels collide on first render. Hide labels below a zoom threshold, or show them only on hover and for high-degree nodes.
- No hierarchy. Every node is the same size and colour. Node size should carry backlink count, so hubs are visible at a glance.
- No sense of place. Notes and projects are indistinguishable.
- It settles visibly. Pre-warm the simulation before first paint so it opens composed rather than writhing.

**Design language:** it must match the archive theme. One accent, neutral everything else, sharp edges. Colour should encode something real (maturity, or type), never decoration. Read `DESIGN.md` before touching it.

**Worth considering:** the graph is the best argument for a digital garden over a blog, and right now it is the ugliest page. It deserves to be the showpiece.

---

## Order

```
T17  fix the extension        <- blocking, do first
T18  brand and favicon        <- small, independent
T19  multiple creatures       <- the big one
T20  graph redesign           <- independent, parallel-safe with T19
```

T18 can run alongside T17. T19 and T20 are parallel-safe with each other.
