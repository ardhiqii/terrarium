import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COPY, GUIDE_ANCHORS } from '@/lib/copy'
import { meterCaptions } from '@/components/game/care-captions'
import type { CareNeeds, CareScene } from '@/lib/game/care'

/**
 * Guards for the copy budget (`DESIGN.md` §7, `docs-plan/PLAN-calmer-ui.md`).
 *
 * Users found the UI overwhelming because of how much text it showed. These
 * tests pin the parts of the fix that would otherwise creep back silently:
 * shared sentences written out again by hand, meter captions that are always on,
 * and guide links that point at a section that does not exist.
 */

const SRC = join(process.cwd(), 'apps/web/src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return tsxFiles(full)
    return full.endsWith('.tsx') ? [full] : []
  })
}

const FULL: CareNeeds = { hunger: 100, energy: 100, health: 100, cleanliness: 100, diet: 100 }
const scene = (mood: CareScene['mood'] = 'idle') => ({ mood }) as CareScene
const captionFor = (label: string, needs: Partial<CareNeeds>, mood?: CareScene['mood']) =>
  meterCaptions({ ...FULL, ...needs }, scene(mood)).find((m) => m.label === label)?.caption

describe('meter captions appear only when a need wants attention', () => {
  it('a fully cared-for companion has no captions at all', () => {
    expect(meterCaptions(FULL, scene()).map((m) => m.caption)).toEqual([null, null, null, null, null])
  })

  it('an unmeasured need has no caption, because its label already says "not measured"', () => {
    expect(captionFor('Health', { health: null })).toBeNull()
    expect(captionFor('Cleanliness', { cleanliness: null })).toBeNull()
  })

  it('hunger counts days since the last meal, with the right plural', () => {
    expect(captionFor('Hunger', { hunger: 75 })).toBe('1 day since the last meal')
    expect(captionFor('Hunger', { hunger: 50 })).toBe('2 days since the last meal')
    expect(captionFor('Hunger', { hunger: 0 })).toMatch(/Work today to feed it/)
  })

  it('low needs say what would help', () => {
    expect(captionFor('Health', { health: 0 })).toMatch(/Medicine/)
    expect(captionFor('Cleanliness', { cleanliness: 40 })).toMatch(/pull requests/)
    expect(captionFor('Energy', { energy: 20 })).toMatch(/rest/)
    expect(captionFor('Diet', { diet: 25 })).toMatch(/different kind of work/)
    expect(captionFor('Energy', {}, 'resting')).toBe('Recovering from a rest')
  })

  it('no caption uses an em-dash (DESIGN.md §6)', () => {
    const lows: Partial<CareNeeds> = { hunger: 0, energy: 0, health: 0, cleanliness: 0, diet: 0 }
    for (const meter of meterCaptions({ ...FULL, ...lows }, scene())) {
      expect(meter.caption ?? '').not.toContain('—')
    }
  })
})

describe('shared sentences are written once', () => {
  it('no shared sentence uses an em-dash', () => {
    for (const text of Object.values(COPY)) expect(text).not.toContain('—')
  })

  it('no component spells out a shared sentence by hand instead of importing it', () => {
    const offenders = tsxFiles(SRC).filter((file) => {
      const source = readFileSync(file, 'utf8')
      return Object.values(COPY).some((text) => source.includes(text))
    })
    expect(offenders).toEqual([])
  })

  it('the old "granted when you first arrive" wording is gone from every surface', () => {
    const offenders = tsxFiles(SRC).filter((file) =>
      /granted when you first arrive/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})

describe('GitHub panel: calmer, but nothing protective was cut', () => {
  const panel = read('components/game/GitHubSourcePanel.tsx').replace(/\r\n/g, '\n')

  it('keeps every destructive confirmation in full (DESIGN.md §7, R7)', () => {
    expect(panel).toContain("The account's cloud copy is deleted before the new upload. This cannot be undone.")
    expect(panel).toContain("This browser's progress for this account is replaced by the account's cloud copy.")
    expect(panel).toContain('Future tracking stops and the token is removed. Earned XP and your repository choices stay. Deleting synced data remains a separate action.')
    expect(panel).toContain('Confirm disconnect')
    expect(panel).toContain('Confirm and continue')
  })

  it('keeps the full receipt-recovery explanation, behind Details', () => {
    expect(panel).toContain('could not be confirmed in the bounded GitHub repair window')
    expect(panel).toContain('blocked the account backup. Your browser ledger and encounters are intact.')
    expect(panel).toContain('Repair receipts and retry')
  })

  it('shows the sync outcome above the repository picker, not below the whole list', () => {
    const report = panel.indexOf('<StatusNote')
    const picker = panel.indexOf('Tracked repos</h2>')
    expect(report).toBeGreaterThan(0)
    expect(picker).toBeGreaterThan(report)
  })

  it('a failed account backup is named in the sync headline, not only in the details', () => {
    expect(panel).toMatch(/const backupNote = upload\.ok \? '' : ' Account backup failed\.'/)
    expect(panel).toMatch(/Synced \$\{repoWord\(count\)\}[^`]*\$\{backupNote\}/)
  })

  it('decides the picker fold once, so ticking the first repo cannot snap it shut', () => {
    expect(panel).toContain('reposOpen === null')
    expect(panel).toContain('open={reposOpen ?? true}')
    expect(panel).not.toMatch(/open=\{effectiveTrackedCount/)
  })

  it('flags unsaved repository choices on the folded summary', () => {
    expect(panel).toContain("settingsChanged ? ' · unsaved changes' : ''")
  })

  it('moves the rare controls (auto-sync cadence, disconnect) into Settings', () => {
    const settings = panel.indexOf('Settings</h2>')
    expect(settings).toBeGreaterThan(0)
    expect(panel.indexOf('id="github-sync-schedule"')).toBeGreaterThan(settings)
    // The button label, not the doc comment on `disconnectGitHub` higher up.
    expect(panel.indexOf("onClick={() => setDisconnectStage('confirm')}")).toBeGreaterThan(settings)
  })
})

describe('progressive-disclosure primitives', () => {
  it('every guide anchor that a disclosure may link to exists on /guide', () => {
    const guide = read('app/guide/page.tsx')
    for (const [key, anchor] of Object.entries(GUIDE_ANCHORS)) {
      const present = guide.includes(`id="${anchor}"`) || guide.includes(`id={GUIDE_ANCHORS.${key}}`)
      expect(present, `/guide has no section with id "${anchor}"`).toBe(true)
    }
  })

  it('every hard-coded /guide# link points at a section that exists', () => {
    const anchors = new Set<string>(Object.values(GUIDE_ANCHORS))
    const broken: string[] = []
    for (const file of tsxFiles(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\/guide#([a-z0-9-]+)/g)) {
        if (!anchors.has(match[1])) broken.push(`${file}: #${match[1]}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('the guide lists every section in its contents, on small screens too', () => {
    const guide = read('app/guide/page.tsx')
    for (const key of ['condition', 'githubSync', 'privacy', 'leaderboard']) {
      expect(guide).toContain(`id: GUIDE_ANCHORS.${key}`)
    }
    expect(guide).toMatch(/RelatedLinks[\s\S]*lg:hidden/)
  })

  it('InfoDisclosure and StatusNote details are native <details>, not hover tooltips', () => {
    expect(read('components/ui/InfoDisclosure.tsx')).toContain('<details')
    expect(read('components/ui/StatusNote.tsx')).toContain('<details')
  })

  it('the primitives stay usable from server components (no client directive, no hooks)', () => {
    for (const file of ['InfoDisclosure.tsx', 'StatusNote.tsx', 'RelatedLinks.tsx']) {
      const source = read(`components/ui/${file}`)
      expect(source).not.toMatch(/^['"]use client['"]/m)
      expect(source).not.toMatch(/\buse(State|Effect|Ref|Callback|Memo)\(/)
    }
  })
})
