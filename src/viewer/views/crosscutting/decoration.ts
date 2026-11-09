// Crosscutting view, part 4: the drawing. The board; each building block a
// pillar on a plinth in its layer's color, pale walls and a paper cap; each
// candidate a band (a tube in its own color) weaving along the arc, strong
// where it meets a pillar that uses it and faint between pillars that don't;
// a collar round every pillar that uses it (thicker for more use) and a
// taller sleeve where its code lives. One merged drawing, repainted for the
// selection and the theme; it fades in once. Band names wear their colors.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { Theme } from '../../scene/engine.ts'
import { ON_BOARD, board } from '../arc42-kit/board.ts'
import { categorical, fade, inkOf, textOn, toneColor } from '../arc42-kit/ink.ts'
import type { Ink } from '../arc42-kit/ink.ts'
import { GROUND, Sketch, level } from '../arc42-kit/sketch.ts'
import type { Drawing } from '../arc42-kit/sketch.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { BAND, isLit, litBy, scenes } from './scene.ts'
import type { CrosscuttingScene, Lit } from './scene.ts'

const FADE_MS = 600
/** How far what the selection doesn't light sinks into the ground. */
const DIM = 0.8
const PILLAR_R = 0.9
const PLINTH = 0.7
const PLINTH_H = 0.8
const COLLAR_H = 1.1
const HOME_H = 2.3
const HOME_T = 0.95

/** A band's color: the categorical palette from its rank. */
export const bandTone = (k: number) => `cat:${k}`

export class CrosscuttingDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private drawing: Drawing | null = null
  private scene: CrosscuttingScene | null = null
  private theme: Theme | null = null
  private lit: Lit | null = null
  private collars = 0
  private homes = 0
  private fadeFrom = -1
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly style = document.createElement('style')

  constructor() {
    this.style.dataset.view = 'crosscutting'
    document.head.appendChild(this.style)
  }

  update(ctx: ViewContext, layout: Layout) {
    const scene = scenes.get(layout)
    if (!scene) return
    const restyle = this.theme !== ctx.theme || scene !== this.scene
    this.theme = ctx.theme
    if (scene !== this.scene) {
      this.scene = scene
      this.build(scene)
    }
    this.lit = litBy(scene, ctx.world, ctx.s.selected)
    this.paint()
    if (restyle) this.writeStyles(scene)
  }

  animate(time: number) {
    if (!this.drawing) return false
    if (this.still) {
      this.drawing.setOpacity(1)
      return false
    }
    if (this.fadeFrom < 0) this.fadeFrom = time
    const k = Math.min(1, (time - this.fadeFrom) / FADE_MS)
    this.drawing.setOpacity(k * k * (3 - 2 * k))
    return k < 1
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    const scene = this.scene
    const owner = this.drawing?.pick(raycaster)
    if (!scene || owner === undefined) return undefined
    if (owner < 0) return null
    const id = owner >= BAND ? scene.model.candidates[owner - BAND]?.id : scene.model.blocks[owner]?.id
    return id ? { id, kind: 'building' } : null
  }

  stats(): Record<string, number> {
    const m = this.scene?.model
    if (!m) return {}
    return {
      pillars: m.blocks.length,
      bands: m.candidates.length,
      collars: this.collars,
      homes: this.homes,
      litPillars: this.lit?.pillars.size ?? 0,
      litBands: this.lit?.bands.size ?? 0,
      triangles: this.drawing?.stats().triangles ?? 0,
    }
  }

  dispose() {
    this.drawing?.dispose()
    this.style.remove()
  }

  private build(scene: CrosscuttingScene) {
    const { model, arrangement: a } = scene
    const sk = new Sketch()
    board(sk, GROUND, a.board)
    // pillars: a plinth in the layer's color, pale walls, a paper cap; a leader out to the name
    a.pillars.forEach((p, i) => {
      sk.ribbon({ tone: 'edge', owner: i }, GROUND, [[p.x, p.z + p.side / 2 + PLINTH], [p.x, p.nameZ - 1.2]], { width: 0.16, lift: ON_BOARD + 0.01 })
      const rect = { u: p.x, v: p.z, w: p.side, h: p.side }
      sk.slab({ tone: `plinth:${p.layer}`, owner: i }, GROUND, { ...rect, w: p.side + PLINTH * 2, h: p.side + PLINTH * 2 }, { r: PILLAR_R + PLINTH, lift: ON_BOARD, height: PLINTH_H })
      sk.slab({ tone: `wall:${p.layer}`, owner: i }, GROUND, rect, { r: PILLAR_R, lift: ON_BOARD + PLINTH_H, height: p.h - PLINTH_H, top: 'paper' })
    })
    // bands, their collars and sleeves
    const widest = Math.max(1, ...model.candidates.map(c => c.breadth))
    let collars = 0
    let homes = 0
    a.bands.forEach((band, k) => {
      const owner = BAND + k
      const radius = 0.2 + 0.16 * (model.candidates[k].breadth / widest)
      for (const span of band.spans)
        sk.tube({ tone: span.strong ? bandTone(k) : `faint:${k}`, owner }, span.points, span.strong ? radius : radius * 0.5, { samples: span.points.length * 2, radial: 10 })
      const most = Math.max(1, ...band.uses)
      a.pillars.forEach((p, i) => {
        const home = band.homes[i]
        if (!home && !band.uses[i]) return
        const t = home ? HOME_T : 0.32 + 0.5 * Math.sqrt(band.uses[i] / most)
        const h = home ? HOME_H : COLLAR_H
        const rect = { u: p.x, v: p.z, w: p.side + t * 2, h: p.side + t * 2 }
        sk.slab({ tone: home ? `home:${k}` : bandTone(k), owner }, level(band.y - h / 2), rect, { r: PILLAR_R + t, height: h, bottom: true })
        if (home) homes++
        else collars++
      })
    })
    this.drawing?.dispose()
    if (this.drawing) this.object.remove(this.drawing.object)
    this.drawing = sk.build()
    this.object.add(this.drawing.object)
    this.collars = collars
    this.homes = homes
    this.fadeFrom = -1
    this.drawing.setOpacity(this.still ? 1 : 0)
  }

  private paint() {
    if (!this.drawing || !this.theme) return
    const ink = inkOf(this.theme)
    const lit = this.lit
    this.drawing.paint((tone, owner) => {
      // with a selection, the lit pillars' walls take on their layer's color
      const c = colorOf(lit && tone.startsWith('wall:') && isLit(lit, owner) ? `lit-${tone}` : tone, ink)
      return isLit(lit, owner) ? c : fade(c, ink, DIM)
    })
  }

  /** Band names on pills of their band's color. */
  private writeStyles(scene: CrosscuttingScene) {
    const ink = inkOf(this.theme!)
    const rules = [
      '.label.cc-band { font-weight: 700; text-shadow: none; border-radius: 9px; padding: 0 8px; }',
      // a note ends at its anchor, before the band's left end
      '.label.cc-note { translate: -50% 0; }',
      '.label.cc-pillar { font-size: 11px; font-weight: 600; }',
      // the selected band's name, ringed
      '.label.cc-band.cc-on { box-shadow: 0 0 0 2px var(--text); }',
      '.label.cc-empty { font-size: 13px; }',
    ]
    scene.model.candidates.forEach((_, k) => {
      const c = categorical(k, ink)
      rules.push(`.label.cc-band.cc${k} { background: #${c.getHexString()}; color: ${textOn(c)}; }`)
    })
    this.style.textContent = rules.join('\n')
  }
}

/** A tone's color: the kit's tones, and this view's own (walls, plinths, faint bands, homes). */
export function colorOf(tone: string, ink: Ink): THREE.Color {
  const colon = tone.indexOf(':')
  const kind = colon < 0 ? tone : tone.slice(0, colon)
  const n = Number(tone.slice(colon + 1))
  switch (kind) {
    case 'wall':
      return n < 0 ? ink.paper.clone().lerp(ink.edge, 0.35) : categorical(n, ink).lerp(ink.paper, ink.light ? 0.74 : 0.62)
    case 'lit-wall':
      return n < 0 ? ink.edge.clone() : categorical(n, ink).lerp(ink.paper, ink.light ? 0.4 : 0.3)
    case 'plinth':
      return n < 0 ? ink.edge.clone() : categorical(n, ink)
    case 'faint':
      return categorical(n, ink).lerp(ink.board, 0.62)
    case 'home':
      return categorical(n, ink).lerp(ink.ink, ink.light ? 0.25 : 0.15)
    default:
      return toneColor(ink, tone)
  }
}
