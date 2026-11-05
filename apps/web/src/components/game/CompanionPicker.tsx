'use client'

/**
 * Choosing which companion is dressed onto which repository.
 *
 * WHY THE DATA LAYER LANDED FIRST: `repo-assignments.ts` owns the rule (one
 * companion per repository, each companion spent once, bounded by what you own)
 * and enforces it on read as well as write. This component only presents it. If
 * the picker had been built alongside the rule, a mis-rendered option would have
 * looked like a broken rule instead of a broken list.
 *
 * WHY A SPENT COMPANION IS SHOWN DISABLED RATHER THAN HIDDEN: a picker that lists
 * only the free companions makes the list mysteriously shrink as the user dresses
 * repositories, with no way to tell why. Showing the spent ones greyed out, with
 * the repository they are on, explains the rule by display rather than by error
 * message.
 *
 * WHY THE COUNT IS SHOWN: the bound is the product decision, and a user cannot
 * reason about "how many can I still dress" from a grid. Stating it removes the
 * need to discover it by hitting a refusal.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  GUEST_PROFILE_STORAGE_KEY,
  loadGuestProfile,
  saveGuestProfile,
  type GuestProfile,
} from '@/lib/game/guest-profile'
import { useViewerProfileKey } from '@/lib/sync/use-viewer-profile-key'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import {
  assignCompanion,
  assignmentForRepository,
  assignableCompanions,
  remainingAssignments,
  releaseRepository,
  type AssignmentRefusal,
} from '@/lib/game/repo-assignments'
import type { GithubRepository } from '@/lib/sync/github-repositories'
import { InfoDisclosure } from '@/components/ui/InfoDisclosure'
import { GUIDE_ANCHORS } from '@/lib/copy'
import SignInButton from '@/components/layout/SignInButton'
import {
  assignmentsInSync,
  DRESSED_ROW_SUFFIX,
  dressedRowState,
  repoEmptyState,
  type AssignmentKey,
  type ServerDressing,
} from '@/lib/game/dressed-repo-ui'

/**
 * Whether dressed companions show on GitHub (`/api/profile/repo-badges`).
 * `unavailable` covers signed out and a failed read: the toggle is not shown,
 * because a guest's dressing never leaves the browser anyway.
 */
type BadgeSetting = 'loading' | 'unavailable' | 'on' | 'off'

/**
 * How long to wait after a dress or take-back before pushing it to the server
 * (`PUT /api/profile/repo-assignments`). Several quick changes become one write.
 */
const PUSH_DEBOUNCE_MS = 800

/** The full current list, in the shape the route accepts. */
function assignmentsBody(profile: GuestProfile) {
  return {
    guestId: profile.guestId,
    assignments: (profile.assignments ?? []).map(({ repositoryId, referenceId, companionId, assignedAt }) => ({
      repositoryId,
      referenceId,
      companionId,
      assignedAt,
    })),
  }
}

/** Human wording for each refusal, so the user is told which rule they hit. */
const REFUSAL_TEXT: Readonly<Record<AssignmentRefusal, string>> = {
  'repository-already-dressed': 'That repository already has a companion.',
  'companion-not-owned': 'That companion is not in your collection.',
  'companion-already-spent': 'That companion is already dressing another repository.',
}

export interface CompanionPickerProps {
  /**
   * Optional pre-fetched repositories. When omitted the picker fetches the
   * VIEWER's own tracked repositories from `/api/github/repositories`.
   *
   * WHY IT FETCHES ITS OWN BY DEFAULT: the repository list that matters is the
   * viewer's, not the site owner's, and that listing depends on the viewer's
   * session. A page-level prop would have to come from a server component that
   * already knows the session, which is not where this component is mounted.
   */
  repositories?: readonly GithubRepository[]
}

export function CompanionPicker({ repositories }: CompanionPickerProps) {
  const [profile, setProfile] = useState<GuestProfile | null>(null)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [fetched, setFetched] = useState<readonly GithubRepository[]>([])
  const profileKey = useViewerProfileKey()
  const [badges, setBadges] = useState<BadgeSetting>('loading')
  const [copied, setCopied] = useState<string | null>(null)
  const [dressing, setDressing] = useState<ServerDressing>({ status: 'unknown' })
  // The guest key means signed out. `null` means not known yet: fetch nothing.
  const signedIn = profileKey !== null && profileKey !== GUEST_PROFILE_STORAGE_KEY
  const latestProfile = useRef<GuestProfile | null>(null)
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    latestProfile.current = profile
  }, [profile])

  useEffect(() => {
    // Signed out, the setting does not exist: skip the request rather than log a 401.
    if (profileKey === null) return
    if (!signedIn) {
      setBadges('unavailable')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/profile/repo-badges', { cache: 'no-store' })
        const body = response.ok ? ((await response.json()) as { enabled?: unknown }) : null
        if (!cancelled) setBadges(body ? (body.enabled === true ? 'on' : 'off') : 'unavailable')
      } catch {
        if (!cancelled) setBadges('unavailable')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profileKey, signedIn])

  /**
   * Push the browser's dressing to the stored snapshot, so the badge shows it
   * without a full sync (docs-plan/PLAN-dressed-repo-qa-fixes.md, fix 1).
   * Always the full current list: last write wins, and a take-back is a removal.
   */
  const push = useCallback(async () => {
    const current = latestProfile.current
    if (!signedIn || !current) return
    const body = assignmentsBody(current)
    setDressing({ status: 'saving' })
    try {
      const response = await fetch('/api/profile/repo-assignments', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        setDressing({ status: 'ready', server: body.assignments })
        return
      }
      const reason =
        response.status === 409
          ? ((await response.json().catch(() => ({}))) as { reason?: unknown }).reason
          : null
      if (reason === 'never-synced') setDressing({ status: 'never-synced' })
      else if (reason === 'other-profile') setDressing({ status: 'other-profile' })
      else setDressing({ status: 'error' })
    } catch {
      setDressing({ status: 'error' })
    }
  }, [signedIn])

  const schedulePush = useCallback(() => {
    if (!signedIn) return
    if (pushTimer.current) clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null
      void push()
    }, PUSH_DEBOUNCE_MS)
  }, [signedIn, push])

  useEffect(
    () => () => {
      if (pushTimer.current) clearTimeout(pushTimer.current)
    },
    [],
  )

  const setBadgeSetting = useCallback(async (enabled: boolean) => {
    const previous: BadgeSetting = enabled ? 'off' : 'on'
    setBadges(enabled ? 'on' : 'off')
    try {
      const response = await fetch('/api/profile/repo-badges', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) throw new Error(String(response.status))
      // Turning it on is when the server copy starts to matter: make sure it is current.
      if (enabled) schedulePush()
    } catch {
      setBadges(previous)
      setMessage('Could not save that setting. Try again.')
    }
  }, [schedulePush])

  const copyBadge = useCallback(async (repo: GithubRepository) => {
    const params = new URLSearchParams({ user: repo.ownerLogin, repo: repo.name })
    const markdown = `![${repo.name} companion](${window.location.origin}/api/creature.svg?${params.toString()})`
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(repo.id)
    } catch {
      setMessage('Could not copy. Your browser blocked the clipboard.')
    }
  }, [])

  const read = useCallback(() => {
    // Wait for the viewer's key. Assuming the signed-out one read a different
    // profile on a signed-in browser, so the picker listed companions the user had
    // on one page and not on another.
    if (!profileKey) return
    try {
      setProfile(loadGuestProfile(window.localStorage, profileKey))
    } catch {
      setProfile(null)
    }
    setReady(true)
  }, [profileKey])

  useEffect(() => {
    read()
    window.addEventListener('terrarium:guest-profile-updated', read)
    return () => window.removeEventListener('terrarium:guest-profile-updated', read)
  }, [read])

  // Read what the server holds once per sign-in, and catch up a dressing made
  // before this existed (or while offline) with one push.
  useEffect(() => {
    if (!signedIn || !ready) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/profile/repo-assignments', { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        const body = (await response.json()) as { synced?: unknown; guestId?: unknown; assignments?: unknown }
        if (cancelled) return
        if (body.synced !== true) {
          setDressing({ status: 'never-synced' })
          return
        }
        const local = latestProfile.current
        if (local && body.guestId !== local.guestId) {
          setDressing({ status: 'other-profile' })
          return
        }
        const server = Array.isArray(body.assignments) ? (body.assignments as AssignmentKey[]) : []
        setDressing({ status: 'ready', server })
        if (local && !assignmentsInSync(local.assignments ?? [], server)) void push()
      } catch {
        if (!cancelled) setDressing({ status: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [signedIn, ready, push])

  useEffect(() => {
    // Signed out there is no repository list to read; the empty state says why.
    if (repositories || !signedIn) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/github/repositories', { cache: 'no-store' })
        if (!response.ok) return
        const body: unknown = await response.json()
        // The endpoint returns { repositories, settings, ... }. Anything else
        // (an error envelope, a signed-out body) simply yields no options.
        const list = (body as { repositories?: unknown }).repositories
        if (!cancelled && Array.isArray(list)) setFetched(list as GithubRepository[])
      } catch {
        // Signed out, offline, or rate limited: the picker shows its empty state.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repositories, signedIn])

  const repos = repositories ?? fetched

  const commit = useCallback((next: GuestProfile) => {
    if (!profileKey) return
    saveGuestProfile(window.localStorage, next, profileKey)
    setProfile(next)
    latestProfile.current = next
    window.dispatchEvent(new Event('terrarium:guest-profile-updated'))
    schedulePush()
  }, [profileKey, schedulePush])

  const assign = useCallback(
    (repositoryId: string, referenceId: string) => {
      if (!profile) return
      const outcome = assignCompanion(profile, repositoryId, referenceId, new Date().toISOString())
      if (outcome.ok) {
        setMessage(null)
        commit(outcome.profile)
      } else {
        setMessage(REFUSAL_TEXT[outcome.reason])
      }
    },
    [profile, commit],
  )

  const release = useCallback(
    (repositoryId: string) => {
      if (!profile) return
      commit(releaseRepository(profile, repositoryId, new Date().toISOString()))
      setMessage(null)
    },
    [profile, commit],
  )

  if (!ready || !profile) return null
  // Nothing to dress with, and nothing dressed: the picker would be an empty grid.
  if (profile.collection.length === 0) return null
  if (repos.length === 0) {
    return repoEmptyState(signedIn) === 'sign-in' ? (
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Sign in to dress your repos.
        </p>
        <SignInButton variant="quiet" />
      </div>
    ) : (
      <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        No tracked repos yet. Pick some on{' '}
        <Link href="/github" className="underline underline-offset-2" style={{ color: 'var(--accent)' }}>
          GitHub
        </Link>
        .
      </p>
    )
  }

  const options = assignableCompanions(profile)
  const remaining = remainingAssignments(profile)

  return (
    <div>
      <p className="font-data text-xs uppercase tracking-widest mb-4" style={{ color: 'var(--ink-muted)' }}>
        {remaining} free {remaining === 1 ? 'companion' : 'companions'} ·{' '}
        {profile.collection.length - remaining} in use
      </p>

      {(badges === 'on' || badges === 'off') && (
        <div className="mb-5">
          <label className="font-ui flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={badges === 'on'}
              onChange={(event) => void setBadgeSetting(event.target.checked)}
            />
            Show dressed companions on GitHub
          </label>
          <InfoDisclosure label="What this shows" guide={GUIDE_ANCHORS.dressing}>
            Each dressed public repo shows its companion, stage and XP on the README badge and in
            the browser extension. Nothing else from your collection. Private repos never show.
            Changes reach GitHub within a few minutes. The first time you turn this on, it can
            take up to an hour.
          </InfoDisclosure>
        </div>
      )}

      {message && (
        <p
          role="status"
          aria-live="polite"
          className="font-prose mb-4 text-sm"
          style={{ color: 'var(--accent)' }}
        >
          {message}
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {repos.map((repo) => {
          const assignment = assignmentForRepository(profile, repo.id)
          const definition = assignment
            ? PROTOTYPE_COMPANION_CATALOG.get(assignment.companionId)
            : undefined
          const rowState = assignment
            ? dressedRowState({ badgesOn: badges === 'on', isPrivate: repo.private, assignment, dressing })
            : null
          return (
            <li
              key={repo.id}
              className="flex flex-wrap items-center justify-between gap-3 border p-3"
              style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}
            >
              <div>
                <p className="font-ui text-sm font-medium">{repo.fullName}</p>
                <p className="font-data mt-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                  {assignment && rowState
                    ? `dressed by ${definition?.name ?? assignment.companionId}${DRESSED_ROW_SUFFIX[rowState]}`
                    : 'no companion'}
                  {rowState === 'needs-first-sync' && (
                    <>
                      {' '}
                      <Link href="/github" className="underline underline-offset-2" style={{ color: 'var(--accent)' }}>
                        Sync
                      </Link>
                    </>
                  )}
                </p>
              </div>

              {assignment ? (
                <div className="flex flex-wrap gap-2">
                  {rowState === 'not-on-github' && (
                    <button
                      type="button"
                      onClick={() => void push()}
                      className="ui-row font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
                      style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                    >
                      Retry
                    </button>
                  )}
                  {badges === 'on' && !repo.private && (
                    <button
                      type="button"
                      onClick={() => void copyBadge(repo)}
                      className="ui-row font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
                      style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                    >
                      {copied === repo.id ? 'Copied' : 'Copy badge'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => release(repo.id)}
                    className="ui-row font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
                    style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                  >
                    Take it back
                  </button>
                </div>
              ) : (
                <label className="flex items-center gap-2 text-xs">
                  <span className="font-data uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                    Dress with
                  </span>
                  <select
                    defaultValue=""
                    onChange={(event) => {
                      if (event.target.value) assign(repo.id, event.target.value)
                      event.target.value = ''
                    }}
                    className="font-ui border px-2 py-1 text-xs"
                    style={{ borderColor: 'var(--rule)', background: 'var(--paper)', color: 'var(--ink)' }}
                    aria-label={`Choose a companion for ${repo.fullName}`}
                  >
                    <option value="">choose…</option>
                    {options.map((option) => {
                      const optionDefinition = PROTOTYPE_COMPANION_CATALOG.get(option.companionId)
                      const spentOn = option.assignable
                        ? null
                        : profile.assignments?.find((a) => a.referenceId === option.referenceId)?.repositoryId
                      return (
                        <option key={option.referenceId} value={option.referenceId} disabled={!option.assignable}>
                          {optionDefinition?.name ?? option.companionId}
                          {spentOn ? ` (in use)` : ''}
                        </option>
                      )
                    })}
                  </select>
                </label>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
