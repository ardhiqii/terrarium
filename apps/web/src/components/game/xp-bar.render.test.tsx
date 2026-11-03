/**
 * The bar, rendered.
 *
 * These assertions replace four source-string checks that asserted the template literal
 * inside `XpBar.tsx` contained the words `xp into`. That test could not fail for the bug it
 * described: a bar that renders the wrong numbers, or drops the stage name through a bad
 * default, still contains the literal. Rendering the component with props asserts what a
 * reader sees.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { XpBar } from './XpBar'

describe('XpBar', () => {
  it('names the stage its numbers are inside', () => {
    // 1,550 total with 1,500 to enter Mossling: 50 into a 3,500-wide stage. Without the name,
    // a reader holding both numbers concludes one of them is broken.
    const html = renderToStaticMarkup(
      <XpBar xpIntoStage={50} xpForNextStage={3500} progress={50 / 3500} stageName="Mossling" />,
    )

    expect(html).toContain('50 of 3,500 xp into Mossling')
    expect(html).toContain('1%')
  })

  it('falls back to "this stage" rather than printing an empty gap', () => {
    const html = renderToStaticMarkup(
      <XpBar xpIntoStage={50} xpForNextStage={3500} progress={0} />,
    )

    expect(html).toContain('50 of 3,500 xp into this stage')
  })

  it('describes the bar in its accessible name, with the stage', () => {
    const html = renderToStaticMarkup(
      <XpBar xpIntoStage={50} xpForNextStage={3500} progress={0} stageName="Mossling" />,
    )

    expect(html).toContain('aria-label="Progress into this stage"')
    expect(html).toContain('aria-valuetext="50 of 3500 xp into Mossling, 0 percent"')
  })

  it('renders a completed state at max stage instead of NaN', () => {
    const html = renderToStaticMarkup(
      <XpBar xpIntoStage={900} xpForNextStage={null} progress={1} stageName="Dragonite" />,
    )

    expect(html).toContain('max stage')
    expect(html).toContain('100%')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('null')
  })

  it('clamps a progress value outside 0..1 rather than overflowing the bar', () => {
    expect(renderToStaticMarkup(<XpBar xpIntoStage={1} xpForNextStage={2} progress={7} />)).toContain('100%')
    expect(renderToStaticMarkup(<XpBar xpIntoStage={1} xpForNextStage={2} progress={-3} />)).toContain('0%')
  })
})
