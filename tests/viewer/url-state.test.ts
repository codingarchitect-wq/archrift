import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, optionsFromQuery, optionsToQuery } from '../../src/viewer/url-state.ts'

describe('options in the URL', () => {
  it('writes only what differs from the defaults', () => {
    expect(optionsToQuery(DEFAULT_OPTIONS)).toBe('')
    expect(optionsToQuery({ ...DEFAULT_OPTIONS, view: 'galaxy', hide: ['src/ui/**', '**/*.css'], focusDepth: 0 })).toBe(
      '?view=galaxy&hide=src%2Fui%2F**%2C**%2F*.css&depth=0',
    )
  })

  it('round-trips every kind of option', () => {
    const o = {
      ...DEFAULT_OPTIONS,
      view: 'layers' as const,
      groupBy: 'community' as const,
      bundle: false,
      tests: true,
      kinds: ['calls', 'renders'],
      minLoc: 40,
      onlyCycles: true,
      focusDir: 'in' as const,
      focusDepth: 3,
      target: 'desktop',
      changeEdges: 'all' as const,
    }
    expect(optionsFromQuery(optionsToQuery(o))).toEqual(o)
  })

  it('ignores values it does not know', () => {
    const o = optionsFromQuery('?view=orbit&depth=-2&color=cycles&bogus=1&changeEdges=some')
    // views are plug-ins, known only to the viewer: it shows an unknown one as the city
    expect(o.view).toBe('orbit')
    expect(o.focusDepth).toBe(1)
    expect(o.colorBy).toBe('cycles')
    expect(o.changeEdges).toBe('between')
  })
})
