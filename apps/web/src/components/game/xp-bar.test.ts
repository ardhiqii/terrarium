import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..', '..')

function read(rel: string) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * The bar said `50 / 3500 xp`. The observation log five rows below said `Total 1550 xp`.
 *
 * Both numbers were correct: 1,550 total, 1,500 to enter Mossling, so 50 into a 3,500-wide
 * stage. Nothing on screen said the fraction was XP WITHIN the stage, so a reader holding two
 * unexplained numbers concludes one of them is broken. Naming the stage costs one word.
 *
 * These tests pin the attribution AND the call sites, because the fix is worthless if a fifth
 * XpBar is added later without it.
 */
const XP_BAR = 'apps/web/src/components/game/XpBar.tsx'

describe('XpBar states which stage its numbers are inside', () => {
  it('takes the stage name as a prop', () => {
    const src = read(XP_BAR)
    expect(src).toContain('stageName?: string')
  })

  it('renders the visible label with the stage named', () => {
    const src = read(XP_BAR)
    expect(src).toContain('xp into ${target}')
  })

  it('no longer renders a bare "x / y xp" fraction', () => {
    const src = read(XP_BAR)
    expect(src).not.toContain('${xpIntoStage} / ${xpForNextStage} xp')
    expect(src).not.toContain('`${xpIntoStage} /')
  })

  it('names the stage in the accessible name too', () => {
    const src = read(XP_BAR)
    expect(src).toContain('${xpIntoStage} of ${xpForNextStage} xp into ${target}')
    // "Progress to next stage" described the bar without saying which stage it was inside.
    expect(src).toContain('aria-label="Progress into this stage"')
  })
})

describe('every XpBar call site passes the stage name', () => {
  const CALL_SITES = [
    'apps/web/src/components/game/SpecimenPlate.tsx',
    'apps/web/src/components/garden/ConnectGarden.tsx',
    'apps/web/src/components/garden/EditorPane.tsx',
    'apps/web/src/components/profile/ProfileSpecimen.tsx',
  ]

  for (const rel of CALL_SITES) {
    it(rel.split('/').pop() + ' passes stageName', () => {
      const src = read(rel)
      expect(src).toMatch(/<XpBar\b/)
      expect(src).toContain('stageName=')
    })
  }
})
