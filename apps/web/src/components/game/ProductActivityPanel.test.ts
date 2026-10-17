import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createEncounterState, type EncounterState } from '@/lib/game/encounters'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { ProductActivityPanel } from './ProductActivityPanel'

const NOW = '2026-01-01T00:00:00.000Z'

function guestState(
  starterCompanionId: string,
  encounters: EncounterState = createEncounterState(),
) {
  const profile = createGuestProfile({
    guestId: 'guest-test',
    starterCompanionId,
    catalog: PROTOTYPE_COMPANION_CATALOG,
    now: NOW,
  })
  return createProductState(profile, { events: [] }, encounters, PROTOTYPE_COMPANION_CATALOG)
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

  it('never renders the encounter meter, even when the meter is charged', () => {
    // A charged meter used to render as a second bar with the caption
    // "55 / 100" and the promise "at 100 a new companion is discovered"
    // (see the removed block in the parent commit). Assert with a non-zero
    // meter so the test cannot pass merely because a zeroed meter renders
    // nothing: the mechanic still runs on this state, only the presentation
    // is gone, and XP must stay the one bar on the panel.
    const state = guestState('pikachu-family', {
      ...createEncounterState(),
      meter: 55,
      totalProgress: 55,
    })
    const markup = renderToStaticMarkup(
      React.createElement(ProductActivityPanel, {
        state,
        sourceLabel: 'Active companion',
      }),
    )

    expect(state.encounters.meter).toBe(55)

    // Exactly one bar, and it is the XP bar. A reintroduced encounter bar
    // fails here even if it is unlabelled; the former labels and captions
    // fail the text assertions below.
    expect(markup.match(/role="progressbar"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Progress to next form"')
    expect(markup).not.toContain('aria-label="Encounter')
    expect(markup).not.toContain('55 / 100')
    expect(markup).not.toContain('55')
    expect(markup).not.toContain('Encounter')
    expect(markup).not.toContain('Fills with new activity')
    expect(markup).not.toContain('a new companion is discovered')
  })

  it('keeps the slot free of CSS fills as well', () => {
    // A stylesheet rule targeting the slot could paint a fill that static
    // markup tests would never see. The slot must not be styled at all.
    const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')
    expect(css).not.toContain('data-companion-slot')
  })
})
