/**
 * Session providers (see `SessionProvider` in `./types.ts`, frozen) plus the
 * selection logic every caller should go through: `getSessionProvider()`.
 *
 * No GitHub OAuth app exists yet (see `tasks/PHASE3.md`), so
 * `StubSessionProvider` reads the signed-in handle from an environment
 * variable instead of a real login flow. It exists purely so the sync
 * layer, profiles, and leaderboard are all testable before OAuth is wired
 * up; a real `GithubSessionProvider` will implement the same interface and
 * drop in without touching a single caller.
 *
 * THIS IS NOT AUTHENTICATION. Anyone who can set an environment variable on
 * the server can "sign in" as anyone. That is fine for local dev and CI, and
 * would be a severe vulnerability in production. A code comment saying so is
 * not an adequate guard on its own -- comments get skimmed, copy-pasted
 * around, and ignored under deadline pressure -- so the refusal below is
 * enforced in code: `getSessionProvider()` throws rather than silently
 * handing back a stub the moment `NODE_ENV === 'production'`, and
 * `StubSessionProvider`'s own constructor throws too, so even a caller that
 * bypasses the selector and imports the class directly cannot construct one
 * in a production process.
 */

import type { Session, SessionProvider } from './types'

/**
 * Deterministic, non-cryptographic hash of a handle, used only to give the
 * stub's `Session.githubId` a stable-looking number instead of a random one
 * that changes every call. Never used for anything security-sensitive.
 */
function fakeGithubId(handle: string): number {
  let hash = 0
  for (let i = 0; i < handle.length; i++) {
    hash = (hash * 31 + handle.charCodeAt(i)) | 0
  }
  // Force positive; GitHub ids are always positive integers.
  return Math.abs(hash) || 1
}

export class StubSessionProvider implements SessionProvider {
  readonly id = 'stub' as const

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'StubSessionProvider must never run in production. It reads the ' +
          "signed-in handle from an env var with no real authentication. " +
          'Configure a real SessionProvider (GitHub OAuth) before deploying.'
      )
    }
  }

  /**
   * Reads `STUB_SESSION_HANDLE` fresh on every call rather than caching it at
   * construction time, so a developer (or a test) can flip who they are
   * "signed in as" without restarting the process.
   */
  async current(): Promise<Session | null> {
    const raw = process.env.STUB_SESSION_HANDLE
    if (!raw || raw.trim().length === 0) return null
    const handle = raw.trim().toLowerCase()
    return {
      handle,
      githubId: fakeGithubId(handle),
      avatarUrl: null,
    }
  }
}

/**
 * The one function every route handler should call. Selects the stub in
 * every non-production environment (nothing else exists yet); refuses
 * outright in production rather than falling back to the stub, since a
 * silent fallback there would mean anyone can sign in as anyone by setting
 * an env var on the server.
 *
 * Once a real GitHub OAuth provider exists, it plugs in here: production
 * resolves to it, everything else keeps resolving to the stub (or the real
 * provider too, if a developer wants to test against real GitHub locally).
 * No caller of `getSessionProvider()` needs to change.
 */
/**
 * Always signed out. What production gets until GitHub OAuth exists.
 *
 * Refusing the stub in production is correct: it reads the handle from an env
 * var, so shipping it would let anyone sign in as anyone. But THROWING was the
 * wrong refusal. `layout.tsx` reads the session at the root, so a throw during
 * static prerendering failed `npm run build` outright and the site could not be
 * built at all.
 *
 * Signed-out is the safe answer, not an absent one: no session means no sync,
 * no leaderboard, and no profile actions, while every public page still
 * renders. Fail closed, not broken.
 */
class SignedOutSessionProvider implements SessionProvider {
  readonly id = 'github' as const
  async current(): Promise<Session | null> {
    return null
  }
}

export function getSessionProvider(): SessionProvider {
  if (process.env.NODE_ENV === 'production') {
    return new SignedOutSessionProvider()
  }
  return new StubSessionProvider()
}
