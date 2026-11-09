// Runtime view, part 4: the drawing. A board standing on the floor like a
// whiteboard, the sequence diagram on it: lifelines (dashed), their headers
// (boxes tinted by layer, a cylinder for a database, a stick figure for who
// starts it), activation bars standing out of the board by call depth (the
// deeper the stack, the further they reach toward you), messages as arrows on
// the front of the activation they start, alt fragments framed, the server
// side shaded behind a glass pane where the network is, and a pulse replaying
// the messages in order. Painted again on every selection or theme change.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import { ON_BOARD, board } from '../arc42-kit/board.ts'
import { Flows } from '../arc42-kit/flows.ts'
import { fade, inkOf, toneColor } from '../arc42-kit/ink.ts'
import type { Ink } from '../arc42-kit/ink.ts'
import { Sketch, at } from '../arc42-kit/sketch.ts'
import type { Drawing, P2, Surface, V3 } from '../arc42-kit/sketch.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { runtime } from './choice.ts'
import { ACT_W, HEADER_H, HEADER_RELIEF, ROW, relief } from './diagram.ts'
import type { Diagram } from './diagram.ts'
import type { Message } from './scenario.ts'

/** The diagram each runtime layout was made from, and the layer tone of each participant. */
export const diagrams = new WeakMap<Layout, { diagram: Diagram; tones: string[] }>()

/** Owners: participants are their index, messages MESSAGE + their index. */
export const MESSAGE = 100_000
const FADE_MS = 600
/** How far the glass pane reaches out of the board. */
const PANE_DEPTH = 1.8 * ROW
const DIM = 0.72

/** The wall the diagram is drawn on: its top-left corner at the board's, centered on x = 0. */
export const wallOf = (d: Diagram): Surface => ({ origin: [-d.width / 2, d.height, 0], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] })

/** A world point on the diagram's wall. */
export const onWall = (d: Diagram, u: number, v: number, lift = 0): V3 => at(wallOf(d), u, v, lift).toArray() as unknown as V3

const KIND_TONE: Record<Message['kind'], string> = {
  open: 'ink',
  call: 'line',
  self: 'line',
  render: 'line',
  new: 'line',
  rpc: 'accent',
  query: 'data',
  publish: 'data',
  deliver: 'line',
}

/** Arrow widths, as a share of a row. */
const KIND_WIDTH: Record<Message['kind'], number> = { open: 0.08, call: 0.065, self: 0.065, render: 0.065, new: 0.065, rpc: 0.105, query: 0.085, publish: 0.085, deliver: 0.065 }

export class RuntimeDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private drawing: Drawing | null = null
  /** The glass pane's rim (on its own surface, so its own drawing). */
  private paneRim: Drawing | null = null
  private flows: Flows | null = null
  private pane: THREE.Mesh | null = null
  private readonly paneMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide })
  private diagram: Diagram | null = null
  private related: { messages: Set<number>; participants: Set<number> } | null = null
  private fadeFrom = -1
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  /** Turning the replay on starts the frames again. */
  private readonly unsubscribe: () => void

  private readonly engine: SceneEngine
  /** The scenario drawn: another one brings the camera home to it. */
  private entry = ''

  constructor(engine: SceneEngine) {
    this.engine = engine
    let replay = runtime.getState().replay
    this.unsubscribe = runtime.subscribe(s => {
      if (s.replay !== replay) engine.requestRender()
      replay = s.replay
    })
  }

  update(ctx: ViewContext, layout: Layout) {
    const entry = diagrams.get(layout)
    if (!entry) {
      // a layout that only says something: nothing drawn
      this.clear()
      this.diagram = null
      return
    }
    if (entry.diagram !== this.diagram) {
      const other = this.entry && this.entry !== entry.diagram.scenario.entry
      this.build(entry.diagram, entry.tones)
      this.entry = entry.diagram.scenario.entry
      this.fadeFrom = -1
      if (other) this.engine.home()
    }
    this.related = relatedTo(ctx.s.selected, entry.diagram)
    this.paint(inkOf(ctx.theme))
  }

  animate(time: number) {
    if (!this.drawing) return false
    let moving = false
    if (!this.still) {
      if (this.fadeFrom < 0) this.fadeFrom = time
      const k = Math.min(1, (time - this.fadeFrom) / FADE_MS)
      const e = k * k * (3 - 2 * k)
      this.drawing.setOpacity(e)
      this.paneRim?.setOpacity(e)
      this.flows?.setOpacity(e)
      this.paneMaterial.opacity = 0.1 * e
      moving = k < 1
    }
    if (this.flows && runtime.getState().replay && this.flows.animate(time)) moving = true
    return moving
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    const d = this.diagram
    if (!d || !this.drawing) return undefined
    // the board and frames stand for nothing: the engine then looks at the headers' boxes (names included)
    const owner = this.drawing.pick(raycaster)
    if (owner === undefined || owner < 0) return undefined
    if (owner >= MESSAGE) {
      const m = d.scenario.messages[owner - MESSAGE]
      return m ? { id: m.target, kind: 'building' } : null
    }
    const p = d.scenario.participants[owner]
    return p ? { id: p.id, kind: 'building' } : null
  }

  stats(): Record<string, number> {
    const d = this.diagram
    if (!d) return {}
    const s = d.scenario
    return {
      participants: s.participants.length,
      messages: s.messages.length,
      fragments: s.fragments.length,
      rpc: s.messages.filter(m => m.kind === 'rpc').length,
      queries: s.messages.filter(m => m.kind === 'query').length,
      databases: s.participants.filter(p => p.kind === 'database').length,
      server: s.participants.filter(p => p.side === 'server').length,
      depth: Math.max(0, ...s.messages.map(m => m.depth)),
      hidden: s.messages.reduce((n, m) => n + m.hidden, 0),
      highlighted: this.related?.messages.size ?? 0,
      pane: this.pane ? 1 : 0,
      triangles: this.drawing?.stats().triangles ?? 0,
      dots: this.flows?.stats().dots ?? 0,
    }
  }

  dispose() {
    this.unsubscribe()
    this.clear()
    this.paneMaterial.dispose()
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  private clear() {
    this.drawing?.dispose()
    this.paneRim?.dispose()
    this.flows?.dispose()
    this.pane?.geometry.dispose()
    this.object.clear()
    this.drawing = this.paneRim = null
    this.flows = null
    this.pane = null
  }

  private build(d: Diagram, tones: string[]) {
    this.clear()
    this.diagram = d
    const s = wallOf(d)
    const sk = new Sketch()
    const { participants, messages } = d.scenario
    const lift = (x: number) => ON_BOARD + x

    board(sk, s, { u: d.width / 2, v: d.height / 2, w: d.width, h: d.height }, { r: 3 })
    // the server side, shaded
    if (d.boundary)
      sk.plate({ tone: 'band' }, s, { u: (d.boundary.u + d.width - 1.2) / 2, v: (2.6 * ROW + d.height - 0.4) / 2, w: d.width - 1.2 - d.boundary.u, h: d.height - 0.4 - 2.6 * ROW }, { r: 2, lift: lift(0.005) })

    // lifelines
    d.columns.forEach((c, i) => {
      const top = participants[i].kind === 'actor' ? c.top + 0.4 * ROW : c.top
      sk.ribbon({ tone: 'muted', owner: i }, s, [[c.u, top], [c.u, c.bottom]], { width: 0.04 * ROW, lift: lift(0.01), dash: { on: 0.22 * ROW, off: 0.18 * ROW } })
    })

    // alt fragments: frame, the `alt` tag, dashed lines between operands
    for (const f of d.fragments) {
      sk.frame({ tone: 'ink' }, s, { u: (f.u0 + f.u1) / 2, v: (f.v0 + f.v1) / 2, w: f.u1 - f.u0, h: f.v1 - f.v0 }, { r: 0.15 * ROW, lift: lift(0.02), width: 0.05 * ROW })
      // the `alt` tag: a pentagon in the top-left corner
      const t: P2[] = [
        [f.u0, f.v0],
        [f.u0 + f.tagW, f.v0],
        [f.u0 + f.tagW, f.v0 + 0.5 * ROW],
        [f.u0 + f.tagW - 0.15 * ROW, f.v0 + 0.82 * ROW],
        [f.u0, f.v0 + 0.82 * ROW],
      ]
      sk.polygon({ tone: 'tag' }, s, t, { lift: lift(0.03) })
      for (const v of f.dividers) sk.ribbon({ tone: 'ink' }, s, [[f.u0, v], [f.u1, v]], { width: 0.035 * ROW, lift: lift(0.02), dash: { on: 0.2 * ROW, off: 0.15 * ROW } })
    }

    // headers
    const headerV = d.headerV
    participants.forEach((p, i) => {
      const c = d.columns[i]
      const owner = i
      if (p.kind === 'actor') return stickFigure(sk, s, c.u, headerV, owner, lift(0.04))
      if (p.kind === 'database') {
        const r = Math.min(c.headerW / 2, 0.48 * ROW)
        const h = HEADER_H * 1.05
        const base = onWall(d, c.u, headerV + h / 2, lift(r + 0.02))
        const m = new THREE.Matrix4().makeTranslation(base[0], base[1] + h / 2, base[2])
        sk.solid({ tone: 'data', owner }, new THREE.CylinderGeometry(r, r, h, 36), m)
        // the rims of a database drum
        for (const y of [h * 0.18, h * 0.36]) {
          const ring: V3[] = []
          for (let k = 0; k < 36; k++) {
            const a = (k / 36) * Math.PI * 2
            ring.push([base[0] + Math.cos(a) * r * 1.01, base[1] + h - y, base[2] + Math.sin(a) * r * 1.01])
          }
          sk.tube({ tone: 'dataRim', owner }, ring, 0.018 * ROW, { closed: true, samples: 48, radial: 5 })
        }
        return
      }
      const rect = { u: c.u, v: headerV, w: c.headerW, h: HEADER_H }
      sk.slab({ tone: tones[i], owner }, s, rect, { r: 0.12 * ROW, lift: lift(0), height: HEADER_RELIEF, top: 'paper' })
      // a band of the layer's color across its foot, and a dashed outline for an interface
      sk.plate({ tone: tones[i], owner }, s, { u: c.u, v: headerV + HEADER_H / 2 - 0.1 * ROW, w: c.headerW - 0.12 * ROW, h: 0.14 * ROW }, { r: 0.05 * ROW, lift: lift(HEADER_RELIEF + 0.02) })
      if (p.kind === 'interface' || p.kind === 'topic')
        sk.frame({ tone: 'ink', owner }, s, { ...rect, w: rect.w - 0.14 * ROW, h: rect.h - 0.14 * ROW }, { r: 0.1 * ROW, lift: lift(HEADER_RELIEF + 0.03), width: 0.03 * ROW, dash: { on: 0.12 * ROW, off: 0.09 * ROW } })
    })

    // activations, outermost first so nested ones (drawn later) sit on top
    for (const a of [...d.activations].sort((x, y) => x.depth - y.depth || x.message - y.message))
      sk.slab({ tone: tones[a.participant], owner: MESSAGE + a.message }, s, { u: a.u, v: (a.v0 + a.v1) / 2, w: ACT_W, h: a.v1 - a.v0 }, { r: 0.04 * ROW, lift: lift(0), height: relief(a.depth), top: 'paper' })

    // messages: a glow under the network calls, then the arrows
    for (const a of d.arrows) {
      const m = messages[a.message]
      if (m.kind === 'rpc') sk.ribbon({ tone: 'glow', owner: MESSAGE + a.message }, s, a.points, { width: 0.28 * ROW, lift: lift(a.lift - 0.01) })
    }
    for (const a of d.arrows) {
      const m = messages[a.message]
      const width = KIND_WIDTH[m.kind]
      sk.ribbon({ tone: m.collapsed ? 'muted' : KIND_TONE[m.kind], owner: MESSAGE + a.message }, s, a.points, {
        width: width * ROW,
        lift: lift(a.lift),
        head: 'end',
        headLength: 0.32 * ROW,
        headWidth: 0.27 * ROW,
        round: a.points.length > 2 ? 0.12 * ROW : 0,
        // a delivery is asynchronous: dashed
        ...(m.kind === 'deliver' ? { dash: { on: 0.22 * ROW, off: 0.14 * ROW } } : {}),
      })
    }
    this.drawing = sk.build()
    this.object.add(this.drawing.object)

    // the network: a glass pane standing out of the board between the two sides
    if (d.boundary) {
      const top = 2.6 * ROW
      const bottom = d.height - 0.4
      const h = bottom - top
      const [x, y] = onWall(d, d.boundary.u, (top + bottom) / 2)
      const plane = new THREE.PlaneGeometry(PANE_DEPTH, h).rotateY(Math.PI / 2).translate(x, y, ON_BOARD + PANE_DEPTH / 2)
      this.pane = new THREE.Mesh(plane, this.paneMaterial)
      this.pane.renderOrder = 3
      const edge = new Sketch()
      const side: Surface = { origin: onWall(d, d.boundary.u, top, ON_BOARD), u: [0, 0, 1], v: [0, -1, 0], n: [1, 0, 0] }
      edge.frame({ tone: 'accent' }, side, { u: PANE_DEPTH / 2, v: h / 2, w: PANE_DEPTH, h }, { r: 0.15 * ROW, width: 0.04 * ROW })
      const rim = edge.build()
      this.object.add(this.pane, rim.object)
      // the pane's rim is part of the drawing's family: painted and faded with it
      this.paneRim = rim
    }

    // the replay: a pulse along the messages in order, down the lifelines between them
    const path: V3[] = []
    d.arrows.forEach((a, k) => {
      const z = ON_BOARD + a.lift + 0.09 * ROW
      const first = a.points[0]
      if (k > 0) {
        const prev = path[path.length - 1]
        const corner = onWall(d, uOf(d, prev), first[1], z)
        path.push(corner)
      }
      for (const p of a.points) path.push(onWall(d, p[0], p[1], z))
    })
    if (path.length > 1) {
      const length = path.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - path[i][0], p[1] - path[i][1], p[2] - path[i][2]), 0)
      this.flows = new Flows([{ points: path, tone: 'accent', speed: 5.5 * ROW, spacing: Math.max(7.5 * ROW, length / 4), size: 0.11 * ROW }], { still: this.still })
      this.object.add(this.flows.object)
    }
  }

  private paint(ink: Ink) {
    const related = this.related
    const color = (tone: string, owner: number) => {
      const c = runtimeTone(ink, tone)
      if (!related || owner < 0) return c
      const on = owner >= MESSAGE ? related.messages.has(owner - MESSAGE) : related.participants.has(owner)
      return on ? c : fade(c, ink, DIM)
    }
    this.drawing?.paint(color)
    this.paneRim?.paint(color)
    this.flows?.paint(color)
    this.paneMaterial.color.copy(ink.accent)
  }
}

/** The colors of the runtime view's own tones, then the kit's. */
export function runtimeTone(ink: Ink, tone: string): THREE.Color {
  switch (tone) {
    case 'data':
      return ink.warn.clone()
    case 'dataRim':
      return ink.warn.clone().lerp(ink.ink, 0.35)
    case 'band':
      return ink.accent.clone().lerp(ink.board, ink.light ? 0.94 : 0.965)
    case 'glow':
      return ink.accent.clone().lerp(ink.board, 0.7)
    case 'tag':
      return ink.edge.clone().lerp(ink.board, ink.light ? 0.2 : 0)
    default:
      return toneColor(ink, tone)
  }
}

/** What the selection touches: messages from, to or about it, and their lifelines; null when it isn't in the diagram. */
export function relatedTo(selected: string | null, d: Diagram): { messages: Set<number>; participants: Set<number> } | null {
  if (!selected) return null
  const { participants, messages } = d.scenario
  // a lifeline: its file or group itself, or (grouped) a file of its group
  const file = selected.startsWith('f:') ? selected : null
  const lane = participants.findIndex(p => p.kind !== 'actor' && (p.id === selected || (!!file && !!p.members?.includes(file))))
  const out = { messages: new Set<number>(), participants: new Set<number>() }
  messages.forEach((m, k) => {
    const hit = lane >= 0 ? m.from === lane || m.to === lane : m.target === selected || m.source === selected
    if (!hit) return
    out.messages.add(k)
    out.participants.add(m.from).add(m.to)
  })
  if (lane >= 0) out.participants.add(lane)
  return out.messages.size || lane >= 0 ? out : null
}

/** Who starts the scenario: a stick figure in ink, above its lifeline. */
function stickFigure(sk: Sketch, s: Surface, u: number, v: number, owner: number, lift: number) {
  const paint = { tone: 'ink', owner }
  const k = ROW / 4
  const w = 0.2 * k
  sk.ring(paint, s, [u, v - 1.0 * k], 0.48 * k, 0.48 * k + w, { lift })
  sk.ribbon(paint, s, [[u, v - 0.32 * k], [u, v + 0.75 * k]], { width: w, lift })
  sk.ribbon(paint, s, [[u - 0.85 * k, v + 0.05 * k], [u + 0.85 * k, v + 0.05 * k]], { width: w, lift })
  sk.ribbon(paint, s, [[u - 0.7 * k, v + 1.6 * k], [u, v + 0.75 * k], [u + 0.7 * k, v + 1.6 * k]], { width: w, lift })
}

/** The u coordinate of a world point on the diagram's wall. */
const uOf = (d: Diagram, p: V3) => p[0] + d.width / 2
