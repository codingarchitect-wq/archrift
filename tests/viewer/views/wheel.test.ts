import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../../../src/core/model.ts'
import type { ArcSpec } from '../../../src/viewer/scene/engine.ts'
import type { ViewContext } from '../../../src/viewer/views/types.ts'
import wheel from '../../../src/viewer/views/wheel/index.ts'
import { BETA, RADIUS, bspline, controlPolygon, hitAt, polar, routePoints, wheelLayout } from '../../../src/viewer/views/wheel/layout.ts'
import type { Point, Wheel } from '../../../src/viewer/views/wheel/layout.ts'

const TAU = Math.PI * 2

/** Directories and files for a list of paths, under the root `d:.`. */
function tree(paths: string[]): GraphNode[] {
  const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'repo', path: '' }]])
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!nodes.has(`d:${dir}`)) nodes.set(`d:${dir}`, { id: `d:${dir}`, kind: 'directory', name: parts[i - 1], path: dir, parent: i > 1 ? `d:${parts.slice(0, i - 1).join('/')}` : 'd:.' })
    }
    const parent = parts.length > 1 ? `d:${parts.slice(0, -1).join('/')}` : 'd:.'
    nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts.at(-1)!, path, parent, metrics: { loc: 20 + path.length * 7 } })
  }
  return [...nodes.values()]
}

const PATHS = ['src/a/x.ts', 'src/a/y.ts', 'src/a/deep/z.ts', 'src/b/p.ts', 'src/b/q.ts', 'src/main.ts', 'docs/readme.ts']
const all = () => true
const layoutOf = (paths = PATHS) => wheelLayout({ nodes: tree(paths), rootId: 'd:.', isVisible: all })
const under = (dir: string) => (id: string) => id.startsWith(`f:${dir}/`)
const radius = (p: Point) => Math.hypot(p[0], p[2])

describe('the wheel’s angles', () => {
  const w = layoutOf()

  it('go round the whole circle once, in path order, a file’s tick as wide as any other’s', () => {
    const ids = w.marks.map(m => m.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toHaveLength(PATHS.length)
    for (let i = 0; i < w.marks.length; i++) {
      const m = w.marks[i]
      expect(m.end).toBeGreaterThan(m.start)
      expect(m.angle).toBeCloseTo((m.start + m.end) / 2)
      if (i) expect(m.start).toBeGreaterThanOrEqual(w.marks[i - 1].end - 1e-9)
      expect(m.end - m.start).toBeCloseTo(w.marks[0].end - w.marks[0].start)
    }
    // ticks and gaps fill 360°, the gap between the last tick and the first split at the top
    expect(w.marks[0].start).toBeGreaterThan(0)
    expect(w.marks[0].start).toBeCloseTo(TAU - w.marks.at(-1)!.end)
  })

  it('give each folder one contiguous sector holding exactly its files, sectors nested and bands deeper outward', () => {
    for (const s of w.sectors) {
      const dir = s.id.slice(2)
      const inside = w.marks.filter(m => m.angle >= s.start && m.angle <= s.end).map(m => m.id)
      expect(inside).toEqual(w.marks.map(m => m.id).filter(under(dir)))
      const parent = w.sectors.find(p => p.id === w.parent.get(s.id))
      if (parent) {
        expect(s.start).toBeGreaterThanOrEqual(parent.start)
        expect(s.end).toBeLessThanOrEqual(parent.end)
        expect(s.inner).toBeGreaterThan(parent.outer)
      }
    }
    expect(w.sectors.map(s => s.id).sort()).toEqual(['d:docs', 'd:src', 'd:src/a', 'd:src/a/deep', 'd:src/b'])
    expect(w.levels).toBe(3)
    expect(Math.min(...w.sectors.map(s => s.inner))).toBeCloseTo(w.hub)
    expect(Math.max(...w.sectors.map(s => s.outer))).toBeLessThan(w.radius)
  })

  it('give siblings no gap and wider gaps where the tree splits higher up', () => {
    const [x, y] = ['f:src/a/x.ts', 'f:src/a/y.ts'].map(id => w.marks.find(m => m.id === id)!)
    expect(y.start - x.end).toBeCloseTo(0)
    const gap = (a: string, b: string) => w.marks.find(m => m.id === b)!.start - w.marks.find(m => m.id === a)!.end
    expect(gap('f:src/a/y.ts', 'f:src/b/p.ts')).toBeLessThan(gap('f:docs/readme.ts', 'f:src/a/deep/z.ts'))
  })

  it('are the same whatever order the nodes come in', () => {
    const nodes = tree(PATHS)
    const shuffled = [...nodes].reverse()
    shuffled.push(shuffled.shift()!)
    const again = wheelLayout({ nodes: shuffled, rootId: 'd:.', isVisible: all })
    expect([...again.layout.boxes].sort()).toEqual([...w.layout.boxes].sort())
    expect(again.marks).toEqual(w.marks)
    expect(again.sectors).toEqual(w.sectors)
  })

  it('place a box for every file on the ring and for every folder on its band, pickable there', () => {
    for (const m of w.marks) {
      const b = w.layout.boxes.get(m.id)!
      expect(Math.hypot(b.x, b.z)).toBeCloseTo(RADIUS)
      expect(w.layout.placement.get(m.id)).toBe('building')
      const [x, z] = polar(RADIUS + 0.5, m.angle)
      expect(hitAt(w, x, z)).toEqual({ id: m.id, kind: 'mark' })
    }
    for (const s of w.sectors) {
      const b = w.layout.boxes.get(s.id)!
      expect(Math.hypot(b.x, b.z)).toBeCloseTo((s.inner + s.outer) / 2)
      expect(w.layout.placement.get(s.id)).toBe('cluster')
      expect(hitAt(w, b.x, b.z)).toEqual({ id: s.id, kind: 'sector' })
    }
    expect(hitAt(w, 0, 0)).toBeUndefined() // the open middle: the arcs'
    expect(hitAt(w, 0, -RADIUS * 3)).toBeUndefined()
    expect(w.layout).toMatchObject({ view: 'wheel', ground: false, arcAnchor: 'center', hideBoxes: true, keepView: true })
  })

  it('name the top folders off the ring, and those inside one that holds more than half the circle instead of it', () => {
    const labels = w.labels.map(l => [l.sector, l.level])
    // src holds 6 of 7 files: its folders speak for it
    expect(labels).toContainEqual(['d:src/a', 0])
    expect(labels).toContainEqual(['d:docs', 0])
    expect(labels).toContainEqual(['d:src/a/deep', 1])
    expect(labels.map(l => l[0])).not.toContain('d:src')
    for (const l of w.labels) expect(Math.hypot(w.layout.boxes.get(l.id)!.x, w.layout.boxes.get(l.id)!.z)).toBeGreaterThan(RADIUS)
  })
})

describe('routes', () => {
  const w = layoutOf()
  const center = (id: string): Point => {
    const b = w.layout.boxes.get(id)!
    return [b.x, b.y + b.h / 2, b.z]
  }
  const control = (id: string): Point => {
    const [x, z] = w.control.get(id)!
    return [x, center('f:src/a/x.ts')[1], z]
  }
  /** Where a control point lands after straightening: β of it, 1 − β of the chord. */
  const straightened = (p: Point, a: Point, b: Point, t: number) => p.map((v, c) => BETA * v + (1 - BETA) * (a[c] + t * (b[c] - a[c])))

  it('go in from each end through its folders to the lowest common ancestor and back out', () => {
    const cases: [string, string, string[], string][] = [
      ['f:src/a/x.ts', 'f:src/a/y.ts', ['d:src/a'], 'd:src/a'],
      ['f:src/a/x.ts', 'f:src/b/p.ts', ['d:src/a', 'd:src', 'd:src/b'], 'd:src'],
      ['f:src/a/deep/z.ts', 'f:docs/readme.ts', ['d:src/a/deep', 'd:src/a', 'd:src', 'd:.', 'd:docs'], 'd:.'],
    ]
    for (const [source, target, path, lca] of cases) {
      const points = controlPolygon(w, source, target)!
      // the two ends, where it leaves and enters the bands, the tree nodes between
      expect(points).toHaveLength(path.length + 4)
      points[0].forEach((v, c) => expect(v).toBeCloseTo(center(source)[c], 9))
      points[points.length - 1].forEach((v, c) => expect(v).toBeCloseTo(center(target)[c], 9))
      const last = points.length - 1
      path.forEach((id, i) => {
        const expected = straightened(control(id), points[0], points[last], (i + 2) / last)
        points[i + 2].forEach((v, c) => expect(v).toBeCloseTo(expected[c], 9))
      })
      // the exits are on the bands' inner edge before straightening, at each end's angle
      const exit = straightened([...(([x, z]) => [x, 0, z])(polar(w.hub, w.angle.get(source)!))] as Point, points[0], points[last], 1 / last)
      expect(points[1][0]).toBeCloseTo(exit[0], 9)
      expect(points[1][2]).toBeCloseTo(exit[2], 9)
      // the route passes the common ancestor: the B-spline there, (previous + 4 × it + next) / 6
      const route = routePoints(w, source, target)!
      expect(route).toHaveLength(points.length - 2)
      const at = path.indexOf(lca) + 2
      route[at - 1].forEach((v, c) => expect(v).toBeCloseTo((points[at - 1][c] + 4 * points[at][c] + points[at + 1][c]) / 6, 9))
      // and that's its innermost point (unless a folder above spans most of the circle, which sits in the middle too)
      const innermost = route.reduce((best, p, i) => (radius(p) < radius(route[best]) ? i : best), 0)
      if (lca !== 'd:.') expect(innermost).toBe(at - 1)
    }
  })

  it('run through the middle between parts of the tree that only meet at the root', () => {
    const route = routePoints(w, 'f:src/a/deep/z.ts', 'f:docs/readme.ts')!
    expect(Math.min(...route.map(radius))).toBeLessThan(w.hub * 0.3)
    // and stay near the ring between siblings
    const near = routePoints(w, 'f:src/a/x.ts', 'f:src/a/y.ts')!
    expect(Math.min(...near.map(radius))).toBeGreaterThan(w.hub * 0.4)
  })

  it('are straight lines with β = 0, and none for an end the wheel doesn’t have', () => {
    const a = center('f:src/a/x.ts')
    const b = center('f:docs/readme.ts')
    for (const p of routePoints(w, 'f:src/a/x.ts', 'f:docs/readme.ts', 0)!) {
      // on the chord: the cross product with it vanishes
      const cross = (p[0] - a[0]) * (b[2] - a[2]) - (p[2] - a[2]) * (b[0] - a[0])
      expect(Math.abs(cross)).toBeLessThan(1e-6)
    }
    expect(routePoints(w, 'f:src/a/x.ts', 'f:nowhere.ts')).toBeNull()
  })

  it('are smoothed as a clamped cubic B-spline', () => {
    const control: Point[] = [
      [0, 0, 0],
      [6, 0, 0],
      [6, 0, 6],
      [0, 0, 6],
    ]
    const once = bspline(control, 1)
    expect(once).toHaveLength(control.length)
    // at each control point: (previous + 4 × it + next) / 6, the ends repeated
    expect(once[1]).toEqual([(0 + 24 + 6) / 6, 0, (0 + 0 + 6) / 6])
    expect(bspline(control, 4)).toHaveLength((control.length + 1) * 4 - 1)
    // it starts off along the first leg (z = 0) and ends along the last (z = 6)
    expect(once[0]).toEqual([1, 0, 0])
    expect(once.at(-1)).toEqual([1, 0, 6])
  })
})

describe('a wheel of 10,000 files', () => {
  // 10 top folders × 10 × 5 folders of 20 files
  const paths: string[] = []
  for (let i = 0; i < 10_000; i++) paths.push(`src/area${i % 10}/feature${Math.floor(i / 10) % 10}/part${Math.floor(i / 100) % 5}/file${i}.ts`)
  const w = layoutOf(paths)

  it('folds the deepest folders into one tick each, sized by their files', () => {
    expect(w.marks.length).toBeLessThanOrEqual(1500)
    expect(w.folded).toBe(500)
    expect(w.marks.every(m => m.folded && m.files === 20 && m.id.startsWith('d:'))).toBe(true)
    // sectors stay proportional to files
    const spans = w.marks.map(m => m.end - m.start)
    expect(Math.max(...spans) / Math.min(...spans)).toBeCloseTo(1)
  })

  it('keeps a box for every file and folder, where its tick is, so arcs and the selection still find them', () => {
    const f = 'f:src/area3/feature4/part2/file243.ts'
    const mark = w.markOf.get(f)!
    expect(mark).toBe('d:src/area3/feature4/part2')
    expect(w.layout.boxes.get(f)).toMatchObject({ x: w.layout.boxes.get(mark)!.x, z: w.layout.boxes.get(mark)!.z })
    for (const p of paths) expect(w.layout.boxes.has(`f:${p}`)).toBe(true)
    for (const dir of ['d:src', 'd:src/area3', 'd:src/area3/feature4', 'd:src/area3/feature4/part2']) expect(w.layout.boxes.has(dir)).toBe(true)
    // a hidden file routes like its folded folder
    expect(routePoints(w, f, 'f:src/area7/feature1/part0/file17.ts')).toEqual(routePoints(w, mark, 'd:src/area7/feature1/part0'))
  })

  it('bands every folder shown, the folded ones included', () => {
    expect(w.levels).toBe(4)
    expect(w.sectors).toHaveLength(1 + 10 + 100 + 500)
  })
})

describe('a wheel by the toolbar’s grouping', () => {
  const nodes = tree(PATHS)
  const group: Record<string, string> = { 'f:src/a/x.ts': 'g:one', 'f:src/b/q.ts': 'g:one', 'f:docs/readme.ts': 'g:two', 'f:src/main.ts': 'g:two' }
  const w = wheelLayout({
    nodes,
    rootId: 'd:.',
    isVisible: all,
    groups: [
      { id: 'g:one', label: 'src/a · 2 files' },
      { id: 'g:two', label: 'lib/deep/path/docs · 2 files (50% there)' },
      { id: 'g:empty', label: 'nothing' },
    ],
    groupOf: id => group[id],
  })

  it('makes one band per group with files, its files together, the rest directly on the ring', () => {
    expect(w.sectors.map(s => s.id)).toEqual(['g:one', 'g:two'])
    const one = w.sectors[0]
    expect(w.marks.filter(m => m.angle >= one.start && m.angle <= one.end).map(m => m.id)).toEqual(['f:src/a/x.ts', 'f:src/b/q.ts'])
    expect(w.parent.get('f:src/a/y.ts')).toBe('d:.')
    expect(w.labels.map(l => [l.text, l.group])).toEqual([
      ['src/a', true],
      ['…/path/docs', true],
    ])
    expect(controlPolygon(w, 'f:src/a/x.ts', 'f:docs/readme.ts')).toHaveLength(4 + 3) // group, root, group
  })
})

describe('the Wheel plug-in', () => {
  const nodes = tree(PATHS)
  const ctx = (bundle: boolean) =>
    ({
      s: { options: { bundle } },
      world: { graph: { nodes }, rootId: 'd:.' },
      visibility: { isVisible: all },
      grouping: null,
      theme: { background: '#0e1117' },
    }) as unknown as ViewContext
  const layout = wheel.layout(ctx(true))!
  const arc = (width?: 1 | 2 | 3): ArcSpec => ({ source: 'f:src/a/x.ts', target: 'f:docs/readme.ts', from: new THREE.Color(0.2, 0.4, 0.6), to: new THREE.Color(0.6, 0.4, 0.2), width })

  it('routes focus and background arcs, keeping background ones thin with more ink for more weight', () => {
    const focus = wheel.routeArc!(ctx(true), layout, arc())!
    expect(focus.points!.length).toBeGreaterThan(3)
    expect(focus.width).toBeUndefined()
    const heavy = wheel.routeArc!(ctx(true), layout, arc(3))!
    expect(heavy.width).toBe(1)
    expect(heavy.from.r).toBeGreaterThan(0.2)
    const straight = wheel.routeArc!(ctx(false), layout, arc())!
    expect(straight.points).toEqual(routePoints(wheelLayout({ nodes, rootId: 'd:.', isVisible: all }) as Wheel, 'f:src/a/x.ts', 'f:docs/readme.ts', 0))
    expect(wheel.routeArc!(ctx(true), layout, { ...arc(), target: 'f:gone.ts' })).toBeNull()
  })

  it('labels folders off the ring', () => {
    const labels = wheel.labels!(ctx(true), layout)
    expect(labels.map(l => l.text)).toContain('docs')
    expect(labels.every(l => layout.boxes.has(l.id))).toBe(true)
  })
})
