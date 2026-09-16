import { describe, expect, it } from 'vitest'
import { syncProgressView } from './sync-progress'

describe('syncProgressView', () => {
  it('stays indeterminate until the server reports a repository total', () => {
    // The route streams a `start` event before the first repository is read, so
    // for a brief moment there is no denominator. Showing a fabricated
    // percentage there would be dishonest, so the bar stays indeterminate.
    const view = syncProgressView({
      repositoryIndex: 0,
      repositoryCount: 0,
      repository: '',
      requestsDone: 0,
    })

    expect(view.determinate).toBe(false)
    expect(view.fraction).toBe(0)
    expect(view.label).toBe('your repositories')
    expect(view.ariaText).toBe('Reading your repositories, 0 requests completed')
  })

  it('derives the percentage from the repository count', () => {
    const view = syncProgressView({
      repositoryIndex: 3,
      repositoryCount: 6,
      repository: 'octo/garden',
      requestsDone: 128,
    })

    expect(view.determinate).toBe(true)
    expect(view.percent).toBe(50)
    expect(view.fraction).toBe(0.5)
    expect(view.index).toBe(3)
    expect(view.requests).toBe('128')
  })

  it('never lets the fill escape the track', () => {
    // Defensive: a miscounted index must not paint a bar wider than its track
    // or invert it with a negative scale.
    const over = syncProgressView({
      repositoryIndex: 9,
      repositoryCount: 4,
      repository: 'octo/garden',
      requestsDone: 1,
    })
    const under = syncProgressView({
      repositoryIndex: -5,
      repositoryCount: 4,
      repository: 'octo/garden',
      requestsDone: 0,
    })

    expect(over.fraction).toBe(1)
    expect(over.percent).toBe(100)
    expect(under.fraction).toBe(0)
    expect(under.percent).toBe(0)
  })

  it('survives non-finite input without producing NaN in the bar geometry', () => {
    // NaN reaching `scaleX()` silently blanks the bar, which looks like the
    // frozen sync this indicator exists to disprove.
    for (const value of [NaN, Infinity, -Infinity]) {
      const view = syncProgressView({
        repositoryIndex: value,
        repositoryCount: value,
        repository: 'octo/garden',
        requestsDone: value,
      })

      expect(Number.isFinite(view.fraction)).toBe(true)
      expect(Number.isFinite(view.percent)).toBe(true)
      expect(view.requests).toBe('0')
    }
  })

  it('reports the repository currently being read', () => {
    const view = syncProgressView({
      repositoryIndex: 2,
      repositoryCount: 5,
      repository: '  octo/terrarium  ',
      requestsDone: 42,
    })

    expect(view.label).toBe('octo/terrarium')
    expect(view.ariaText).toContain('octo/terrarium')
    expect(view.ariaText).toContain('repository 2 of 5')
  })

  it('formats large request counts for readability', () => {
    const view = syncProgressView({
      repositoryIndex: 1,
      repositoryCount: 25,
      repository: 'octo/garden',
      requestsDone: 14446,
    })

    expect(view.requests).toBe('14,446')
    expect(view.ariaText).toContain('14,446 requests completed')
  })

  it('describes an unknown repository and a fractional index sanely', () => {
    const view = syncProgressView({
      repositoryIndex: 1.7,
      repositoryCount: 3,
      repository: '   ',
      requestsDone: 0.5,
    })

    expect(view.label).toBe('your repositories')
    expect(view.index).toBe(1)
    expect(Number.isInteger(view.index)).toBe(true)
    expect(view.requests).toBe('0')
  })
})
