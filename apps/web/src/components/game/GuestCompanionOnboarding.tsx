'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  createGuestProfile,
  loadGuestProfile,
  saveGuestProfile,
  type GuestCompanionAcquisition,
  type GuestProfile,
  type GuestProfileStorage,
} from '@/lib/game/guest-profile'
import {
  PROTOTYPE_COMPANION_CATALOG,
  type CompanionDefinition,
} from '@/lib/game/companion-catalog'

const catalog = PROTOTYPE_COMPANION_CATALOG
const starter = catalog.list()[0]
// The first-run choice personalizes the immediate starter reference. It does
// not award a second collection item; duplicates come from later encounters.
const ONBOARDING_REFERENCE_SUFFIX = ':starter'
const PROFILE_EVENT = 'terrarium:guest-profile-updated'

type SelectionKind = GuestCompanionAcquisition
type ReadyState = {
  kind: 'ready'
  profile: GuestProfile
  companion: CompanionDefinition
  selection: SelectionKind
}
type OnboardingState =
  | { kind: 'loading' }
  | ReadyState
  | { kind: 'error'; message: string }

function browserStorage(): GuestProfileStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  }
}

function announceProfileUpdate(): void {
  window.dispatchEvent(new Event(PROFILE_EVENT))
}

function newGuestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `guest-${crypto.randomUUID()}`
  }
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function onboardingReferenceId(profile: GuestProfile): string {
  return `${profile.guestId}${ONBOARDING_REFERENCE_SUFFIX}`
}

function existingSelection(profile: GuestProfile):
  | { acquisition: SelectionKind; companionId: string }
  | null {
  const reference = profile.collection.find(
    (item) => item.referenceId === onboardingReferenceId(profile),
  )
  return reference
    ? { acquisition: reference.acquisition, companionId: reference.companionId }
    : null
}

/** Persist one stable onboarding reference so repeated clicks stay idempotent. */
export function persistOnboardingSelection(
  profile: GuestProfile,
  acquisition: SelectionKind,
  companionId: string,
  timestamp: string,
): GuestProfile {
  const referenceId = onboardingReferenceId(profile)
  const selectionReference = {
    referenceId,
    companionId,
    acquiredAt: timestamp,
    acquisition,
  } as const
  const hasSelectionReference = profile.collection.some(
    (item) => item.referenceId === referenceId,
  )
  const collection =
    acquisition === 'starter'
      ? profile.collection
      : hasSelectionReference
        ? profile.collection.map((item) =>
            item.referenceId === referenceId ? selectionReference : item,
          )
        : [...profile.collection, selectionReference]

  return {
    ...profile,
    activeCompanionId: companionId,
    updatedAt: timestamp,
    collection,
  }
}

function selectionLabel(selection: SelectionKind): string {
  if (selection === 'history') return 'work history'
  if (selection === 'encounter') return 'a surprise draw'
  return 'the starter'
}

function chooseSurprise(): CompanionDefinition {
  const entries = catalog.list()
  return entries[Math.floor(Math.random() * entries.length)] ?? starter
}

function chooseHistory(): CompanionDefinition {
  return catalog.list().find((entry) => entry.id !== starter.id) ?? starter
}

function initialReadyState(profile: GuestProfile): ReadyState {
  const savedSelection = existingSelection(profile)
  const companion = catalog.get(savedSelection?.companionId ?? profile.activeCompanionId) ?? starter
  return {
    kind: 'ready',
    profile,
    companion,
    selection: savedSelection?.acquisition ?? 'starter',
  }
}

function markWarningShown(profile: GuestProfile, timestamp: string): GuestProfile {
  if (profile.recoverabilityWarning.status !== 'unseen') return profile
  return {
    ...profile,
    updatedAt: timestamp,
    recoverabilityWarning: {
      ...profile.recoverabilityWarning,
      status: 'shown',
      lastShownAt: timestamp,
      updatedAt: timestamp,
    },
  }
}

export function GuestCompanionOnboarding() {
  const [state, setState] = useState<OnboardingState>({ kind: 'loading' })

  useEffect(() => {
    try {
      const storage = browserStorage()
      const timestamp = new Date().toISOString()
      const stored = loadGuestProfile(storage)
      const profile = stored ?? createGuestProfile({
        guestId: newGuestId(),
        starterCompanionId: starter.id,
        now: timestamp,
      })
      const profileWithWarning = markWarningShown(profile, timestamp)
      saveGuestProfile(storage, profileWithWarning)
      announceProfileUpdate()
      // Browser storage is an external system; this initializes the client
      // view after hydration and intentionally updates local React state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(initialReadyState(profileWithWarning))
    } catch {
      setState({
        kind: 'error',
        message: 'This browser did not allow local guest storage. You can retry or continue below.',
      })
    }
  }, [])

  const persistSelection = useCallback(
    (acquisition: SelectionKind, companion: CompanionDefinition) => {
      if (state.kind !== 'ready') return
      try {
        const updatedProfile = persistOnboardingSelection(
          state.profile,
          acquisition,
          companion.id,
          new Date().toISOString(),
        )
        saveGuestProfile(browserStorage(), updatedProfile)
        announceProfileUpdate()
        setState({ kind: 'ready', profile: updatedProfile, companion, selection: acquisition })
      } catch {
        // Keep the current UI state if the browser rejects a write.
      }
    },
    [state],
  )

  const dismissWarning = useCallback(() => {
    if (state.kind !== 'ready') return
    try {
      const timestamp = new Date().toISOString()
      const profile = {
        ...state.profile,
        updatedAt: timestamp,
        recoverabilityWarning: {
          ...state.profile.recoverabilityWarning,
          status: 'dismissed' as const,
          dismissedAt: timestamp,
          updatedAt: timestamp,
        },
      }
      saveGuestProfile(browserStorage(), profile)
      announceProfileUpdate()
      setState({ ...state, profile })
    } catch {
      // Keep the warning visible if the browser rejects a write.
    }
  }, [state])

  if (state.kind === 'loading') {
    return (
      <section className="border-y py-8" style={{ borderColor: 'var(--rule)' }} aria-busy="true">
        <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
          Preparing your local companion…
        </p>
      </section>
    )
  }

  if (state.kind === 'error') {
    return (
      <section className="border-y py-8" style={{ borderColor: 'var(--rule)' }}>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>{state.message}</p>
      </section>
    )
  }

  const isWarningVisible = state.profile.recoverabilityWarning.status === 'shown'

  return (
    <section className="border-y py-8" style={{ borderColor: 'var(--rule)' }}>
      <div className="flex flex-col gap-5">
        <div>
          <p className="font-data text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--ink-muted)' }}>
            Your companion
          </p>
          <h2 className="font-ui text-2xl font-semibold tracking-tight">{state.companion.name}</h2>
          <p className="font-prose text-sm mt-2" style={{ color: 'var(--ink-muted)' }}>
            {selectionLabel(state.selection)} · Progress starts now. Your notes and repository history stay where they are.
          </p>
        </div>

        {isWarningVisible && (
          <div className="flex items-start justify-between gap-4 border p-4" style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}>
            <p className="font-ui text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              You are in guest mode. This progress is stored in this browser and can be lost if browser data is cleared or you change devices. Sign in or export a backup when recovery matters.
            </p>
            <button
              type="button"
              onClick={dismissWarning}
              className="font-data shrink-0 text-[10px] uppercase tracking-widest"
              style={{ color: 'var(--ink-muted)' }}
            >
              Dismiss
            </button>
          </div>
        )}

        <div>
          <p className="font-ui text-sm font-medium mb-3">Choose how to personalize it</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => persistSelection('history', chooseHistory())}
              className="font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--ink)', color: 'var(--ink)' }}
            >
              Let my work decide
            </button>
            <button
              type="button"
              onClick={() => persistSelection('encounter', chooseSurprise())}
              className="font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
            >
              Surprise me
            </button>
            <button
              type="button"
              onClick={() => persistSelection('starter', starter)}
              className="font-ui text-xs px-3 py-2 border transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
            >
              Connect later
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
