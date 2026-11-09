// §5 Building Block View, part 4: what the scene shows, drawn with the arc42
// kit. Per board (one Drawing each, so a white box can rise into place on its
// own): the sheet, the blocks as slabs with paper tops and layer-colored
// walls, their lollipops, the connectors with arrowheads, and a white box's
// neighbors as dashed stubs. Between a black box and its white box, a faint
// beam (the zoom). Painting follows the selection: the block in focus and
// its connectors in the accent color, what isn't related to it faded.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import { BOARD_HEIGHT, ON_BOARD } from '../arc42-kit/board.ts'
import { fade, inkOf, toneColor } from '../arc42-kit/ink.ts'
import type { Ink } from '../arc42-kit/ink.ts'
import { GROUND, Sketch, level } from '../arc42-kit/sketch.ts'
import type { Drawing, P2, Rect, Surface } from '../arc42-kit/sketch.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { LOLLIPOP } from './diagram.ts'
import { focusOf } from './model.ts'
import type { Scene } from './scene.ts'

/** What each layout was made from (set by the plug-in). */
export const scenes = new WeakMap<Layout, { scene: Scene; chain: string }>()

/** What a drawn thing stands for. */
export type Owner =
  | { kind: 'unit'; board: number; index: number }
  | { kind: 'stub'; board: number; index: number }
  | { kind: 'wire'; board: number; link: number }

/** How strongly what isn't related to the focus fades. */
const DIM = 0.62
const FADE_MS = 650
const RISE_FROM = 7
const BEAM_OPACITY = 0.1
const EDGE_OPACITY = 0.55

/** Connector widths for light, medium and heavy dependencies. */
const WIDTHS = [0.26, 0.42, 0.64]

interface Built {
  drawing: Drawing
  group: THREE.Group
  /** Whether it appeared with this build (it fades and rises in). */
  fresh: boolean
  /** How opaque it ends up. */
  opacity: number
}

export class BlocksDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly engine: SceneEngine
  private scene: Scene | null = null
  private chain = ''
  private boards: Built[] = []
  private beams: Built[] = []
  private owners: Owner[] = []
  /** A key per board depth for what it held, so a rebuild animates only what's new. */
  private keys: string[] = []
  private born = -1
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(engine: SceneEngine) {
    this.engine = engine
  }

  update(ctx: ViewContext, layout: Layout) {
    const made = scenes.get(layout)
    if (!made) return
    if (made.scene !== this.scene) {
      const reframe = this.scene !== null && made.chain !== this.chain
      this.build(made.scene)
      this.chain = made.chain
      // a white box opened or closed: show every board
      if (reframe) this.engine.home()
    }
    this.paint(ctx)
  }

  animate(time: number) {
    if (this.born < 0) this.born = time
    const k = this.still ? 1 : Math.min(1, (time - this.born) / FADE_MS)
    const e = k * k * (3 - 2 * k)
    for (const b of this.boards) {
      if (!b.fresh) continue
      b.drawing.setOpacity(e)
      b.group.position.y = -RISE_FROM * (1 - e)
    }
    // beams come once their boards are in place
    const beam = Math.max(0, (k - 0.5) / 0.5)
    for (const b of this.beams) b.drawing.setOpacity(b.opacity * (b.fresh ? beam : 1))
    return k < 1
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    const scene = this.scene
    if (!scene) return undefined
    // the nearest board under the ray (the beams are see-through: never in the way)
    let best: { built: Built; distance: number } | undefined
    for (const built of this.boards) {
      const hit = raycaster.intersectObject(built.group, true)[0]
      if (hit && (!best || hit.distance < best.distance)) best = { built, distance: hit.distance }
    }
    if (!best) return undefined
    const owner = best.built.drawing.pick(raycaster)
    if (owner === undefined) return undefined
    const o = this.owners[owner]
    if (!o) return null
    const lv = scene.boards[o.board].level
    // a connector stands for its source: the block that uses the other
    const unit = o.kind === 'wire' ? lv.links[o.link].from : o.kind === 'unit' ? o.index : lv.units.length + o.index
    const id = unit < lv.units.length ? lv.units[unit].select : lv.stubs[unit - lv.units.length].select
    return { id, kind: 'building' }
  }

  stats(): Record<string, number> {
    const s = this.scene
    if (!s) return {}
    const deepest = s.boards[s.boards.length - 1]
    return {
      levels: s.boards.length,
      blocks: s.boards[0].level.units.length,
      links: s.boards[0].shown.length,
      hidden: s.boards[0].hidden,
      up: s.boards[0].shown.filter(i => s.boards[0].level.links[i].up).length,
      openBlocks: s.boards.length > 1 ? deepest.level.units.length : 0,
      stubs: s.boards.length > 1 ? deepest.level.stubs.length : 0,
      triangles: this.boards.reduce((n, b) => n + b.drawing.stats().triangles, 0),
    }
  }

  dispose() {
    for (const b of [...this.boards, ...this.beams]) b.drawing.dispose()
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  private build(scene: Scene) {
    for (const b of [...this.boards, ...this.beams]) {
      this.object.remove(b.group)
      b.drawing.dispose()
    }
    this.scene = scene
    this.owners = []
    this.boards = []
    this.beams = []
    const keys = scene.boards.map(b => `${b.level.container}|${b.shown.join(',')}|${b.w.toFixed(1)}|${b.d.toFixed(1)}`)
    scene.boards.forEach((b, k) => {
      const sk = new Sketch()
      const surface: Surface = k === 0 ? GROUND : level(b.y)
      // board coordinates (u, v from its top-left corner) on the surface
      const at = (u: number, v: number): P2 => [b.x - b.w / 2 + u, b.z - b.d / 2 + v]
      sheet(sk, surface, { u: b.x, v: b.z, w: b.w, h: b.d })
      const d = b.diagram
      const lv = b.level
      const n = lv.units.length

      // connectors first, under the blocks' rims and lollipops where they meet
      const weights = b.shown.map(i => lv.links[i].weight).sort((x, y) => y - x)
      const heavy = weights[Math.floor(weights.length * 0.15)] ?? Infinity
      const medium = weights[Math.floor(weights.length * 0.5)] ?? Infinity
      d.wires.forEach(w => {
        const link = lv.links[b.shown[w.edge]]
        const owner = this.own({ kind: 'wire', board: k, link: b.shown[w.edge] })
        const width = link.weight >= heavy ? WIDTHS[2] : link.weight >= medium ? WIDTHS[1] : WIDTHS[0]
        sk.ribbon({ tone: link.up || scene.mode === 'violations' ? 'up' : 'link', owner }, surface, w.points.map(p => at(p[0], p[1])), {
          width,
          lift: ON_BOARD + 0.04,
          round: 1.2,
          head: 'end',
          headLength: 1.5,
          headWidth: 1.25 + width,
        })
      })

      // the blocks, then their lollipops (the provided interfaces)
      d.boxes.forEach((box, i) => {
        const rect = { u: at(box.u, box.v)[0], v: at(box.u, box.v)[1], w: box.w, h: box.h }
        if (i < n) {
          const u = lv.units[i]
          const owner = this.own({ kind: 'unit', board: k, index: i })
          const wall = u.layer === undefined ? 'muted' : `cat:${u.layer}`
          sk.slab({ tone: wall, owner }, surface, rect, { r: 1.1, lift: ON_BOARD, height: b.heights[i], top: 'paper' })
          sk.frame({ tone: 'rim', owner }, surface, rect, { r: 1.1, lift: ON_BOARD + b.heights[i] + 0.02, width: 0.34 })
          const pop = d.lollipops[i]
          if (pop) {
            const c = at(pop[0], pop[1])
            const top = rect.v - rect.h / 2
            sk.ribbon({ tone: 'ink', owner }, surface, [[c[0], top], [c[0], c[1] + LOLLIPOP.r]], { width: 0.26, lift: ON_BOARD + 0.05 })
            sk.disc({ tone: 'paper', owner }, surface, c, LOLLIPOP.r, { lift: ON_BOARD + 0.06 })
            sk.ring({ tone: 'ink', owner }, surface, c, LOLLIPOP.r - LOLLIPOP.ring / 2, LOLLIPOP.r + LOLLIPOP.ring / 2, { lift: ON_BOARD + 0.07 })
          }
        } else {
          const owner = this.own({ kind: 'stub', board: k, index: i - n })
          sk.plate({ tone: 'stubFill', owner }, surface, rect, { r: 1, lift: ON_BOARD + 0.01 })
          sk.frame({ tone: 'stubRim', owner }, surface, rect, { r: 1, lift: ON_BOARD + 0.03, width: 0.26, dash: { on: 1.1, off: 0.75 } })
        }
      })
      const drawing = sk.build()
      const group = new THREE.Group()
      group.add(drawing.object)
      const fresh = keys[k] !== this.keys[k]
      if (!fresh || this.still) drawing.setOpacity(1)
      else drawing.setOpacity(0)
      this.object.add(group)
      this.boards.push({ drawing, group, fresh: fresh && !this.still, opacity: 1 })

      // the beam from the black box this board opens to the board's underside
      if (k > 0) this.beams.push(...this.beam(scene, k, fresh))
    })
    this.keys = keys
    this.born = -1
  }

  /** Four see-through faces from the opened block's top to the white box's underside, and their edges. */
  private beam(scene: Scene, k: number, fresh: boolean): Built[] {
    const prev = scene.boards[k - 1]
    const b = scene.boards[k]
    const box = prev.diagram.boxes[b.level.opened!]
    const cx = prev.x - prev.w / 2 + box.u
    const cz = prev.z - prev.d / 2 + box.v
    const y0 = prev.y + ON_BOARD + prev.heights[b.level.opened!] + 0.05
    const lower = [
      [cx - box.w / 2, y0, cz - box.h / 2],
      [cx + box.w / 2, y0, cz - box.h / 2],
      [cx + box.w / 2, y0, cz + box.h / 2],
      [cx - box.w / 2, y0, cz + box.h / 2],
    ] as const
    const y1 = b.y - 0.02
    const upper = [
      [b.x - b.w / 2, y1, b.z - b.d / 2],
      [b.x + b.w / 2, y1, b.z - b.d / 2],
      [b.x + b.w / 2, y1, b.z + b.d / 2],
      [b.x - b.w / 2, y1, b.z + b.d / 2],
    ] as const
    const sk = new Sketch()
    const edges = new Sketch()
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      const [a, c, a2, c2] = [lower[i], lower[j], upper[i], upper[j]]
      const u: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const v: [number, number, number] = [a2[0] - a[0], a2[1] - a[1], a2[2] - a[2]]
      const n = new THREE.Vector3(...v).cross(new THREE.Vector3(...u)).normalize()
      const s = Math.hypot(c2[0] - a2[0], c2[2] - a2[2]) / (Math.hypot(u[0], u[2]) || 1)
      const face: Surface = { origin: a, u, v, n: [n.x, n.y, n.z] }
      sk.polygon({ tone: 'beam' }, face, [
        [0, 0],
        [1, 0],
        [s, 1],
        [0, 1],
      ])
      edges.tube({ tone: 'beamEdge' }, [a, a2], 0.08, { samples: 2, radial: 6 })
    }
    return [
      [sk, BEAM_OPACITY],
      [edges, EDGE_OPACITY],
    ].map(([sketch, opacity]) => {
      const drawing = (sketch as Sketch).build()
      drawing.setOpacity(fresh && !this.still ? 0 : (opacity as number))
      const group = new THREE.Group()
      group.add(drawing.object)
      this.object.add(group)
      return { drawing, group, fresh: fresh && !this.still, opacity: opacity as number }
    })
  }

  private own(o: Owner) {
    this.owners.push(o)
    return this.owners.length - 1
  }

  // ── color ─────────────────────────────────────────────────────────────────

  private paint(ctx: ViewContext) {
    const scene = this.scene!
    const ink = inkOf(ctx.theme)
    const focus = focusOf(
      scene.boards.map(b => b.level),
      ctx.world,
      ctx.s.selected,
    )
    // per board: what the focus is linked to (null: no focus there, all bright)
    const related = scene.boards.map((b, k) => {
      const f = focus[k]
      if (f === undefined) return null
      const units = new Set([f])
      const links = new Set<number>()
      for (const i of b.shown) {
        const l = b.level.links[i]
        if (l.from !== f && l.to !== f) continue
        links.add(i)
        units.add(l.from === f ? l.to : l.from)
      }
      return { focus: f, units, links }
    })
    const color = (tone: string, owner: number) => paintOf(ink, tone, this.owners[owner], related, scene)
    for (const b of this.boards) b.drawing.paint(color)
    for (const b of this.beams) b.drawing.paint(color)
  }
}

/**
 * A board's sheet, as the kit's board() draws it but with its face and rim
 * lifted clear of the slab's top: 0.005 apart, they fight for depth at the
 * distances a whole staircase of boards is seen from.
 */
function sheet(sk: Sketch, s: Surface, rect: Rect) {
  const r = 4
  sk.slab({ tone: 'edge' }, s, rect, { r, height: BOARD_HEIGHT, top: 'board', bottom: true })
  sk.plate({ tone: 'board' }, s, rect, { r, lift: BOARD_HEIGHT + 0.04 })
  sk.frame({ tone: 'edge' }, s, rect, { r, lift: BOARD_HEIGHT + 0.05, width: 0.3 })
}

type Related = ({ focus: number; units: Set<number>; links: Set<number> } | null)[]

/** The color of a tone for what an owner stands for, given the focus on each board. */
function paintOf(ink: Ink, tone: string, o: Owner | undefined, related: Related, scene: Scene): THREE.Color {
  const r = o ? related[o.board] : null
  // a unit index on its board (stubs come after the units)
  const unitOn = o && o.kind !== 'wire' ? (o.kind === 'unit' ? o.index : scene.boards[o.board].level.units.length + o.index) : -1
  const lit = !r || !o || (o.kind === 'wire' ? r.links.has(o.link) : r.units.has(unitOn))
  const focused = !!r && o?.kind === 'unit' && r.focus === o.index
  let c: THREE.Color
  switch (tone) {
    case 'link':
      c = (r && o?.kind === 'wire' && r.links.has(o.link) ? ink.accent : ink.line).clone()
      break
    case 'up':
      c = ink.danger.clone()
      break
    case 'rim':
      c = focused ? ink.accent.clone() : ink.edge.clone()
      break
    case 'stubFill':
      c = ink.board.clone().lerp(ink.edge, 0.35)
      break
    case 'stubRim':
      c = ink.muted.clone()
      break
    case 'beam':
    case 'beamEdge':
      c = ink.accent.clone()
      break
    default:
      c = toneColor(ink, tone)
  }
  if (!lit) fade(c, ink, tone === 'paper' ? DIM * 0.55 : DIM)
  return c
}
