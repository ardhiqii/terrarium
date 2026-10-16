import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createGuestProfile, type GuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { CompanionCollection } from './CompanionCollection'

const NOW = '2026-01-01T00:00:00.000Z'

function twoCompanionState() {
  const profile = createGuestProfile({
    guestId: 'guest-test',
    starterCompanionId: 'grass-family',
    catalog: PROTOTYPE_COMPANION_CATALOG,
    now: NOW,
  })
  const withSecond: GuestProfile = {
    ...profile,
    collection: [
      ...profile.collection,
      {
        referenceId: 'guest-test:second',
        companionId: 'pikachu-family',
        acquiredAt: NOW,
        acquisition: 'encounter',
      },
    ],
  }
  return createProductState(withSecond, { events: [] }, undefined, PROTOTYPE_COMPANION_CATALOG)
}

describe('CompanionCollection', () => {
  it('renders every owned companion sprite without a filled slot behind it', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CompanionCollection, {
        initialState: twoCompanionState(),
        signedIn: false,
      }),
    )

    // Every roster sprite sits bare on the page; a filled slot read as a
    // visible box around the companion. Assert the full allowlist — exact
    // classes and no inline style — so a utility-class fill (`bg-[...]`) or
    // an inline style is caught, not just the literal word "background".
    const slots = markup.match(/<div data-companion-slot[^>]*>/g) ?? []
    expect(slots).toHaveLength(2)
    for (const slot of slots) {
      expect(slot).not.toContain('style=')
      expect(slot).toContain('class="flex h-24 w-24 shrink-0 items-center justify-center"')
    }

    expect(markup).toContain('data-companion-id="grass-family"')
    expect(markup).toContain('data-companion-id="pikachu-family"')
    expect(markup).toContain('Activate')
  })
})
