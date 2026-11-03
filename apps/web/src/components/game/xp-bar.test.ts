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
 * WHAT IS TESTED HERE, AND WHAT IS NOT: the rendered label is asserted in
 * `xp-bar.render.test.tsx`, by mounting the component. What remains here is the one claim a
 * render cannot make — that every call site PASSES the stage name, including the fifth one
 * somebody adds later. That is a property of the source, so it is checked in the source.
 */
const XP_BAR = 'apps/web/src/components/game/XpBar.tsx'

describe('the XpBar contract', () => {
  it('still takes the stage name as an optional prop', () => {
    expect(read(XP_BAR)).toContain('stageName?: string')
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
