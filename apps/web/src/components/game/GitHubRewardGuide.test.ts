import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { asCompanionId } from '@/lib/game/events'
import { normalizeGitHubEvents } from '@/lib/game/github-events'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { GitHubRewardGuide } from './GitHubRewardGuide'

const NOW = '2026-01-01T00:00:00.000Z'

function profile() {
  return createGuestProfile({
    guestId: 'guest-test',
    starterCompanionId: 'pikachu-family',
    catalog: PROTOTYPE_COMPANION_CATALOG,
    now: NOW,
  })
}

describe('GitHubRewardGuide', () => {
  it('names verified activity instead of sync-internal vocabulary', () => {
    // REGRESSION: the reward map kept rendering "receipts" after the copy pass
    // moved the GitHub surface to "activity proof" / "verified activity"
    // (docs/DECISIONS.md, "Cloud progress uses save-file language").
    const events = normalizeGitHubEvents({
      sourceId: 'account-42',
      companionId: asCompanionId('pikachu-family'),
      commits: [{
        id: 'commit-1',
        repositoryId: 'repo-1',
        occurredAt: '2026-01-01T09:00:00Z',
        changedFiles: 1,
        additions: 2,
      }],
    })
    const state = createProductState(
      profile(),
      { events },
      undefined,
      PROTOTYPE_COMPANION_CATALOG,
    )

    const markup = renderToStaticMarkup(React.createElement(GitHubRewardGuide, { state }))

    expect(markup).toContain('Verified activity')
    expect(markup).not.toMatch(/receipt/iu)
  })

  it('describes an empty reward list without sync-internal vocabulary', () => {
    const state = createProductState(
      profile(),
      { events: [] },
      undefined,
      PROTOTYPE_COMPANION_CATALOG,
    )

    const markup = renderToStaticMarkup(React.createElement(GitHubRewardGuide, { state }))

    expect(markup).toContain('No verified activity yet')
    expect(markup).not.toMatch(/receipt/iu)
  })
})
