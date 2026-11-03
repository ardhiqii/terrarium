'use client'

/**
 * The storage key for the current viewer's product profile.
 *
 * WHY A HOOK AND NOT A CONSTANT: the key depends on who is signed in, which only the
 * server knows. Five surfaces read a profile and four of them hard-coded the
 * signed-out key, so a signed-in user saw one active companion on `/github` and a
 * different one everywhere else.
 *
 * WHY `null` MEANS "NOT YET KNOWN": the session arrives after the first paint (the
 * endpoint is deliberately uncached so it can never serve one visitor's identity to
 * another). A component that guessed the signed-out key before the answer arrived
 * would read the wrong profile for a moment and, worse, might write to it. Callers
 * must wait for a non-null key.
 *
 * WHY THE FETCH IS SHARED: the navbar badge, the picker, and the runtime can all be
 * on screen at once. A module-level promise means they make one request between
 * them rather than one each.
 */

import { useEffect, useState } from 'react'
import { GUEST_PROFILE_STORAGE_KEY, loadGuestProfile, saveGuestProfile } from '@/lib/game/guest-profile'
import {
  browserProductStorage,
  ensureBrowserGuestProfile,
  loadBrowserEncounters,
  loadBrowserLedger,
  loadRevealedDraws,
  saveBrowserEncounters,
  saveBrowserLedger,
  saveRevealedDraws,
} from '@/lib/game/product-browser-storage'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { claimDailyDraw, isDailyDrawDue } from '@/lib/game/daily-draw'
import { layEggs } from '@/lib/game/companion-eggs'
import { planGuestMigration } from '@/lib/game/guest-migration'
import { namespaceFromProfileKey } from '@/lib/sync/viewer-profile-key'

export interface ViewerSession {
  signedIn: boolean
  handle: string | null
  avatarUrl: string | null
  /** The finished localStorage key for this viewer. Always present. */
  profileKey: string
  configured: boolean
}

let inFlight: Promise<ViewerSession | null> | null = null

/**
 * Make sure the viewer has a profile, and claim today's draw for showing up.
 *
 * WHY THIS IS HERE AND NOT IN `/write`: the draw used to be claimed inside
 * `GuestProductRuntime`, which is mounted on exactly one route. So the daily reward for
 * "coming back" only existed for a user who happened to open the editor — and a user who
 * landed on `/companions`, the page that LISTS the eggs, found no egg, no badge, and no
 * profile at all. Measured: a fresh browser on `/companions` had nothing; one visit to
 * `/write` produced the egg. Landing on the wrong page decided whether the day counted,
 * which is the same defect the guest import had before it moved to this resolver.
 *
 * This runs on every route because the navbar calls `startViewerSession`, and it runs
 * before any surface is handed the key, so no reader can see the pre-draw state.
 *
 * Idempotent twice over: `ensureBrowserGuestProfile` returns the existing profile, and
 * `claimDailyDraw` refuses a day already in `processedTriggerIds`. A replay is a no-op
 * rather than a second egg.
 */
function ensureViewerHasProfileAndDailyDraw(profileKey: string): void {
  if (typeof window === 'undefined') return
  // NO signed-out guard here, deliberately. `namespaceFromProfileKey` returns undefined
  // for the guest key, which is exactly right: a signed-out visitor is the DEFAULT case,
  // and it is the one that must still get a profile and a daily egg. The guard belongs in
  // the migration, which has no account to import into; the draw has no such problem.
  try {
    const storage = browserProductStorage()
    const namespace = namespaceFromProfileKey(profileKey)
    const profile = ensureBrowserGuestProfile(
      storage,
      PROTOTYPE_COMPANION_CATALOG.list()[0].id,
      namespace,
    )

    const encounters = loadBrowserEncounters(storage, namespace)
    if (!isDailyDrawDue(encounters, new Date())) return

    const claimed = claimDailyDraw(
      encounters,
      new Date(),
      PROTOTYPE_COMPANION_CATALOG,
      profile.collection.map((entry) => entry.companionId),
    )
    if (!claimed.claimed) return

    saveBrowserEncounters(storage, claimed.state, namespace)
    // The draw becomes an EGG, not a collection entry, so an unhatched companion does
    // not count toward the assignment bound.
    const withEggs = layEggs(profile, claimed.newDraws, new Date().toISOString())
    saveGuestProfile(storage, withEggs, profileKey)
    // Tells the navbar badge and every mounted runtime that the inventory changed.
    window.dispatchEvent(new Event('terrarium:guest-profile-updated'))
  } catch {
    // A browser that refuses storage gets no draw. That is the honest result, and it is
    // better than a thrown error taking down the navbar on every page.
  }
}

/**
 * Carry the signed-out encounter state into the account namespace.
 *
 * WHY THE PROFILE ALONE WAS NOT ENOUGH: the profile holds the collection and the eggs,
 * but NOT which days have been claimed. That lives in the encounter state, under its own
 * key with its own namespace. Moving only the profile left the account looking at an
 * empty encounter state, and an empty encounter state says today is unclaimed. So a user
 * who drew their daily companion while signed out and then signed in was handed a SECOND
 * draw for the same day, under a different key, with no indication that anything was
 * wrong. The meter and the revealed-draw list reset with it, so the dismissed reveal
 * cards came back and progress toward the next draw was lost.
 *
 * The guest copy is left in place. It is a few kilobytes, the signed-out key is the
 * source of truth for nothing else, and leaving it means a failed profile write can still
 * be retried on the next visit.
 */
function migrateEncounterStateIntoAccount(profileKey: string): void {
  const storage = browserProductStorage()
  // The sibling keys are namespaced by the account id, NOT by the profile key:
  // `product-browser-storage` appends the namespace itself. Passing the whole profile key
  // here wrote `terrarium:guest-encounters:terrarium:guest-profile:github-123`, a key no
  // surface reads, so the state looked empty and today's draw was handed out twice.
  const namespace = namespaceFromProfileKey(profileKey)
  const guestEncounters = loadBrowserEncounters(storage)
  const accountEncounters = loadBrowserEncounters(storage, namespace)

  // Union the claimed days rather than overwrite: whichever side has claimed a day keeps
  // it claimed. Taking only the guest's would forget days the account already claimed and
  // hand back a draw it had spent; taking only the account's is the bug this fixes.
  const claimed = new Set([
    ...accountEncounters.processedTriggerIds,
    ...guestEncounters.processedTriggerIds,
  ])
  // Draws are keyed on their stable id, and their order is preserved, so the account's
  // own draws stay first. A draw for a day that is already claimed on either side is kept
  // rather than dropped: it is the record of an egg the user may still be holding.
  const byId = new Map(accountEncounters.draws.map((draw) => [draw.id, draw]))
  for (const draw of guestEncounters.draws) {
    if (!byId.has(draw.id)) byId.set(draw.id, draw)
  }

  saveBrowserEncounters(
    storage,
    {
      // The furthest-along meter wins: resetting it would throw away progress toward the
      // next draw, which is the more visible loss of the two.
      meter: Math.max(accountEncounters.meter, guestEncounters.meter),
      totalProgress: Math.max(accountEncounters.totalProgress, guestEncounters.totalProgress),
      nextSequence: Math.max(accountEncounters.nextSequence, guestEncounters.nextSequence),
      draws: [...byId.values()],
      processedTriggerIds: [...claimed],
      essenceByFamily: { ...guestEncounters.essenceByFamily, ...accountEncounters.essenceByFamily },
    },
    namespace,
  )

  // Revealed draws are a dismissal list, so the union is exactly right: a card dismissed
  // on either side stays dismissed.
  const revealed = new Set([
    ...loadRevealedDraws(storage, namespace),
    ...loadRevealedDraws(storage),
  ])
  saveRevealedDraws(storage, [...revealed], namespace)

  // The ledger is the XP record. Union by event id, because `mergeProductEvents` already
  // keys on it and a duplicate would be counted once anyway.
  const accountLedger = loadBrowserLedger(storage, namespace)
  const guestLedger = loadBrowserLedger(storage)
  const seen = new Set(accountLedger.events.map((event) => event.eventId))
  const merged = [
    ...accountLedger.events,
    ...guestLedger.events.filter((event) => !seen.has(event.eventId)),
  ]
  if (merged.length !== accountLedger.events.length) {
    saveBrowserLedger(storage, { events: merged }, namespace)
  }
}

/**
 * Carry a signed-out profile into the account, once, before any surface reads it.
 *
 * WHY THIS RUNS HERE AND NOT IN A PAGE COMPONENT: the migration was first wired into
 * `/write` only, so signing in from the navbar while on `/github` never imported
 * anything. `/github` then called `ensureBrowserGuestProfile`, found nothing under the
 * account key, and created a fresh starter, while the real profile sat untouched under
 * the signed-out key. Landing on the wrong page decided whether a user kept their
 * companions.
 *
 * This hook already resolves the key on every page and shares one request, so doing the
 * import here means it runs once, from wherever the user lands, before any reader can
 * look in the wrong place.
 *
 * WHY IT IS IDEMPOTENT: the guest key is removed after the import, so a later call finds
 * nothing to import. A failed write leaves the guest key in place, which is the safe
 * direction: the next visit retries rather than losing the data.
 *
 * Exported for tests: this is the only function that performs BOTH destructive writes,
 * and the partial-failure path (profile written, cleanup not yet done) is the one that can
 * strand two live profiles. A test has to be able to drive it twice.
 */
export function migrateGuestProfileIntoAccount(profileKey: string): void {
  if (typeof window === 'undefined') return
  // Signed out: there is no account to import into, and clearing the guest key would
  // throw the user's progress away.
  if (profileKey === GUEST_PROFILE_STORAGE_KEY) return

  try {
    const storage = window.localStorage
    const guestProfile = loadGuestProfile(storage, GUEST_PROFILE_STORAGE_KEY)
    if (!guestProfile) return
    const accountProfile = loadGuestProfile(storage, profileKey)

    if (!accountProfile) {
      // PRODUCT.md 4.4: no server profile yet, so import the current companion
      // condition and collection. A straight copy under the account key, not a merge.
      saveGuestProfile(storage, guestProfile, profileKey)
    } else {
      const plan = planGuestMigration(guestProfile, accountProfile)
      if (!plan) {
        // Same identity: the account key already holds this profile, so there is no
        // profile to move. The encounter state still might need moving, and the guest key
        // must STILL be cleared — because "the account already holds this identity" is
        // also exactly what a half-finished migration leaves behind: the profile was
        // written, then the process died or `removeItem` threw before the cleanup. This
        // branch is the only thing that can ever finish that job, and returning here
        // without removing left two live profiles, so the next sign-out read the stale
        // one. That is the failure this whole module exists to prevent.
        migrateEncounterStateIntoAccount(profileKey)
        storage.removeItem(GUEST_PROFILE_STORAGE_KEY)
        window.dispatchEvent(new Event('terrarium:guest-profile-updated'))
        return
      }
      saveGuestProfile(storage, plan.profile, profileKey)
    }
    migrateEncounterStateIntoAccount(profileKey)
    storage.removeItem(GUEST_PROFILE_STORAGE_KEY)
    // Tell every mounted surface to re-read, since the profile they hydrated from has
    // just been superseded.
    window.dispatchEvent(new Event('terrarium:guest-profile-updated'))
  } catch {
    // A failed import leaves the guest profile exactly where it was. Losing it to a
    // cleanup path would be worse than showing the account's copy for one visit.
  }
}

/** Fetch the session once per page load; later callers share the same promise. */
function fetchSession(): Promise<ViewerSession | null> {
  inFlight ??= (async () => {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) return null
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') return null
      const record = body as Record<string, unknown>
      if (typeof record.profileKey !== 'string' || record.profileKey.length === 0) return null
      const profileKey = record.profileKey
      // Before anyone is handed this key.
      migrateGuestProfileIntoAccount(profileKey)
      // After the import, never before: a signed-out guest who already claimed today
      // must not be handed a second egg by the move into their account.
      ensureViewerHasProfileAndDailyDraw(profileKey)
      return {
        signedIn: record.signedIn === true,
        handle: typeof record.handle === 'string' ? record.handle : null,
        avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : null,
        profileKey,
        configured: record.configured === true,
      }
    } catch {
      // Offline or the endpoint is unreachable. No key is the honest answer; a
      // component falling back to the signed-out key could read the wrong profile.
      return null
    }
  })()
  return inFlight
}

/** Test seam: forget the cached request so a suite can stub a different session. */
export function resetViewerSessionForTests(): void {
  inFlight = null
}

/**
 * The viewer's profile key, or `null` until it is known.
 *
 * Waits for the answer rather than assuming, because writing to the wrong key is
 * silent data loss rather than a visible error.
 */
export function useViewerProfileKey(): string | null {
  const [key, setKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchSession().then((session) => {
      if (cancelled) return
      // A settled request with no session means nobody is signed in, or the endpoint
      // is unreachable. Either way the signed-out key is the one to read: returning
      // `null` here would leave a caller waiting forever on a key that never arrives,
      // and a caller that waits forever renders a spinner instead of the profile the
      // user already has. `null` now means strictly "not resolved yet".
      setKey(session ? session.profileKey : GUEST_PROFILE_STORAGE_KEY)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return key
}

/**
 * Resolve the viewer's key and run the guest import, outside React.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE HOOK: the import must happen on whichever page the
 * user lands on. Routing it through a component made it depend on that component being
 * mounted: the navbar badge is rendered inside the nav rows, and on a phone the nav row
 * holding it only exists once the hamburger menu is opened. A user signing in on a phone
 * would never have migrated.
 *
 * Called once from `AppShell`, which is mounted on every route.
 */
export function startViewerSession(): void {
  void fetchSession()
}

/**
 * The same request, awaitable.
 *
 * WHY A CALLER NEEDS THIS: `/github` hydrates with `ensureBrowserGuestProfile`, which
 * CREATES a profile when the account key is empty. Run against a key the import has not
 * written yet, it invents a fresh starter and the user's real companions are orphaned
 * under the signed-out key. Awaiting the session guarantees the import has finished
 * before anything is allowed to create a blank profile.
 *
 * Resolves to null when the session is unreachable; callers must still handle that
 * rather than assuming a key.
 */
export function ensureViewerSession(): Promise<ViewerSession | null> {
  return fetchSession()
}
