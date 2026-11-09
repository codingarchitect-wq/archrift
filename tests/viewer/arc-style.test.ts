import { describe, expect, it } from 'vitest'
import { focusArcStyle } from '../../src/viewer/scene/arc-style.ts'

describe("a selection's arcs", () => {
  it('are bold while there are few', () => {
    expect(focusArcStyle(1)).toEqual({ width: 2.6, opacity: 1 })
    expect(focusArcStyle(12)).toEqual({ width: 2.6, opacity: 1 })
  })

  it('get thinner and lighter as they multiply, never under a pixel', () => {
    const hundred = focusArcStyle(100)
    expect(hundred.width).toBeCloseTo(1.4, 1)
    expect(hundred.opacity).toBeLessThan(0.75)
    let last = focusArcStyle(12)
    for (const n of [20, 40, 100, 200, 1000]) {
      const s = focusArcStyle(n)
      expect(s.width).toBeLessThanOrEqual(last.width)
      expect(s.opacity).toBeLessThanOrEqual(last.opacity)
      last = s
    }
    expect(focusArcStyle(4000)).toEqual({ width: 1, opacity: 0.55 })
  })
})
