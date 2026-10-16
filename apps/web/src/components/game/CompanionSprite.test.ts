import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { resolveCompanionAsset } from '@/lib/game/companion-asset-resolver'
import CompanionSprite from './CompanionSprite'

const grass = PROTOTYPE_COMPANION_CATALOG.get('grass-family')!

function render(formId: string, alt?: string): string {
  const descriptor = resolveCompanionAsset(grass, formId)
  return renderToStaticMarkup(
    React.createElement(CompanionSprite, { descriptor, scale: 2, alt }),
  )
}

describe('CompanionSprite', () => {
  it('renders an accessible animated provider sprite with a reduced-motion still source', () => {
    const markup = render('mossling', 'Active Mossling companion')

    expect(markup).toContain('alt="Active Mossling companion"')
    expect(markup).toContain('data-sprite-source="cache"')
    expect(markup).toContain('data-sprite-motion="animated"')
    expect(markup).toContain('srcSet="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/2.png"')
    expect(markup).toContain('media="(prefers-reduced-motion: reduce)"')
    expect(markup).toContain('src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/2.gif"')
  })

  it('renders Heartwood as static and never advertises Mega animation', () => {
    const markup = render('heartwood')

    expect(markup).toContain('alt="Heartwood"')
    expect(markup).toContain('data-sprite-motion="static"')
    expect(markup).toContain('src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10033.png"')
    expect(markup).not.toContain('media="(prefers-reduced-motion: reduce)"')
    expect(markup).not.toContain('.gif')
  })

  it('renders the local code-generated fallback with an accessible SVG label', () => {
    const descriptor = resolveCompanionAsset(grass, 'mossling')
    const markup = renderToStaticMarkup(
      React.createElement(CompanionSprite, {
        descriptor: { ...descriptor, remote: null },
        scale: 1,
      }),
    )

    expect(markup).toContain('data-sprite-source="local"')
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="Mossling"')
    expect(markup).not.toContain('<img')
  })

  it('uses the descriptor label when no explicit alt is supplied', () => {
    const markup = render('sporeling')
    expect(markup).toContain('alt="Sporeling"')
  })
})

