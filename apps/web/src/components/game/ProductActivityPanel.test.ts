import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { ProductActivityPanel } from './ProductActivityPanel'

const NOW = '2026-01-01T00:00:00.000Z'

function guestState(starterCompanionId: string) {
  const profile = createGuestProfile({
    guestId: 'guest-test',
    starterCompanionId,
    catalog: PROTOTYPE_COMPANION_CATALOG,
    now: NOW,
  })
  return createProductState(profile, { events: [] }, undefined, PROTOTYPE_COMPANION_CATALOG)
}

describe('ProductActivityPanel', () => {
  it('renders the active companion sprite without a filled slot behind it', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProductActivityPanel, {
        state: guestState('grass-family'),
        sourceLabel: 'Active companion',
      }),
    )

    // The alignment slot must stay transparent: a filled slot behind the
    // sprite read as a visible box on the home, /github, and /write surfaces.
    const slot = markup.match(/<div data-companion-slot[^>]*>/)?.[0]
    expect(slot).toBeDefined()
    expect(slot).not.toContain('background')
    expect(markup).toContain('data-companion-id="grass-family"')
  })
})
