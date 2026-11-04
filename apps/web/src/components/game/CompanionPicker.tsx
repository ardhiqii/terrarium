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

import { useCallback, useEffect, useState } from 'react'
import { loadGuestProfile, saveGuestProfile, type GuestProfile } from '@/lib/game/guest-profile'
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

  useEffect(() => {
    if (repositories) return
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
  }, [repositories])

  const repos = repositories ?? fetched

  const commit = useCallback((next: GuestProfile) => {
    if (!profileKey) return
    saveGuestProfile(window.localStorage, next, profileKey)
    setProfile(next)
    window.dispatchEvent(new Event('terrarium:guest-profile-updated'))
  }, [profileKey])

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
    return (
      <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        No tracked repos yet. Pick some under GitHub.
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
          return (
            <li
              key={repo.id}
              className="flex flex-wrap items-center justify-between gap-3 border p-3"
              style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}
            >
              <div>
                <p className="font-ui text-sm font-medium">{repo.fullName}</p>
                <p className="font-data mt-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                  {assignment
                    ? `dressed by ${definition?.name ?? assignment.companionId}`
                    : 'no companion'}
                </p>
              </div>

              {assignment ? (
                <button
                  type="button"
                  onClick={() => release(repo.id)}
                  className="ui-row font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                >
                  Take it back
                </button>
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
