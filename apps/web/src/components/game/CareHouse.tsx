'use client'

/**
 * The House: the companion's terrarium, and the only screen where it is cared for.
 *
 * WHY THIS IS A CLIENT ISLAND INSIDE A SERVER PAGE: the guest profile and the
 * event ledger live in `localStorage` (`PRODUCT.md` §4.2 — nothing about a
 * guest's activity leaves the browser), so the room cannot be rendered on the
 * server. It renders nothing until it has read storage rather than flashing an
 * empty room at a user who has a companion.
 *
 * WHY THE LOGIC IS NOT IN THIS FILE: every number here comes from
 * `lib/game/care`, which is pure, tested, and knows nothing about React. This
 * component's whole job is to read storage, call the care layer, and draw the
 * result. That is what lets a desktop overlay or a hardware device reuse the
 * same rules without importing a single Tailwind class.
 *
 * ACCESSIBILITY (`PRODUCT.md` §11): every object in the room is a real <button>
 * with a label, every target is at least 44 px, every meter names what it
 * counts in text, and nothing animates — so "reduced motion" needs no special
 * case here rather than being handled badly by a media query.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyCareAction,
  buildCareReadout,
  deriveCareSignals,
  streakLength,
  type CareActionKind,
  type CareDialogueKey,
  type CareItemKind,
  type CareNeeds,
  type CareScene,
} from '@/lib/game/care'
import { createCareState } from '@/lib/game/care'
import {
  activeCollectionReference,
  loadGuestProfile,
  saveGuestProfile,
  type GuestProfile,
} from '@/lib/game/guest-profile'
import {
  browserProductStorage,
  loadBrowserLedger,
} from '@/lib/game/product-browser-storage'
import type { EventLedger } from '@/lib/game/events'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { resolveCompanionSprite } from '@/lib/game/companion-sprite'
import { useViewerProfileKey } from '@/lib/sync/use-viewer-profile-key'
import RemoteSprite from '@/components/game/RemoteSprite'

/** The offset east of UTC, as the care layer expects it. */
function viewerOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

const DIALOGUE_COPY: Readonly<Record<CareDialogueKey, string>> = {
  idle: 'Sitting quietly, watching the room.',
  greeting: 'Looks up at you.',
  focused: 'Deep in work, ears forward.',
  curious: 'Sniffing at something new.',
  excited: 'Bouncing on the spot.',
  resting: 'Curled up and breathing slowly.',
  sleepy: 'Eyes half closed.',
  unwell: 'Moving slowly. Something is wrong.',
  hungry: 'Looking at the food bowl, then at you.',
  dormant: 'Resting until you are back.',
  'welcome-back': 'Wakes up and stretches.',
}

/** The object an action is performed through, in the order the room draws them. */
const OBJECTS: readonly {
  action: CareActionKind
  label: string
  hint: string
}[] = [
  { action: 'feed', label: 'Food bowl', hint: 'Feed' },
  { action: 'play', label: 'Toy', hint: 'Play' },
  { action: 'sleep', label: 'Bed', hint: 'Rest' },
  { action: 'clean', label: 'Bath', hint: 'Clean' },
  { action: 'heal', label: 'Medicine shelf', hint: 'Heal' },
]

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  dormant: 'It is dormant. A day of real work will wake it.',
  'no-item': 'Nothing in the cupboard for that yet.',
  'not-measured': 'That is not measured yet, so there is nothing to fix.',
  'not-needed': 'Nothing to do — that need is already full.',
}

const ACTION_COPY: Readonly<Record<CareActionKind, string>> = {
  feed: 'Ate one meal.',
  play: 'Played for a while.',
  sleep: 'Rested. The late-night tally is cleared.',
  clean: 'Tidied up.',
  heal: 'Took its medicine.',
  pet: 'Leaned into your hand.',
}

/** Singular copy for one unit of each item. */
const ITEM_LABEL: Readonly<Record<CareItemKind, string>> = {
  food: 'meal',
  treat: 'treat',
  medicine: 'medicine',
  toy: 'toy',
  soap: 'soap',
}

/** Plural copy, because "meals" and "medicine" do not pluralize the same way. */
const ITEM_LABEL_PLURAL: Readonly<Record<CareItemKind, string>> = {
  food: 'meals',
  treat: 'treats',
  medicine: 'medicine',
  toy: 'toys',
  soap: 'soap',
}

/**
 * One meter.
 *
 * The caption is not decoration: `PRODUCT.md` §11.1 requires a number to name
 * what it counts, and "Health — 100" alone would be a claim with no evidence.
 * A `null` need renders as "not measured yet" instead of a full bar, because a
 * full bar is an assertion and there is nothing behind this one.
 */
function Meter({
  label,
  value,
  caption,
}: {
  label: string
  value: number | null
  caption: string
}) {
  const measured = value !== null
  return (
    <div>
      <div className="font-data flex items-baseline justify-between gap-3 text-xs">
        <span>{label}</span>
        <span style={{ color: 'var(--ink-muted)' }}>
          {measured ? `${Math.round(value)} of 100` : 'not measured'}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full"
        style={{ background: 'var(--rule)' }}
        role={measured ? 'meter' : 'img'}
        aria-label={`${label}, ${measured ? `${Math.round(value!)} of 100` : 'not measured yet'}`}
        aria-valuenow={measured ? Math.round(value!) : undefined}
        aria-valuemin={measured ? 0 : undefined}
        aria-valuemax={measured ? 100 : undefined}
        aria-valuetext={measured ? `${Math.round(value!)} of 100` : 'not measured yet'}
      >
        <div
          className="h-full"
          style={{
            width: measured ? `${Math.min(100, Math.max(0, value!))}%` : '0%',
            background: measured ? 'var(--accent)' : 'transparent',
            opacity: measured ? 1 : 0,
          }}
        />
      </div>
      <p className="font-data mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        {caption}
      </p>
    </div>
  )
}

function meterCaptions(
  needs: CareNeeds,
  scene: CareScene,
): { label: string; value: number | null; caption: string }[] {
  return [
    {
      label: 'Hunger',
      value: needs.hunger,
      caption:
        needs.hunger === 100
          ? 'Fed today, or worked today'
          : needs.hunger === 0
            ? 'Has not eaten in days'
            : `${Math.round((100 - (needs.hunger ?? 0)) / 25)} days since the last meal`,
    },
    {
      label: 'Energy',
      value: needs.energy,
      caption:
        scene.mood === 'resting'
          ? 'Recovering from a rest'
          : 'Falls with late-night sessions and long streaks, resets after a rest',
    },
    {
      label: 'Health',
      value: needs.health,
      caption:
        needs.health === null
          ? 'Waiting on a default-branch CI signal'
          : needs.health >= 100
            ? 'Default branch is green'
            : 'Default branch is red — medicine restores it',
    },
    {
      label: 'Cleanliness',
      value: needs.cleanliness,
      caption:
        needs.cleanliness === null
          ? 'Waiting on a pull-request open-age signal'
          : needs.cleanliness >= 100
            ? 'No stale pull requests'
            : 'Your own pull requests are sitting open',
    },
    {
      label: 'Diet',
      value: needs.diet,
      caption: 'A quarter per distinct kind of work this week, up to four',
    },
  ]
}

interface HouseState {
  profile: GuestProfile
  ledger: EventLedger
  now: Date
}

export function CareHouse() {
  const [house, setHouse] = useState<HouseState | null>(null)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const profileKey = useViewerProfileKey()

  const read = useCallback(() => {
    if (!profileKey) return
    try {
      const profile = loadGuestProfile(window.localStorage, profileKey)
      const ledger = loadBrowserLedger(browserProductStorage(), profileKey)
      if (profile) setHouse({ profile, ledger, now: new Date() })
    } catch {
      // Private mode, disabled storage, quota. An empty room is the honest
      // result; the page still explains what the House is.
      setHouse(null)
    }
    setReady(true)
  }, [profileKey])

  useEffect(() => {
    // Same shape as `OwnedCompanionGrid`: the room cannot be server-rendered
    // (the profile lives in localStorage), so the first paint is empty and the
    // effect is what makes it real.
    read()
    window.addEventListener('terrarium:guest-profile-updated', read)
    // The clock is the only thing that makes needs move (`needs.ts` derives
    // them from timestamps), so a minute tick is enough to keep the room honest
    // without a timer per need.
    const tick = window.setInterval(read, 60_000)
    return () => {
      window.removeEventListener('terrarium:guest-profile-updated', read)
      window.clearInterval(tick)
    }
  }, [read])

  const readout = useMemo(() => {
    if (!house) return null
    // The resolved acquisition, so the room shows the instance the grid marked
    // active even when the profile's species pointer drifted.
    const companionId =
      activeCollectionReference(house.profile)?.companionId ??
      house.profile.activeCompanionId
    // A profile saved before the care layer existed has no `care`. Starting the
    // clock at the profile's own creation (not at "now") is what stops the first
    // visit after the upgrade from handing the companion a free full belly.
    const care = house.profile.care ?? createCareState(house.profile.createdAt)
    const offset = viewerOffsetMinutes()
    const signals = deriveCareSignals(house.ledger, house.now, { utcOffsetMinutes: offset })
    return {
      companionId,
      ...buildCareReadout({
        companionId,
        state: care,
        ledger: house.ledger,
        signals,
        now: house.now,
        utcOffsetMinutes: offset,
      }),
    }
  }, [house])

  // Minting happens on read so a meal earned today appears on the same render.
  // The mint is idempotent, but persisting it stops the "already granted" log
  // from starting empty on every visit.
  useEffect(() => {
    if (!house || !readout || !profileKey) return
    if (readout.state === house.profile.care) return
    const next: GuestProfile = { ...house.profile, care: readout.state }
    try {
      saveGuestProfile(window.localStorage, next, profileKey)
      // No setState here: the dispatch re-reads storage, which produces exactly
      // this state. Writing the component's copy as well would be a second
      // source of truth for the same value.
      window.dispatchEvent(new Event('terrarium:guest-profile-updated'))
    } catch {
      // Best effort: the grant is re-derived next time, and the room is still
      // correct for this render.
    }
  }, [house, readout, profileKey])

  const act = useCallback(
    (action: CareActionKind) => {
      if (!readout || !house || !profileKey) return
      const outcome = applyCareAction(readout.state, action, {
        companionId: readout.companionId,
        needs: readout.needs,
        signals: readout.signals,
        now: house.now,
        dormant: readout.dormant,
      })
      if (!outcome.ok) {
        setMessage(REFUSAL_COPY[outcome.reason] ?? 'That is not possible right now.')
        return
      }
      const next: GuestProfile = { ...house.profile, care: outcome.state }
      try {
        saveGuestProfile(window.localStorage, next, profileKey)
        setHouse({ ...house, profile: next })
        window.dispatchEvent(new Event('terrarium:guest-profile-updated'))
        setMessage(
          outcome.spentItem
            ? `${ACTION_COPY[action]} Used one ${outcome.spentItem}.`
            : ACTION_COPY[action],
        )
      } catch {
        // A refused write must not claim the action happened.
        setMessage('Could not save that. Browser storage refused the write.')
      }
    },
    [house, profileKey, readout],
  )

  if (!ready) return null

  if (!readout || !house) {
    return (
      <section
        className="p-5 sm:p-6"
        style={{ background: 'var(--paper-raised)', border: '1px solid var(--rule)' }}
        aria-label="The House"
      >
        <h2 className="font-ui text-xl font-semibold tracking-tighter">The House</h2>
        <p className="font-prose mt-2 text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          No companion lives here yet. One is granted when you first arrive, and another
          every day you come back.
        </p>
      </section>
    )
  }

  const { scene, needs, signals, dormant } = readout
  const definition = PROTOTYPE_COMPANION_CATALOG.get(readout.companionId)
  const sprite = definition ? resolveCompanionSprite(definition) : null
  const available = new Set(scene.availableActions)
  const streak = streakLength(signals.activityDays, signals.today)
  const inventoryEntries = (Object.entries(scene.inventory) as [CareItemKind, number][]).filter(
    ([, count]) => count > 0,
  )

  return (
    <section aria-labelledby="house-title">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p
            className="font-data text-xs uppercase tracking-widest"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            The house
          </p>
          <h2 id="house-title" className="font-ui mt-1 text-2xl font-semibold tracking-tighter leading-[1.05]">
            {definition?.name ?? readout.companionId}
          </h2>
        </div>
        <p className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
          {plural(house.profile.collection.length, 'companion', 'companions')} owned
        </p>
      </div>

      {/* The room. A flat elevation rather than the planned 2.5D isometric
          render: the plan's §4.4 architecture keeps the renderer replaceable,
          and shipping a legible room beats shipping a broken projection. */}
      <div
        className="mt-4 overflow-hidden"
        style={{ border: '1px solid var(--rule)', background: 'var(--paper-raised)' }}
      >
        <div className="relative p-5" style={{ minHeight: 260 }}>
          {/* Window: the only part of the room that follows the real clock. */}
          <div
            className="absolute right-5 top-5 h-14 w-14"
            style={{
              border: '1px solid var(--rule)',
              background:
                scene.dayPart === 'night' || scene.dayPart === 'dusk'
                  ? 'color-mix(in oklab, var(--ink) 12%, transparent)'
                  : 'color-mix(in oklab, var(--accent) 14%, transparent)',
            }}
            aria-hidden="true"
          />
          <p className="font-data text-[11px] uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
            {scene.dayPart}
          </p>

          <div className="mt-6 flex flex-col items-center">
            <button
              type="button"
              onClick={() => act('pet')}
              aria-label={`Pet ${definition?.name ?? readout.companionId}`}
              className="flex min-h-11 min-w-11 flex-col items-center gap-2 px-3 py-2 focus:outline-none"
              style={{ background: 'transparent' }}
            >
              {sprite ? (
                <RemoteSprite
                  resolved={sprite}
                  scale={3}
                  alt={definition?.name ?? readout.companionId}
                  stage={readout.companionId}
                />
              ) : (
                <span className="font-data text-xs" style={{ color: 'var(--ink-muted)' }}>
                  sprite unavailable
                </span>
              )}
              <span className="font-data text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                {scene.pose} · {scene.mood}
              </span>
            </button>
            <p className="font-prose mt-2 max-w-sm text-center text-sm leading-relaxed">
              {DIALOGUE_COPY[scene.dialogue] ?? DIALOGUE_COPY.idle}
            </p>
          </div>

          {/* The floor line, with the objects along it. */}
          <div
            className="mt-6 grid grid-cols-2 gap-2 border-t pt-4 sm:grid-cols-5"
            style={{ borderColor: 'var(--rule)' }}
          >
            {OBJECTS.map((object) => {
              const usable = available.has(object.action)
              return (
                <button
                  key={object.action}
                  type="button"
                  onClick={() => act(object.action)}
                  disabled={!usable}
                  aria-label={`${object.hint}: ${object.label}`}
                  className="flex min-h-11 flex-col items-start justify-center px-3 py-2 text-left focus:outline-none"
                  style={{
                    border: '1px solid var(--rule)',
                    background: usable ? 'var(--paper)' : 'transparent',
                    opacity: usable ? 1 : 0.55,
                    cursor: usable ? 'pointer' : 'not-allowed',
                  }}
                >
                  <span className="font-ui text-sm font-medium">{object.label}</span>
                  <span className="font-data text-[10px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                    {object.hint}
                    {usable ? '' : ' · unavailable'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {message && (
        <p
          className="font-prose mt-3 text-sm"
          style={{ color: 'var(--ink-muted)' }}
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      )}

      {dormant && (
        <p
          className="font-prose mt-3 border-l-2 px-3 py-2 text-sm"
          style={{ borderColor: 'var(--accent)', color: 'var(--ink)' }}
        >
          Dormant: nothing has gone in for a week. One day of real work wakes it, and
          nothing it earned has been taken away.
        </p>
      )}

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3
            className="font-data text-xs uppercase tracking-widest"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            Condition
          </h3>
          <div className="mt-3 grid gap-4">
            {meterCaptions(needs, scene).map((meter) => (
              <Meter key={meter.label} {...meter} />
            ))}
          </div>
          <p className="font-prose mt-4 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Condition changes daily and is always recoverable. It never removes XP, a
            stage, or a companion: neglect changes how yours is doing, not what it earned.
          </p>
        </div>

        <div>
          <h3
            className="font-data text-xs uppercase tracking-widest"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            Cupboard
          </h3>
          {inventoryEntries.length === 0 ? (
            <p className="font-prose mt-3 text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              Empty. Meals come from active days, merged pull requests and new notes.
            </p>
          ) : (
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {inventoryEntries.map(([item, count]) => (
                <li
                  key={item}
                  className="px-3 py-2"
                  style={{ border: '1px solid var(--rule)' }}
                >
                  <span className="font-data block text-sm">
                    {count.toLocaleString()} {count === 1 ? ITEM_LABEL[item] : ITEM_LABEL_PLURAL[item]}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h3
            className="font-data mt-6 text-xs uppercase tracking-widest"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            This week
          </h3>
          <dl className="font-data mt-3 grid gap-2 text-xs">
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--ink-muted)' }}>Active days</dt>
              <dd>{signals.activityDays.length.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--ink-muted)' }}>Current streak</dt>
              <dd>{plural(streak, 'day', 'days')}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--ink-muted)' }}>Late-night sessions</dt>
              <dd>{signals.lateNightDays.length.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--ink-muted)' }}>Kinds of work</dt>
              <dd>{signals.categoriesInWindow.length.toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  )
}
