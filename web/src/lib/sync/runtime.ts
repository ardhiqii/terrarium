/**
 * Test-only in-memory `SyncStore`.
 *
 * T28's real implementations (`sqlite-store.ts`'s `SqliteSyncStore` /
 * `getSyncStore()`, `session.ts`'s `StubSessionProvider` / `getSessionProvider()`)
 * landed while this task was in progress, so every T29 surface
 * (`/u/[handle]`, `/leaderboard`, the Navbar) imports those directly rather
 * than going through a stand-in here. This file now exists purely so T29's
 * own tests can exercise `SyncStore`-shaped logic (e.g. building a
 * leaderboard from a set of `SyncedUser` rows) without touching the real
 * `node:sqlite`-backed store, per the task's "build an in-memory fake for
 * your tests" instruction.
 */
import type { SyncedUser, SyncStore } from './types'

/**
 * In-memory implementation of `SyncStore`, for tests. Handles are matched
 * lowercased, mirroring the rule the real store also follows, since GitHub
 * logins are case-insensitive.
 */
export class InMemorySyncStore implements SyncStore {
  private readonly users = new Map<string, SyncedUser>()

  async put(user: SyncedUser): Promise<void> {
    this.users.set(user.handle.toLowerCase(), user)
  }

  async get(handle: string): Promise<SyncedUser | null> {
    return this.users.get(handle.toLowerCase()) ?? null
  }

  async getMany(handles: string[]): Promise<SyncedUser[]> {
    const out: SyncedUser[] = []
    for (const handle of handles) {
      const user = this.users.get(handle.toLowerCase())
      if (user) out.push(user)
    }
    return out
  }

  async remove(handle: string): Promise<void> {
    this.users.delete(handle.toLowerCase())
  }

  /** Synchronous seed helper, test-only. */
  seedSync(user: SyncedUser): void {
    this.users.set(user.handle.toLowerCase(), user)
  }
}
