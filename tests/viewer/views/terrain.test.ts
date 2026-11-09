import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../../../src/core/model.ts'
import { cityLayout } from '../../../src/viewer/layouts/city.ts'
import type { Rect } from '../../../src/viewer/layouts/city.ts'
import {
  PLAIN,
  WATER,
  buildHeightfield,
  cellOf,
  heightAt,
  lastContaining,
  levels,
  owners,
  peaks,
  raycastField,
} from '../../../src/viewer/views/terrain/heightfield.ts'
import type { Heightfield } from '../../../src/viewer/views/terrain/heightfield.ts'
import { groundPath, terrainLayout } from '../../../src/viewer/views/terrain/layout.ts'

// a 4×4 block of equal cells over a 100 square, one of them (index 9) the hardest by far
const cells = (values: number[]): { rect: Rect; level: number }[] => {
  const l = levels(values)
  return values.map((_, i) => ({ rect: { x: -40 + (i % 4) * 20, z: -40 + Math.floor(i / 4) * 20, w: 20, d: 20 }, level: l[i] }))
}
const VALUES = [3, 1, 8, 2, 5, 13, 1, 4, 2, 90, 7, 3, 1, 6, 2, 11]
const LAND: Rect = { x: -45, z: -45, w: 90, d: 90 }

/** The world position of the highest vertex. */
function summit(f: Heightfield) {
  let k = 0
  for (let i = 1; i < f.heights.length; i++) if (f.heights[i] > f.heights[k]) k = i
  return { x: (k % f.n) * f.step - f.size / 2, z: Math.floor(k / f.n) * f.step - f.size / 2, h: f.heights[k] }
}
const inside = (r: Rect, x: number, z: number) => x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d

describe('levels', () => {
  it('rank the values: largest 1, smallest 0, equal values alike, order kept', () => {
    const l = levels([5, 1, 9, 5, 3])
    expect(l[2]).toBe(1)
    expect(l[1]).toBe(0)
    expect(l[0]).toBe(l[3])
    expect(l[4]).toBeLessThan(l[0])
    expect(levels([4, 4, 4])).toEqual([0, 0, 0])
    expect(levels([])).toEqual([])
  })

  it("don't let a giant flatten the rest", () => {
    const values = [...Array(20).keys()].map(i => i + 1).concat(10_000)
    const l = levels(values)
    // linearly the 20 would sit at 0.2% of the giant's height; by rank it stays a hill
    expect(l[19]).toBeGreaterThan(0.5)
    expect(l[9]).toBeLessThan(0.3) // the calm half stays low
  })
})

describe('the heightfield', () => {
  const field = buildHeightfield(100, cells(VALUES), LAND, 96)

  it('is deterministic', () => {
    const again = buildHeightfield(100, cells(VALUES), LAND, 96)
    expect(again.heights).toEqual(field.heights)
    expect(again.water).toEqual(field.water)
  })

  it('peaks over the file with the highest metric', () => {
    const top = summit(field)
    expect(inside(cells(VALUES)[9].rect, top.x, top.z)).toBe(true)
    // …and stays there when that file moves elsewhere
    const moved = [...VALUES]
    ;[moved[9], moved[2]] = [moved[2], moved[9]]
    const other = summit(buildHeightfield(100, cells(moved), LAND, 96))
    expect(inside(cells(moved)[2].rect, other.x, other.z)).toBe(true)
  })

  it('keeps heights in range after smoothing, with water flat at its line', () => {
    let min = Infinity
    let max = -Infinity
    for (const h of field.heights) {
      min = Math.min(min, h)
      max = Math.max(max, h)
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(1)
    expect(max).toBeGreaterThan(0.6) // smoothing doesn't wash the peak out
    field.water.forEach((w, k) => {
      if (w > 0) expect(field.heights[k]).toBeCloseTo(WATER, 6)
    })
    // calm files lie on the plain, above the water
    expect(heightAt(field, -30, -30)).toBeGreaterThan(WATER)
    expect(heightAt(field, -30, -30)).toBeLessThan(PLAIN * 3)
  })

  it('falls to the ground at its edge and keeps water to the land', () => {
    for (const [x, z] of [
      [-50, -50],
      [50, 0],
      [0, 50],
    ])
      expect(heightAt(field, x, z)).toBeCloseTo(0, 5)
    const edgeWater = [...field.water].some((w, k) => w > 0 && !inside(LAND, (k % field.n) * field.step - 50, Math.floor(k / field.n) * field.step - 50))
    expect(edgeWater).toBe(false)
  })

  it('is flat plain when every file is equally calm', () => {
    const flat = buildHeightfield(100, cells(VALUES.map(() => 7)), LAND, 96)
    expect(summit(flat).h).toBeLessThanOrEqual(PLAIN + 1e-6)
  })
})

describe('picking', () => {
  const field = buildHeightfield(100, cells(VALUES), LAND, 96)
  const scale = 20

  it('finds where a ray meets the ground', () => {
    const down = raycastField(field, scale, { x: 10, y: 100, z: 5 }, { x: 0, y: -1, z: 0 })!
    expect(down.x).toBeCloseTo(10)
    expect(down.y).toBeCloseTo(scale * heightAt(field, 10, 5), 2)
    // at a slant, from the south-east, as the camera looks
    const d = { x: -0.4, y: -0.6, z: -0.7 }
    const len = Math.hypot(d.x, d.y, d.z)
    const hit = raycastField(field, scale, { x: 60, y: 90, z: 120 }, { x: d.x / len, y: d.y / len, z: d.z / len })!
    expect(hit).not.toBeNull()
    expect(hit.y).toBeCloseTo(scale * heightAt(field, hit.x, hit.z), 1)
    expect(raycastField(field, scale, { x: 0, y: 100, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull()
    expect(raycastField(field, scale, { x: 500, y: 100, z: 0 }, { x: 0, y: -1, z: 0 })).toBeNull()
  })

  it('maps a point to the file whose cell holds it, else the innermost folder', () => {
    const regions: Rect[] = [
      { x: -50, z: -50, w: 100, d: 100 }, // root
      { x: -45, z: -45, w: 40, d: 90 }, // a folder
      ...cells(VALUES).map(c => c.rect),
    ]
    expect(lastContaining(regions, -35, -35)).toBe(2) // file 0
    expect(lastContaining(regions, -10, 10)).toBe(2 + 9) // file 9 (x -20…0, z 0…20)
    expect(lastContaining(regions, -44, 44)).toBe(1) // the folder's margin
    expect(lastContaining(regions, 48, 48)).toBe(0) // the root's
    expect(lastContaining(regions, 80, 0)).toBe(-1)
    // the same answer per vertex, for coloring
    const own = owners(field, regions)
    const k = Math.round((10 + 50) / field.step) * field.n + Math.round((-10 + 50) / field.step)
    expect(own[k]).toBe(11)
  })
})

// ── the layout ──────────────────────────────────────────────────────────────

const file = (path: string, loc: number, complexity: number): GraphNode => ({
  id: `f:${path}`,
  kind: 'file',
  name: path.split('/').at(-1)!,
  path,
  parent: `d:${path.split('/').slice(0, -1).join('/')}`,
  metrics: { loc, complexity },
})
const NODES: GraphNode[] = [
  { id: 'd:.', kind: 'directory', name: 'root', path: '' },
  { id: 'd:src', kind: 'directory', name: 'src', path: 'src', parent: 'd:.' },
  { id: 'd:src/a', kind: 'directory', name: 'a', path: 'src/a', parent: 'd:src' },
  { id: 'd:src/b', kind: 'directory', name: 'b', path: 'src/b', parent: 'd:src' },
  file('src/a/one.ts', 120, 4),
  file('src/a/two.ts', 300, 9),
  file('src/a/three.ts', 60, 1),
  file('src/a/hard.ts', 200, 80),
  file('src/b/four.ts', 150, 2),
  file('src/b/five.ts', 90, 12),
  file('src/b/six.ts', 400, 3),
  file('src/main.ts', 50, 5),
]
const byId = new Map(NODES.map(n => [n.id, n]))
const layoutOf = (shown: (id: string) => GraphNode | undefined = id => byId.get(id), key = 'complexity') =>
  terrainLayout({ nodes: NODES, rootId: 'd:.', isVisible: () => true, shown, metric: { id: key === 'loc' ? 'lines' : 'complexity', key } })

describe('terrainLayout', () => {
  it("keeps the City's regions, as a terrain view whose boxes are hidden", () => {
    const { layout, terrain } = layoutOf()
    const city = cityLayout({ nodes: NODES, rootId: 'd:.', isVisible: () => true })
    expect(layout).toMatchObject({ view: 'terrain', hideBoxes: true, openFile: 'none', size: city.size })
    for (const [id, p] of city.placement) {
      expect(layout.placement.get(id)).toBe(p)
      const a = layout.boxes.get(id)!
      const b = city.boxes.get(id)!
      expect(a.x).toBeCloseTo(b.x, 9) // same centers
      expect(a.z).toBeCloseTo(b.z, 9)
    }
    expect(terrain.regions.slice(terrain.districts).map(r => r.id)).toEqual([...city.placement].filter(([, p]) => p === 'building').map(([id]) => id))
  })

  it('grows each building back to its treemap cell: the cells tile their folder', () => {
    const city = cityLayout({ nodes: NODES, rootId: 'd:.', isVisible: () => true })
    const folder = city.boxes.get('d:src/b')!
    const pad = Math.min(folder.w, folder.d) * 0.025 + 1.2
    const cellsIn = ['f:src/b/four.ts', 'f:src/b/five.ts', 'f:src/b/six.ts'].map(id => cellOf(city.boxes.get(id)!))
    const area = cellsIn.reduce((a, c) => a + c.w * c.d, 0)
    expect(area / ((folder.w - 2 * pad) * (folder.d - 2 * pad))).toBeCloseTo(1, 1)
  })

  it('sets every file box on the ground: its top is the highest ground in its cell', () => {
    const { layout, terrain } = layoutOf()
    for (const r of terrain.regions.slice(terrain.districts)) {
      const b = layout.boxes.get(r.id)!
      let high = 0
      let low = Infinity
      for (let i = 0; i <= 20; i++)
        for (let j = 0; j <= 20; j++) {
          const h = heightAt(terrain.field, r.rect.x + (r.rect.w * i) / 20, r.rect.z + (r.rect.d * j) / 20) * terrain.scale
          high = Math.max(high, h)
          low = Math.min(low, h)
        }
      expect(b.y + b.h).toBeGreaterThanOrEqual(high - 1e-6)
      expect(b.y + b.h).toBeLessThanOrEqual(high + 0.3 + 1e-6) // flat cells get a sliver of a box
      expect(b.y).toBeCloseTo(low, 6)
    }
    expect(terrain.peaks[0]).toBe('f:src/a/hard.ts')
  })

  it('follows the metric, and the shown world on the timeline without moving footprints', () => {
    const byLines = layoutOf(undefined, 'loc').terrain
    expect(byLines.peaks[0]).toBe('f:src/b/six.ts')
    // hard.ts doesn't exist at this point in time: it sinks, the rest keep their places
    const now = layoutOf()
    const then = layoutOf(id => (id === 'f:src/a/hard.ts' ? undefined : byId.get(id)))
    expect(then.layout.boxes.has('f:src/a/hard.ts')).toBe(false)
    for (const id of ['f:src/a/one.ts', 'f:src/b/six.ts', 'd:src/a']) {
      const a = now.layout.boxes.get(id)!
      const b = then.layout.boxes.get(id)!
      expect([b.x, b.z, b.w, b.d]).toEqual([a.x, a.z, a.w, a.d])
      if (id.startsWith('f:')) expect(b.y + b.h).not.toBe(a.y + a.h) // the ground around it changed
    }
    const hard = now.terrain.regions.find(r => r.id === 'f:src/a/hard.ts')!.rect
    const center = [hard.x + hard.w / 2, hard.z + hard.d / 2] as const
    expect(heightAt(then.terrain.field, ...center)).toBeLessThan(heightAt(now.terrain.field, ...center) * 0.5)
  })

  it('routes arcs over the ground, never through it', () => {
    const { layout, terrain } = layoutOf()
    const a = layout.boxes.get('f:src/b/four.ts')!
    const b = layout.boxes.get('f:src/a/hard.ts')!
    const points = groundPath(terrain, a, b)
    expect(points.length).toBeGreaterThan(0)
    for (const [x, y, z] of points) {
      expect(y).toBeGreaterThan(heightAt(terrain.field, x, z) * terrain.scale)
      expect(y).toBeLessThan(terrain.scale * 1.2) // near the ground, not a tall arc through the sky
    }
  })
})

describe('peaks', () => {
  it('names the highest, apart from each other', () => {
    const centers = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 30, z: 0 },
      { x: 60, z: 0 },
    ]
    expect(peaks(centers, [0.9, 0.8, 0.5, 0.7], 3, 10)).toEqual([0, 3, 2])
    expect(peaks(centers, [0.9, 0.8, 0.5, 0.7], 2, 10)).toEqual([0, 3])
  })
})
