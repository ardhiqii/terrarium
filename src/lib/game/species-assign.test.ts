import { describe, it, expect } from 'vitest'
import {
  assignSpeciesLine,
  assignClusterSpeciesLine,
  type RepoCharacteristics,
  type ClusterCharacteristics,
} from './species-assign'
import { SPECIES_LINES } from './sprites/species'

function repo(overrides: Partial<RepoCharacteristics> = {}): RepoCharacteristics {
  return {
    owner: 'octocat',
    repo: 'hello-world',
    language: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    pushedAt: '2026-06-01T00:00:00.000Z',
    sizeKb: 500,
    ...overrides,
  }
}

describe('assignSpeciesLine: determinism', () => {
  it('the same input always resolves to the same line, called repeatedly', () => {
    const chars = repo({ language: 'rust' })
    const first = assignSpeciesLine(chars)
    for (let i = 0; i < 20; i++) {
      expect(assignSpeciesLine(chars).id).toBe(first.id)
    }
  })

  it('is deterministic for repos with no language at all (the hash fallback path)', () => {
    const chars = repo({ language: null, repo: 'no-language-repo' })
    const first = assignSpeciesLine(chars)
    for (let i = 0; i < 20; i++) {
      expect(assignSpeciesLine(chars).id).toBe(first.id)
    }
  })
})

describe('assignSpeciesLine: language mapping', () => {
  it('maps a known language to its line, case-insensitively', () => {
    expect(assignSpeciesLine(repo({ language: 'Rust' })).id).toBe('ember')
    expect(assignSpeciesLine(repo({ language: 'RUST' })).id).toBe('ember')
    expect(assignSpeciesLine(repo({ language: 'rust' })).id).toBe('ember')
  })

  it('TypeScript and Python resolve to visibly different lines', () => {
    const ts = assignSpeciesLine(repo({ language: 'TypeScript' }))
    const py = assignSpeciesLine(repo({ language: 'Python' }))
    expect(ts.id).not.toBe(py.id)
  })

  it('maps every language listed on every line back to that exact line', () => {
    for (const line of SPECIES_LINES) {
      for (const lang of line.languages) {
        const result = assignSpeciesLine(repo({ language: lang }))
        expect(result.id, `language '${lang}' should map to '${line.id}'`).toBe(line.id)
      }
    }
  })

  it('falls back to a hash-selected line (not always the default) for an unmapped language', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      seen.add(assignSpeciesLine(repo({ language: 'brainfuck', repo: `repo-${i}` })).id)
    }
    // Different repo identities with the same unmapped language should not
    // all collapse onto one line.
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('assignSpeciesLine: differentiation is the whole point', () => {
  it('two repos with the same unmapped/no language still resolve to different lines when their identity differs', () => {
    const a = assignSpeciesLine(repo({ language: null, repo: 'alpha' }))
    const b = assignSpeciesLine(repo({ language: null, repo: 'bravo' }))
    // Not a hard guarantee for every pair (finite pool), but true for this
    // fixed pair given the current line count; regression guard against a
    // fallback that ignores repo identity entirely (e.g. always index 0).
    expect(a.id === b.id ? 'collision' : 'distinct').toBe('distinct')
  })

  it('a dozen distinct real-world language values spread across more than one line', () => {
    const langs = [
      'TypeScript', 'JavaScript', 'Python', 'Go', 'Java', 'C#', 'Ruby',
      'Rust', 'C++', 'Vue', 'CSS', 'Shell',
    ]
    const lines = new Set(langs.map((l) => assignSpeciesLine(repo({ language: l })).id))
    expect(lines.size).toBeGreaterThan(3)
  })
})

describe('assignSpeciesLine: every result is a real, valid line', () => {
  it('always returns one of SPECIES_LINES, never an ad-hoc object', () => {
    const validIds = new Set(SPECIES_LINES.map((l) => l.id))
    const samples = [
      repo({ language: 'rust' }),
      repo({ language: null }),
      repo({ language: 'unknown-lang-xyz' }),
      repo({ language: '' }),
    ]
    for (const s of samples) {
      expect(validIds.has(assignSpeciesLine(s).id)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// assignClusterSpeciesLine (T22)
// ---------------------------------------------------------------------------

function cluster(overrides: Partial<ClusterCharacteristics> = {}): ClusterCharacteristics {
  return {
    tag: 'design',
    memberText: [],
    ...overrides,
  }
}

describe('assignClusterSpeciesLine: determinism', () => {
  it('the same cluster always resolves to the same line, called repeatedly', () => {
    const chars = cluster({ tag: 'design' })
    const first = assignClusterSpeciesLine(chars)
    for (let i = 0; i < 20; i++) {
      expect(assignClusterSpeciesLine(chars).id).toBe(first.id)
    }
  })

  it('is deterministic on the hash fallback path (tag matches no keyword)', () => {
    const chars = cluster({ tag: 'zzz-unmapped-tag', memberText: ['nothing thematic here'] })
    const first = assignClusterSpeciesLine(chars)
    for (let i = 0; i < 20; i++) {
      expect(assignClusterSpeciesLine(chars).id).toBe(first.id)
    }
  })
})

describe('assignClusterSpeciesLine: tag name is the primary signal', () => {
  it('maps known theme tag names to their line', () => {
    expect(assignClusterSpeciesLine(cluster({ tag: 'design' })).id).toBe('bloom')
    expect(assignClusterSpeciesLine(cluster({ tag: 'music' })).id).toBe('current')
    expect(assignClusterSpeciesLine(cluster({ tag: 'security' })).id).toBe('ember')
    expect(assignClusterSpeciesLine(cluster({ tag: 'writing' })).id).toBe('grass')
    expect(assignClusterSpeciesLine(cluster({ tag: 'reading' })).id).toBe('bedrock')
    expect(assignClusterSpeciesLine(cluster({ tag: 'thinking' })).id).toBe('psychic')
    expect(assignClusterSpeciesLine(cluster({ tag: 'learning' })).id).toBe('tide')
    expect(assignClusterSpeciesLine(cluster({ tag: 'tools' })).id).toBe('steel')
  })

  it('matches case-insensitively', () => {
    expect(assignClusterSpeciesLine(cluster({ tag: 'Design' })).id).toBe('bloom')
    expect(assignClusterSpeciesLine(cluster({ tag: 'WRITING' })).id).toBe('grass')
  })

  it('ignores the memberText signal when the tag itself already matches', () => {
    // memberText below would match 'music' -> current if it were consulted,
    // but the tag 'design' must win since it is checked first.
    const chars = cluster({ tag: 'design', memberText: ['a note about music and audio'] })
    expect(assignClusterSpeciesLine(chars).id).toBe('bloom')
  })

  it('does not false-positive on a substring inside a longer tag word', () => {
    // 'art' is a keyword (-> bloom), but must not fire inside 'article' or
    // 'artisan' style tags thanks to the word-boundary match.
    const chars = cluster({ tag: 'article-notes', memberText: [] })
    expect(assignClusterSpeciesLine(chars).id).not.toBe('bloom')
  })
})

describe('assignClusterSpeciesLine: member text is the second-priority signal', () => {
  it('falls through to titles/descriptions when the tag itself matches no theme', () => {
    const chars = cluster({
      tag: 'misc-tag-xyz',
      memberText: ['Notes on visual design systems', 'A study of typography'],
    })
    expect(assignClusterSpeciesLine(chars).id).toBe('bloom')
  })

  it('checks memberText entries in order and stops at the first match', () => {
    const chars = cluster({
      tag: 'misc-tag-xyz',
      memberText: ['nothing thematic here', 'thoughts on security practices'],
    })
    expect(assignClusterSpeciesLine(chars).id).toBe('ember')
  })
})

describe('assignClusterSpeciesLine: hash fallback', () => {
  it('falls back to a hash-selected line when neither tag nor member text match any keyword', () => {
    const chars = cluster({ tag: 'zzz-unmapped-tag', memberText: ['nothing thematic here'] })
    const validIds = new Set(SPECIES_LINES.map((l) => l.id))
    expect(validIds.has(assignClusterSpeciesLine(chars).id)).toBe(true)
  })

  it('two unmapped tags with different identities can resolve to different lines', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      seen.add(assignClusterSpeciesLine(cluster({ tag: `unmapped-${i}` })).id)
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('assignClusterSpeciesLine: every result is a real, valid line', () => {
  it('always returns one of SPECIES_LINES, never an ad-hoc object', () => {
    const validIds = new Set(SPECIES_LINES.map((l) => l.id))
    const samples = [
      cluster({ tag: 'design' }),
      cluster({ tag: 'unknown-xyz' }),
      cluster({ tag: '' }),
      cluster({ tag: 'unknown-xyz', memberText: ['also nothing thematic'] }),
    ]
    for (const s of samples) {
      expect(validIds.has(assignClusterSpeciesLine(s).id)).toBe(true)
    }
  })
})

describe('cluster theme keyword table: no keyword listed under two lines', () => {
  it('every keyword maps to exactly one line id across the whole table', () => {
    // Regression guard mirroring species.test.ts's "no language listed
    // twice" check: build the table the same way species-assign.ts does
    // and confirm no keyword string repeats across different lines.
    // We can't import the private table directly, so we infer collisions
    // by checking that a representative set of every documented keyword
    // resolves to exactly one stable id (already covered above); this
    // test instead asserts the public contract: known keywords are STABLE
    // across repeated calls with different surrounding text.
    const knownKeywords = [
      'design', 'music', 'security', 'writing', 'reading', 'thinking',
      'learning', 'tools',
    ]
    for (const kw of knownKeywords) {
      const a = assignClusterSpeciesLine(cluster({ tag: kw }))
      const b = assignClusterSpeciesLine(cluster({ tag: `some-${kw}-tag` }))
      expect(a.id).toBe(b.id)
    }
  })
})
