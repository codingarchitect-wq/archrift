// Coherence view, Clouds mode, part 2: the scene. The dots are the files
// shown that do some job; their places come from cloud.ts, worked out once per
// set of files in a worker. With no job picked there is one small cloud per
// job done several ways, side by side; with a job picked, its cloud alone, big.
// In each cloud the files doing that job take the color of their way, the
// rest stay as a faint outline of the system, and lines join the job's files
// that depend on each other: grey within one way, in both ways' colors across
// two (a transition).
import type { ConcernStats } from '../../../core/coherence.ts'
import type { Layout } from '../../layouts/types.ts'
import { emptyLayout } from '../../layouts/types.ts'
import { store } from '../../store.ts'
import { anchor } from '../arc42-kit/anchors.ts'
import type { ViewContext } from '../types.ts'
import { ALONE, CELL, arrangeClouds, boundsOf, dotRadius, placeIn } from './cloud.ts'
import type { Bounds, CloudInput, Point } from './cloud.ts'
import { choice } from './choice.ts'
import type { Coherence } from './model.ts'
import { groupColor } from './model.ts'

/** Most clouds side by side. */
export const MAX_CLOUDS = 24

export interface Dot {
  file: string
  x: number
  z: number
  r: number
  /** The way it takes in the cloud's job: a paradigm id, '*' for several, or null (doesn't do the job). */
  way: string | null
  /** Its group (index into the scene's groups). */
  group: number
  /** It does the job differently from its group: a culprit. */
  stray: boolean
}

export interface Cloud {
  concern: ConcernStats
  /** Its extent on the ground: a click anywhere in it opens it. */
  rect: { x0: number; z0: number; x1: number; z1: number }
  dots: Dot[]
  /** Pairs of dot indexes: files that depend on each other (all of them; the decoration fades those outside the job). */
  lines: [number, number][]
}

export interface CloudScene {
  kind: 'clouds' | 'cloud'
  clouds: Cloud[]
  /** The files shown as dots. */
  files: number
  /** The groups (folders or groups) the dots belong to, largest first, with their colors. */
  groups: { id: string; name: string; color: string }[]
}

/** Each layout's scene, for the decoration and the labels. */
export const cloudScenes = new WeakMap<Layout, CloudScene>()

// positions, per set of files: computed off the main thread, the last result kept as a warm start
const cache = new Map<string, Record<string, Point>>()
let last: Record<string, Point> | undefined
let pending = ''
let worker: Worker | undefined
let request = 0

function positionsFor(key: string, input: () => CloudInput, refresh: () => void): Record<string, Point> | undefined {
  const hit = cache.get(key)
  if (hit) return hit
  if (pending === key) return undefined
  pending = key
  const id = ++request
  worker ??= new Worker(new URL('./cloud.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<{ id: number; progress?: number; positions?: Record<string, Point> }>) => {
    if (e.data.id !== request) return // superseded
    if (e.data.positions) {
      cache.set(key, e.data.positions)
      last = e.data.positions
      pending = ''
      store.setState({ task: null })
      refresh()
    } else store.setState({ task: { label: 'Gathering the clouds', progress: e.data.progress ?? 0 } })
  }
  store.setState({ task: { label: 'Gathering the clouds', progress: 0 } })
  worker.postMessage({ id, input: { ...input(), previous: last } })
  return undefined
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

/**
 * The jobs that get a cloud: the one picked, else those done several ways (or, when none is, every job),
 * as far as some file shown does them (a job of the tests needs the tests shown).
 */
export function cloudConcerns(c: Coherence, picked: ConcernStats | undefined, shown: (id: string) => boolean = () => true): ConcernStats[] {
  if (picked) return [picked]
  const visible = c.model.concerns.filter(x => x.paradigms.some(p => p.files.some(shown)))
  const several = visible.filter(x => x.ways > 1)
  return (several.length ? several : visible).slice(0, MAX_CLOUDS)
}

/** The Clouds layout, or undefined while the dots' places are worked out. */
export function cloudsLayout(ctx: ViewContext, c: Coherence, picked: ConcernStats | undefined): Layout | undefined {
  const files = ctx.world.graph.nodes.filter(n => n.kind === 'file' && c.model.ways.has(n.id) && ctx.visibility.ids.has(n.id))
  const ids = new Set(files.map(f => f.id))
  const links: { source: string; target: string }[] = []
  for (const [a, targets] of ctx.graph.out) if (ids.has(a)) for (const b of targets) if (ids.has(b) && a !== b) links.push({ source: a, target: b })
  const key = `${ctx.visibility.key}|${c.blocks.kind}|${files.length}:${hash(files.map(f => f.id).join('\n'))}:${links.length}|${ctx.s.options.timeline ? ctx.s.options.at : ''}`
  const positions = positionsFor(
    key,
    () => ({ nodes: files.map(f => ({ id: f.id, block: c.blocks.of(f) ?? '', loc: f.metrics?.loc ?? 0 })), links }),
    ctx.refresh,
  )
  if (!positions) return undefined

  const concerns = cloudConcerns(c, picked, id => ids.has(id))
  const bounds: Bounds = boundsOf(files.map(f => positions[f.id]).filter(Boolean))
  const { cells, width, height } = arrangeClouds(Math.max(concerns.length, 1), bounds)
  const index = new Map(files.map((f, i) => [f.id, i]))
  const side = concerns.length > 1 ? CELL : ALONE
  const half = [((bounds.maxX - bounds.minX) * (cells[0]?.scale ?? 1)) / 2, ((bounds.maxY - bounds.minY) * (cells[0]?.scale ?? 1)) / 2]
  const pairs: [number, number][] = links.map(l => [index.get(l.source)!, index.get(l.target)!])
  // groups by size, each its color
  const blockOf = files.map(f => c.blocks.of(f) ?? '')
  const sizes = new Map<string, number>()
  for (const b of blockOf) sizes.set(b, (sizes.get(b) ?? 0) + 1)
  const groups = [...sizes]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id], i) => ({ id, name: id ? c.blocks.name(id) : '(none)', color: groupColor(i) }))
  const groupIndex = new Map(groups.map((g, i) => [g.id, i]))
  const clouds: Cloud[] = concerns.map((concern, k) => {
    const cell = cells[k]
    const strays = new Set(concern.strays)
    const dots: Dot[] = files.map((f, i) => {
      const [x, z] = placeIn(cell, bounds, positions[f.id] ?? [0, 0])
      const ways = c.model.ways.get(f.id)?.get(concern.concern.id)
      return {
        file: f.id,
        x,
        z,
        r: dotRadius(f.metrics?.loc ?? 0) * side,
        way: ways ? (ways.length > 1 ? '*' : ways[0]) : null,
        group: groupIndex.get(blockOf[i])!,
        stray: strays.has(f.id),
      }
    })
    return { concern, rect: { x0: cell.x - half[0], z0: cell.z - half[1], x1: cell.x + half[0], z1: cell.z + half[1] }, dots, lines: pairs }
  })

  const layout: Layout = {
    ...emptyLayout(),
    view: 'coherence',
    size: Math.max(width, height, 50),
    shape: 'sphere',
    arcAnchor: 'center',
    ground: false,
    hideBoxes: true,
    arcs: 'none',
    openFile: 'none',
    keepView: true,
    // from above, a little tilted: the clouds read like the essay's pictures (one cloud alone from farther);
    // looking a little beyond the middle keeps the top clear of the toolbar
    home: concerns.length > 1 ? [0, 0.98, 0.26] : [0, 1.35, 0.36],
    center: [0, 0, -Math.max(width, height) * 0.05],
  }
  const margin = Math.max(width, height) * 0.04
  anchor(layout, 'coh:heading', [-width / 2, 0, -height / 2 - margin], width)
  // one cloud: its dots are the files, to select, frame and label
  if (concerns.length === 1) for (const d of clouds[0].dots) layout.boxes.set(d.file, { x: d.x, y: 0, z: d.z, w: d.r * 2, h: d.r * 2, d: d.r * 2 }), layout.placement.set(d.file, 'building')
  // clouds side by side (even just one, none picked) have captions
  if (!picked) cells.slice(0, concerns.length).forEach((cell, k) => anchor(layout, `coh:cloud:${k}`, [cell.caption[0], 0, cell.caption[1]], 30))
  cloudScenes.set(layout, { kind: concerns.length === 1 && picked ? 'cloud' : 'clouds', clouds, files: files.length, groups })
  // the key names the groups' colors
  const named = groups.map(g => ({ name: g.name, color: g.color }))
  if (JSON.stringify(named) !== JSON.stringify(choice.getState().groups)) choice.setState({ groups: named })
  return layout
}
