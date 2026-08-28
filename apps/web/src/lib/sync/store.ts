/**
 * The single place that decides which `SyncStore` implementation the app uses.
 *
 * WHY THIS FILE EXISTS
 * The deploy plan (ROADMAP, "What is left") says swapping SQLite for a hosted
 * database is "one adapter file". That was not true before this module: three
 * callers (`api/sync/route.ts`, `leaderboard/page.tsx`, `u/[handle]/page.tsx`)
 * imported `getSyncStore` directly from `./sqlite-store`, so a swap meant
 * editing every call site and hoping none were missed. They now import from
 * here, and this is the only file that names a concrete store.
 *
 * WHY THE SWAP MATTERS
 * `SqliteSyncStore` writes to disk (`.data/sync.db` by default). Serverless
 * platforms give a function an ephemeral, per-invocation filesystem, so a
 * write from one request is invisible to the next and gone entirely when the
 * instance recycles. The store is not broken there; it is silently useless,
 * which is worse. Anything deployed to Vercel and friends needs a store that
 * talks to a real database over the network.
 *
 * HOW TO ADD ONE
 * `SyncStore` (`./types.ts`, frozen) is four async methods: `put`, `get`,
 * `getMany`, `remove`. Write `postgres-store.ts` (or `turso-store.ts`)
 * implementing them, then extend `selectStore()` below to return it. Two rules
 * the SQLite store follows and any replacement must too:
 *
 *   1. Lowercase every handle before it touches storage. GitHub logins are
 *      case-insensitive, so `Torvalds` and `torvalds` are one row, not two.
 *   2. `getMany` skips handles that have never synced rather than erroring.
 *      The leaderboard asks about everyone a user follows and expects most of
 *      them to be absent.
 *
 * A NOTE ON BUNDLING
 * The import below is static, so `node:sqlite` is still pulled into any build
 * that reaches this module. That is correct today, when SQLite is the only
 * implementation. When a second one lands, make the branch in `selectStore()`
 * use a dynamic `await import(...)` of the losing branch, or the serverless
 * bundle will carry a `node:sqlite` dependency it can never use. This module
 * is server-only either way; `client-bundle-safety.test.ts` walks the import
 * graph and fails the suite if a client file ever reaches it.
 */

import type { SyncStore } from './types'
import { getSyncStore as getSqliteStore } from './sqlite-store'

/**
 * Picks the implementation. One branch today, which is the honest state of
 * things: there is exactly one store and no environment variable can change
 * that yet. The selection lives in a function anyway so adding a branch is a
 * local edit rather than a restructure.
 */
function selectStore(): SyncStore {
  return getSqliteStore()
}

/**
 * The store every route handler and server component should use.
 *
 * Import this, never `./sqlite-store` directly. The one sanctioned exception
 * is `sqlite-store.test.ts`, which tests that implementation specifically.
 */
export function getSyncStore(): SyncStore {
  return selectStore()
}

export type { SyncStore }
