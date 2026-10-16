'use client'

import { useEffect, useState } from 'react'
import {
  createGuestProfile,
  getActiveCompanionSelection,
  loadGuestProfile,
  saveGuestProfile,
  type GuestCompanionAcquisition,
  type GuestProfile,
  type GuestProfileStorage,
} from '@/lib/game/guest-profile'
import {
  PROTOTYPE_COMPANION_CATALOG,
  selectStarterCompanion,
  resolveCompanionProgression,
  type CompanionDefinition,
} from '@/lib/game/companion-catalog'
import type { ProductState } from '@/lib/game/product-state'

const catalog = PROTOTYPE_COMPANION_CATALOG
const PROFILE_EVENT = 'terrarium:guest-profile-updated'

type SelectionKind = GuestCompanionAcquisition | 'account'
type OnboardingState =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: GuestProfile; companion: CompanionDefinition; xp: number; selection: SelectionKind }
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

/**
 * Compatibility helper for old callers. New users do not call this: the
 * profile is created once with an injected random starter in the domain layer.
 */
export function persistOnboardingSelection(
  profile: GuestProfile,
  acquisition: GuestCompanionAcquisition,
  companionId: string,
  timestamp: string,
): GuestProfile {
  const referenceId = `${profile.guestId}:starter`
  const hasReference = profile.collection.some((item) => item.referenceId === referenceId)
  const collection = acquisition === 'starter'
    ? profile.collection
    : hasReference
      ? profile.collection.map((item) => item.referenceId === referenceId
        ? { ...item, companionId, acquiredAt: timestamp, acquisition }
        : item)
      : [...profile.collection, {
          referenceId,
          companionId,
          acquiredAt: timestamp,
          acquisition,
        }]
  return {
    ...profile,
    activeCompanionId: companionId,
    activeSelection: {
      companionId,
      provenance: 'user',
      selectedAt: timestamp,
    },
    updatedAt: timestamp,
    collection,
  }
}

function selectionLabel(selection: SelectionKind): string {
  if (selection === 'history') return 'a migrated work history'
  if (selection === 'encounter') return 'a discovered encounter'
  if (selection === 'account') return 'your account selection'
  return 'a random base-stage starter'
}

function selectionDescription(profile: GuestProfile, selection: SelectionKind): string {
  if (selection === 'history') {
    const migratedXp = (profile.legacyCredits ?? [])
      .reduce((total, credit) => total + credit.totalXp, 0)
    return `Your existing work history is preserved at ${migratedXp.toLocaleString()} XP.`
  }
  if (selection === 'account') return 'This account companion is shared with Home and Companions.'
  return 'Progress starts at 0 XP. Your notes and repository history stay where they are.'
}

function selectionKind(profile: GuestProfile): SelectionKind {
  const selection = getActiveCompanionSelection(profile)
  if (selection.provenance === 'migration') return 'history'
  if (selection.provenance === 'user') return 'account'
  return 'starter'
}

function initialReadyState(
  profile: GuestProfile,
  xp = (profile.legacyCredits ?? [])
    .filter((credit) => credit.companionId === profile.activeCompanionId)
    .reduce((total, credit) => total + credit.totalXp, 0),
): Extract<OnboardingState, { kind: 'ready' }> {
  const companion = catalog.get(profile.activeCompanionId) ?? selectStarterCompanion(catalog, () => 0)
  return {
    kind: 'ready',
    profile,
    companion,
    xp,
    selection: selectionKind(profile),
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

export interface GuestCompanionOnboardingProps {
  initialState?: ProductState | null
  accountScoped?: boolean
}

export function GuestCompanionOnboarding({
  initialState = null,
  accountScoped = false,
}: GuestCompanionOnboardingProps) {
  const [state, setState] = useState<OnboardingState>({ kind: 'loading' })

  useEffect(() => {
    if (accountScoped) {
      if (initialState) {
        // Account state is server-authoritative; do not create or overwrite a
        // guest profile while the write surface hydrates.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState(initialReadyState(initialState.profile, initialState.activeCompanion?.xp ?? 0))
      } else {
        setState({
          kind: 'error',
          message: 'Account companion state is not synced yet. Open GitHub sync before using account XP here.',
        })
      }
      return
    }
    try {
      const storage = browserStorage()
      const timestamp = new Date().toISOString()
      const stored = loadGuestProfile(storage)
      const profile = stored ?? createGuestProfile({
        guestId: newGuestId(),
        catalog,
        random: Math.random,
        now: timestamp,
      })
      const profileWithWarning = markWarningShown(profile, timestamp)
      saveGuestProfile(storage, profileWithWarning)
      announceProfileUpdate()
      // Browser storage is an external system; initialize after hydration.
      setState(initialReadyState(profileWithWarning))
    } catch {
      setState({
        kind: 'error',
        message: 'This browser did not allow local guest storage. You can retry or continue below.',
      })
    }
  }, [accountScoped, initialState])

  const dismissWarning = () => {
    if (accountScoped || state.kind !== 'ready') return
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
  }

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

  const isWarningVisible = !accountScoped && state.profile.recoverabilityWarning.status === 'shown'

  return (
    <section className="border-y py-8" style={{ borderColor: 'var(--rule)' }}>
      <div className="flex flex-col gap-5">
        <div>
          <p className="font-data text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--ink-muted)' }}>
            {accountScoped ? 'Account companion' : 'Your companion'}
          </p>
          <h2 className="font-ui text-2xl font-semibold tracking-tight">
            {resolveCompanionProgression(state.companion, state.xp).form.name}
          </h2>
          <p className="font-prose text-sm mt-2" style={{ color: 'var(--ink-muted)' }}>
            {selectionLabel(state.selection)} · {selectionDescription(state.profile, state.selection)}
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

        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          {accountScoped
            ? 'This account projection is shared with Home and Companions. Activate another owned companion from the Companions page.'
            : 'A base-stage companion was selected for this browser and will stay with you until you activate another owned companion from the Companions page.'}
        </p>
      </div>
    </section>
  )
}
