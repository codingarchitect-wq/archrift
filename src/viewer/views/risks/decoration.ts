// Risks view, part 3: what the engine's boxes (the towers) don't draw. The
// board, the 25 cells as plinths tinted and raised by their risk (the high-risk
// ones rimmed in dashed red), the two axes as arrows, the leaders from the
// highest risks to their names, and the debt rings: one collar per kind of debt
// round a tower, stacked down from its roof (one instanced mesh). With a
// selection, cells holding nothing it relates to fade, and so do their rings.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import { ON_BOARD, board } from '../arc42-kit/board.ts'
import { fade, inkOf, toneColor } from '../arc42-kit/ink.ts'
import type { Ink } from '../arc42-kit/ink.ts'
import { GROUND, Sketch } from '../arc42-kit/sketch.ts'
import type { Drawing } from '../arc42-kit/sketch.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { cellColor, debtColor, riskHeat } from './colors.ts'
import { RING_H, RING_STEP, RING_TOP, TOWER, axisGap, boardRect, inZone, spanOf } from './layout.ts'
import { maps, relatedOf } from './map.ts'
import type { RiskMap } from './map.ts'
import type { Debt } from './model.ts'
import { DEBTS } from './model.ts'

/** How far what the selection doesn't relate to fades into the ground. */
export const DIM = 0.8
const FADE_MS = 600
/** A collar: a square ring a little wider than a tower, lying flat. */
const COLLAR = (() => {
  const outer = 0.62
  const inner = 0.5
  const shape = new THREE.Shape([new THREE.Vector2(-outer, -outer), new THREE.Vector2(outer, -outer), new THREE.Vector2(outer, outer), new THREE.Vector2(-outer, outer)])
  shape.holes.push(new THREE.Path([new THREE.Vector2(-inner, -inner), new THREE.Vector2(-inner, inner), new THREE.Vector2(inner, inner), new THREE.Vector2(inner, -inner)]))
  return new THREE.ExtrudeGeometry(shape, { depth: RING_H, bevelEnabled: false }).rotateX(-Math.PI / 2)
})()

// owners besides the cells (0–24)
const LEADER = 31

export class RisksDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly ringMaterial = new THREE.MeshLambertMaterial({ transparent: true })
  private drawing: Drawing | null = null
  private rings: THREE.InstancedMesh | null = null
  /** Each ring's file and debt, in instance order. */
  private ringOf: { id: string; debt: Debt | 'ruleError' }[] = []
  private map: RiskMap | null = null
  private ink: Ink | null = null
  private related: Set<string> | null = null
  private fadeFrom = -1
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  update(ctx: ViewContext, layout: Layout) {
    const map = maps.get(layout)
    if (!map) return
    if (map !== this.map) {
      this.map = map
      this.build(map)
    }
    this.ink = inkOf(ctx.theme)
    this.related = relatedOf(ctx, map)
    this.paint()
    if (this.still) this.setOpacity(1)
  }

  animate(time: number) {
    if (this.still || !this.drawing) return false
    if (this.fadeFrom < 0) this.fadeFrom = time
    const k = Math.min(1, (time - this.fadeFrom) / FADE_MS)
    this.setOpacity(k * k * (3 - 2 * k))
    return k < 1
  }

  /** A ring stands for its tower; everything else of mine falls through (the towers are the engine's). */
  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    if (!this.rings) return undefined
    const hit = raycaster.intersectObject(this.rings, false)[0]
    if (hit?.instanceId === undefined) return undefined
    return { id: this.ringOf[hit.instanceId].id, kind: 'building' }
  }

  stats(): Record<string, number> {
    const m = this.map
    if (!m) return {}
    return {
      files: m.model.files.length,
      cells: m.geometry.cells.length,
      filled: m.geometry.cells.filter(c => c.files.length).length,
      high: m.model.high,
      rings: this.ringOf.length,
      related: this.related?.size ?? 0,
      triangles: this.drawing?.stats().triangles ?? 0,
    }
  }

  dispose() {
    this.drawing?.dispose()
    this.rings?.dispose()
    this.ringMaterial.dispose()
  }

  private setOpacity(k: number) {
    this.drawing?.setOpacity(k)
    this.ringMaterial.opacity = k
    this.ringMaterial.transparent = k < 1
  }

  private build(map: RiskMap) {
    const g = map.geometry
    const sk = new Sketch()
    board(sk, GROUND, boardRect(g))
    const lift = ON_BOARD
    // plinths: lit walls, a flat face in exactly the cell's tint, a rim (dashed red round the high-risk cells)
    for (const [i, c] of g.cells.entries()) {
      const rect = { u: c.x, v: c.z, w: c.size, h: c.size }
      sk.slab({ tone: 'cellSide', owner: i }, GROUND, rect, { r: 1.2, lift, height: c.plinth })
      sk.plate({ tone: 'cell', owner: i }, GROUND, rect, { r: 1.2, lift: c.top + 0.01 })
      if (inZone(c)) sk.frame({ tone: 'zone', owner: i }, GROUND, rect, { r: 1.2, lift: c.top + 0.02, width: 0.34, dash: { on: 1.6, off: 0.9 } })
      else sk.frame({ tone: 'cellEdge', owner: i }, GROUND, rect, { r: 1.2, lift: c.top + 0.02, width: 0.16 })
    }
    // the axes: likelihood along the front, impact up the left side
    const gap = axisGap(g)
    const width = Math.max(0.18, spanOf(g) * 0.0019)
    sk.ribbon({ tone: 'muted' }, GROUND, [[g.left, g.front + gap], [g.right + gap * 2, g.front + gap]], { width, lift, head: 'end' })
    sk.ribbon({ tone: 'muted' }, GROUND, [[g.left - gap, g.front], [g.left - gap, g.back - gap * 2]], { width, lift, head: 'end' })
    // leaders from the highest risks' roofs to their names on the rail
    for (const stop of map.rail) {
      sk.tube({ tone: 'leader', owner: LEADER }, stop.leader, 0.08, { samples: 40, radial: 6 })
      sk.disc({ tone: 'leader', owner: LEADER }, GROUND, [stop.at[0] - 0.4, stop.at[2]], 0.45, { lift: lift + 0.04 })
    }
    this.drawing?.object.removeFromParent()
    this.drawing?.dispose()
    this.drawing = sk.build()
    this.object.add(this.drawing.object)

    // debt rings, stacked down from each roof in a fixed order
    this.ringOf = []
    const matrices: THREE.Matrix4[] = []
    const m = new THREE.Matrix4()
    for (const f of map.model.files) {
      const box = g.towers.get(f.id)
      if (!box || !f.debts.length) continue
      DEBTS.filter(d => f.debts.includes(d)).forEach((d, k) => {
        const y = box.y + box.h - RING_TOP - k * RING_STEP - RING_H / 2
        matrices.push(m.clone().makeScale(TOWER, 1, TOWER).setPosition(box.x, y - RING_H / 2, box.z))
        this.ringOf.push({ id: f.id, debt: d === 'rule' && f.ruleError ? 'ruleError' : d })
      })
    }
    this.rings?.removeFromParent()
    this.rings?.dispose()
    this.rings = new THREE.InstancedMesh(COLLAR, this.ringMaterial, Math.max(1, matrices.length))
    this.rings.count = matrices.length
    matrices.forEach((mx, i) => this.rings!.setMatrixAt(i, mx))
    this.rings.instanceMatrix.needsUpdate = true
    this.rings.computeBoundingSphere()
    this.object.add(this.rings)
    this.fadeFrom = -1
    this.setOpacity(this.still ? 1 : 0)
  }

  private paint() {
    const map = this.map!
    const ink = this.ink!
    const related = this.related
    const cells = map.geometry.cells
    const lit = related ? cells.map(c => c.files.some(f => related.has(f))) : null
    this.drawing!.paint((tone, owner) => {
      const cell = owner >= 0 && owner < cells.length ? cells[owner] : undefined
      let c: THREE.Color
      if (tone === 'cell') c = cellColor(ink, cell!.risk)
      else if (tone === 'cellSide') c = cellColor(ink, cell!.risk).lerp(riskHeat(ink, cell!.risk), 0.25)
      else if (tone === 'cellEdge') c = cellColor(ink, cell!.risk).lerp(riskHeat(ink, cell!.risk), 0.45)
      else if (tone === 'zone') c = ink.danger.clone().lerp(ink.board, 0.15)
      else if (tone === 'leader') c = ink.line.clone().lerp(ink.danger, 0.35)
      else c = toneColor(ink, tone)
      if (cell && lit && !lit[owner]) fade(c, ink, 0.55)
      return c
    })
    if (this.rings) {
      const colors = new Map<string, THREE.Color>()
      this.ringOf.forEach(({ id, debt }, i) => {
        let c = colors.get(debt)
        if (!c) colors.set(debt, (c = new THREE.Color(debtColor(debt, ink.light))))
        this.rings!.setColorAt(i, related && !related.has(id) ? fade(c.clone(), ink, DIM) : c)
      })
      if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true
    }
  }
}
