// §3 Context view, part 5: what the engine's boxes don't draw. The board and
// the dashed system boundary, the tower's layer slabs inside a glass shell,
// the neighbors' icons, the ties as tubes with dots flowing along them (into
// the system for callers, out of it for what it calls), all in one Sketch
// painted by owner, so the selection lights its neighbors, ties and layers
// and fades the rest without rebuilding.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import { BOARD_HEIGHT, ON_BOARD } from '../arc42-kit/board.ts'
import { Flows } from '../arc42-kit/flows.ts'
import { fade, inkOf, toneColor } from '../arc42-kit/ink.ts'
import type { Ink } from '../arc42-kit/ink.ts'
import { GROUND, Sketch } from '../arc42-kit/sketch.ts'
import type { Drawing, Rect } from '../arc42-kit/sketch.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { drawIcon } from './icons.ts'
import { NO_LAYER } from './model.ts'
import type { ContextModel, Tie } from './model.ts'
import { SHELL, TOWER } from './place.ts'
import type { ContextPlan } from './place.ts'
import { litBy, maps } from './state.ts'
import type { ContextMap, Lit } from './state.ts'

/** Owners: neighbors from 0, ties from TIE, slabs from SLAB. */
const TIE = 10_000
const SLAB = 20_000
/** How far what isn't selected sinks toward the ground (colors mix in linear light, so this reads as about two thirds). */
const FADE = 0.9
const FADE_MS = 650

/** A tie's tube: thicker with more files. */
export const tubeRadius = (files: number) => Math.min(0.55, 0.2 + 0.07 * Math.log2(1 + files))

/** The color of a side of the diagram: callers, what the system calls, its data stores. */
export function sideColor(side: string, ink: Ink): THREE.Color {
  if (side === 'in') return ink.accent.clone()
  if (side === 'store') return ink.ok.clone()
  return new THREE.Color(ink.light ? '#8250df' : '#a371f7')
}

/** A tie's color: inbound ties are the callers' color whoever the neighbor is (a webhook comes in), the rest their neighbor's side. */
export const tieSide = (tie: Tie, side: string) => (tie.dir === 'in' ? 'in' : side)

export class ContextDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private drawing: Drawing | null = null
  private flows: Flows | null = null
  private readonly glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false }))
  private readonly glassEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ transparent: true }))
  private map: ContextMap | null = null
  /** Tie owner → [neighbor, tie]. */
  private tieOf: [number, number][] = []
  private lit: Lit | null = null
  private fadeFrom = -1
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor() {
    this.glass.renderOrder = 0
    this.object.add(this.glass, this.glassEdges)
  }

  update(ctx: ViewContext, layout: Layout) {
    const map = maps.get(layout)
    if (!map) return
    if (map !== this.map) {
      this.map = map
      this.build(map.model, map.plan)
    }
    this.lit = litBy(ctx, map.model)
    this.paint(inkOf(ctx.theme))
  }

  animate(time: number) {
    if (this.fadeFrom < 0) this.fadeFrom = time
    const k = this.still ? 1 : Math.min(1, (time - this.fadeFrom) / FADE_MS)
    const e = k * k * (3 - 2 * k)
    this.drawing?.setOpacity(e)
    this.flows?.setOpacity(e)
    ;(this.glass.material as THREE.MeshLambertMaterial).opacity = 0.13 * e
    ;(this.glassEdges.material as THREE.LineBasicMaterial).opacity = 0.55 * e
    const moving = this.flows?.animate(time) ?? false
    return k < 1 || moving
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    const map = this.map
    if (!map || !this.drawing) return undefined
    const owner = this.drawing.pick(raycaster)
    if (owner === undefined) return undefined
    const id = this.idOf(map.model, owner)
    return id ? { id, kind: 'building' } : null
  }

  stats(): Record<string, number> {
    const m = this.map?.model
    if (!m) return {}
    const ties = m.neighbors.flatMap(n => n.ties)
    return {
      neighbors: m.neighbors.length,
      inbound: m.neighbors.filter(n => n.side === 'in').length,
      outbound: m.neighbors.filter(n => n.side === 'out').length,
      stores: m.neighbors.filter(n => n.side === 'store').length,
      ties: ties.length,
      slabs: m.slabs.length,
      libraries: m.libraries.length,
      litNeighbors: this.lit?.neighbors.size ?? 0,
      litTies: this.lit?.ties.size ?? 0,
      dots: this.flows?.stats().dots ?? 0,
      triangles: this.drawing?.stats().triangles ?? 0,
    }
  }

  dispose() {
    this.drawing?.dispose()
    this.flows?.dispose()
    this.glass.geometry.dispose()
    ;(this.glass.material as THREE.Material).dispose()
    this.glassEdges.geometry.dispose()
    ;(this.glassEdges.material as THREE.Material).dispose()
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  private build(model: ContextModel, plan: ContextPlan) {
    this.drawing?.object.removeFromParent()
    this.drawing?.dispose()
    this.flows?.object.removeFromParent()
    this.flows?.dispose()
    const sk = new Sketch()
    sheet(sk, plan.board)
    // the system boundary: the scope of what's ours
    sk.frame({ tone: 'line' }, GROUND, { u: 0, v: 0, w: SHELL * 2 + 7, h: SHELL * 2 + 7 }, { r: 3, lift: ON_BOARD, width: 0.32, dash: { on: 1.4, off: 1 } })

    // the tower: a slab per layer, paper on top, the layer's color round the sides
    model.slabs.forEach((s, k) => {
      const tone = s.name === NO_LAYER ? 'muted' : `cat:${k}`
      const { y0, y1 } = plan.slabs[k]
      sk.slab({ tone, owner: SLAB + k }, GROUND, { u: 0, v: 0, w: TOWER * 2, h: TOWER * 2 }, { r: 1.2, lift: y0, height: y1 - y0, top: 'paper', bottom: true })
    })

    // neighbors, and their ties as tubes
    const flows: { points: [number, number, number][]; tone: string; owner: number; size: number }[] = []
    this.tieOf = []
    model.neighbors.forEach((nb, i) => {
      const at = plan.neighbors[i]
      drawIcon(sk, nb.kind, nb.side, i, at.x, ON_BOARD, at.z)
      // its shadow on the board, so it stands somewhere
      sk.disc({ tone: 'edge', owner: i }, GROUND, [at.x, at.z], 4.1, { lift: ON_BOARD + 0.01 })
    })
    plan.ties.forEach(p => {
      const nb = model.neighbors[p.neighbor]
      const tie = nb.ties[p.tie]
      const owner = TIE + this.tieOf.length
      this.tieOf.push([p.neighbor, p.tie])
      const r = tubeRadius(tie.files.length)
      sk.tube({ tone: `tie:${tieSide(tie, nb.side)}`, owner }, p.points, r, { samples: 48, radial: 10 })
      // dots run from the caller to whoever is called
      const points = p.points.map(q => [q[0], q[1], q[2]] as [number, number, number])
      flows.push({ points: tie.dir === 'in' ? points : points.reverse(), tone: `dot:${tieSide(tie, nb.side)}`, owner, size: r * 1.1 + 0.08 })
    })
    this.drawing = sk.build()
    this.object.add(this.drawing.object)
    this.flows = new Flows(
      flows.map(f => ({ ...f, speed: 7, spacing: 5 })),
      { still: this.still },
    )
    this.object.add(this.flows.object)

    // the glass shell round the tower
    const h = plan.top - plan.base + 1.2
    this.glass.scale.set(SHELL * 2, h, SHELL * 2)
    this.glass.position.set(0, plan.base + h / 2 - 0.2, 0)
    this.glassEdges.scale.copy(this.glass.scale)
    this.glassEdges.position.copy(this.glass.position)
    this.fadeFrom = -1
  }

  private paint(ink: Ink) {
    const lit = this.lit
    const dimmed = (owner: number) => {
      if (!lit || owner < 0) return false
      if (owner >= SLAB) return !lit.slabs.has(owner - SLAB)
      if (owner >= TIE) {
        const [n, t] = this.tieOf[owner - TIE]
        return !lit.ties.has(`${n}:${t}`)
      }
      return !lit.neighbors.has(owner)
    }
    const color = (tone: string, owner: number) => {
      const c = this.tone(tone, ink)
      return dimmed(owner) ? fade(c, ink, FADE) : c
    }
    this.drawing?.paint(color)
    this.flows?.paint(color)
    ;(this.glass.material as THREE.MeshLambertMaterial).color.copy(ink.accent).lerp(ink.paper, ink.light ? 0.35 : 0.2)
    ;(this.glassEdges.material as THREE.LineBasicMaterial).color.copy(ink.accent)
  }

  /** The diagram's own tones (sides, bodies, ties, dots); the rest is the kit's. */
  private tone(tone: string, ink: Ink): THREE.Color {
    const colon = tone.indexOf(':')
    const kind = colon < 0 ? '' : tone.slice(0, colon)
    const side = tone.slice(colon + 1)
    switch (kind) {
      case 'body':
        return sideColor(side, ink).lerp(ink.paper, ink.light ? 0.3 : 0.12)
      case 'top':
        return sideColor(side, ink).lerp(ink.paper, ink.light ? 0.62 : 0.45)
      case 'tie':
        return sideColor(side, ink).lerp(ink.board, ink.light ? 0.08 : 0.15)
      case 'dot':
        return sideColor(side, ink).lerp(ink.light ? ink.ink : ink.paper, ink.light ? 0.25 : 0.55)
      default:
        return toneColor(ink, tone)
    }
  }

  /** What an owner selects: a neighbor's node, a tie's channel, a layer's folder (when it has one). */
  private idOf(model: ContextModel, owner: number): string | undefined {
    if (owner < 0) return undefined
    if (owner >= SLAB) return model.slabs[owner - SLAB]?.select
    if (owner >= TIE) {
      const [n, t] = this.tieOf[owner - TIE]
      return model.neighbors[n].ties[t].select
    }
    return model.neighbors[owner]?.select
  }
}

/**
 * The kit's board, its face lifted clear of the slab under it: 0.005 apart
 * (the kit's board) they flicker on the far side of a big board.
 */
function sheet(sk: Sketch, rect: Rect) {
  const r = Math.min(4, rect.w / 12, rect.h / 12)
  sk.slab({ tone: 'edge' }, GROUND, rect, { r, height: BOARD_HEIGHT - 0.1, bottom: true })
  sk.plate({ tone: 'board' }, GROUND, rect, { r, lift: BOARD_HEIGHT })
  sk.frame({ tone: 'edge' }, GROUND, rect, { r, lift: BOARD_HEIGHT + 0.01, width: 0.3 })
}
