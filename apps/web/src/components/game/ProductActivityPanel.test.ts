import { readFileSync } from 'node:fs'
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
    // Assert the full allowlist — exact classes and no inline style — so a
    // fill reintroduced as a utility class (e.g. `bg-[color:var(--paper)]`)
    // or as an inline style fails this test, not just the literal word
    // "background".
    const slot = markup.match(/<div data-companion-slot[^>]*>/)?.[0]
    expect(slot).toBeDefined()
    expect(slot).not.toContain('style=')
    expect(slot).toContain('class="flex h-20 w-20 shrink-0 items-center justify-center"')
    expect(markup).toContain('data-companion-id="grass-family"')
  })

  it('never renders the encounter meter: a discovery stays a surprise', () => {
    const state = guestState('pikachu-family')
    const markup = renderToStaticMarkup(
      React.createElement(ProductActivityPanel, {
        state,
        sourceLabel: 'Active companion',
      }),
    )

    // The encounter track is deliberately invisible: its caption and fill used
    // to read as a second progress bar, and a percentage turned the next award
    // into a countdown. The mechanic still runs on this state (the meter is
    // carried and synced); only the presentation is gone. XP is the one bar.
    expect(state.encounters.meter).toBe(0)
    expect(markup).toContain('aria-label="Progress to next form"')
    expect(markup).not.toContain('Encounter')
    expect(markup).not.toContain('a new companion is discovered')
  })

  it('keeps the slot free of CSS fills as well', () => {
    // A stylesheet rule targeting the slot could paint a fill that static
    // markup tests would never see. The slot must not be styled at all.
    const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')
    expect(css).not.toContain('data-companion-slot')
  })
})
