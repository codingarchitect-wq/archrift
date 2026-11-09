// Diagram kit: the decoration both diagram views draw with. It builds a
// DiagramScene into one Drawing (boards, cards, connectors) and one text
// layer; paints them by the selection (the selected card and its rim in the
// accent, the cards tied to it and the connectors between them bright, the
// rest faded); opens the selected card above the board with all its rows
// when it has more than it shows; draws the connectors kept off the board
// (to a card nearly everything references) as arcs over it while one of
// their ends is selected; picks cards and rows; and fades in.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import { ON_BOARD, board } from '../arc42-kit/board.ts'
import { fade, inkOf, toneColor } from '../arc42-kit/ink.ts'
import type { Ink } from '../arc42-kit/ink.ts'
import { GROUND, Sketch } from '../arc42-kit/sketch.ts'
import type { Drawing, V3 } from '../arc42-kit/sketch.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { CARD, rowMiddle } from './card.ts'
import { CARD_HEIGHT, drawCard, drawLink, labelPlace } from './draw.ts'
import { focusOn } from './scene.ts'
import type { DiagramScene, Focus, PlacedCard, SceneArc } from './scene.ts'
import { TextLayer } from './text.ts'

/** The scene each diagram layout was made from (set by the views' layouts). */
export const diagramScenes = new WeakMap<Layout, DiagramScene>()

/** What a drawn thing stands for. */
type Owner = { kind: 'card'; card: number } | { kind: 'row'; card: number; section: number; row: number } | { kind: 'link'; link: number } | { kind: 'arc'; arc: number }

const FADE_MS = 600
/** How far what isn't related to the selection fades, and paper a little less. */
const DIM = 0.66
const DIM_PAPER = 0.5
/** An opened card floats this high above the board. */
const OPEN_LIFT = 2.4
const LINK_LIFT = ON_BOARD + 0.04

interface Built {
  drawing: Drawing
  text: TextLayer
  owners: Owner[]
}

export interface DiagramHooks {
  /** The card a selection stands for (a member selected stands for its card), or undefined. */
  cardOf(scene: DiagramScene, selected: string | null): number | undefined
  /** What a selection that is no card lights (a file lighting the tables it queries); null when nothing. */
  focusOther?(scene: DiagramScene, selected: string): Focus | null
  /** What a click on a row selects, given the row's id and its card's (the card's when the viewer doesn't know the row's node). */
  rowId?(row: string, card: string): string
  /** Extra stats for tests. */
  stats?(scene: DiagramScene): Record<string, number>
}

export class DiagramDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly engine: SceneEngine
  private readonly hooks: DiagramHooks
  private scene: DiagramScene | null = null
  private main: Built | null = null
  /** The selected card opened above the board, and the arcs of its connectors kept off it. */
  private open: Built | null = null
  private opened = -2
  private focus: Focus | null = null
  private born = -1
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(engine: SceneEngine, hooks: DiagramHooks) {
    this.engine = engine
    this.hooks = hooks
  }

  update(ctx: ViewContext, layout: Layout) {
    const scene = diagramScenes.get(layout) ?? null
    if (scene !== this.scene) {
      const reframe = !!this.scene && !!scene
      this.build(scene)
      if (reframe) this.engine.home()
    }
    if (!scene) return
    const card = this.hooks.cardOf(scene, ctx.s.selected)
    const selected = ctx.s.selected
    this.focus = focusOn(scene, card) ?? (selected ? this.hooks.focusOther?.(scene, selected) : null) ?? null
    if ((card ?? -1) !== this.opened) this.openCard(card ?? -1)
    this.paint(inkOf(ctx.theme))
  }

  animate(time: number) {
    if (!this.main) return false
    if (this.born < 0) this.born = time
    const k = this.still ? 1 : Math.min(1, (time - this.born) / FADE_MS)
    const e = k * k * (3 - 2 * k)
    this.main.drawing.setOpacity(e)
    this.main.text.setOpacity(e)
    return k < 1
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    if (!this.scene || !this.main) return undefined
    // the opened card floats over the rest
    for (const built of [this.open, this.main]) {
      if (!built) continue
      const owner = built.drawing.pick(raycaster)
      if (owner === undefined) continue
      const id = this.idOf(built.owners[owner], built === this.open)
      return id ? { id, kind: 'building' } : null
    }
    // nothing of the diagram under the pointer: a click there clears the selection
    return null
  }

  stats(): Record<string, number> {
    const s = this.scene
    if (!s) return {}
    return {
      boards: s.boards.length,
      cards: s.cards.length,
      rows: s.cards.reduce((n, c) => n + c.shape.sections.reduce((m, x) => m + x.rows.length, 0), 0),
      links: s.links.length,
      arcs: s.arcs.length,
      focused: this.focus ? this.focus.cards.size : 0,
      focusLinks: this.focus ? this.focus.links.size + this.focus.arcs.size : 0,
      opened: this.opened >= 0 && s.cards[this.opened]?.full ? 1 : 0,
      openRows: this.opened >= 0 && this.open ? fullOf(s.cards[this.opened]).sections.reduce((m, x) => m + x.rows.length, 0) : 0,
      glyphs: (this.main?.text.stats().glyphs ?? 0) + (this.open?.text.stats().glyphs ?? 0),
      triangles: (this.main?.drawing.stats().triangles ?? 0) + (this.open?.drawing.stats().triangles ?? 0),
      ...this.hooks.stats?.(s),
    }
  }

  dispose() {
    this.clear(this.main)
    this.clear(this.open)
  }

  // ── building ──────────────────────────────────────────────────────────────

  private build(scene: DiagramScene | null) {
    this.clear(this.main)
    this.clear(this.open)
    this.main = this.open = null
    this.opened = -2
    this.scene = scene
    this.born = -1
    if (!scene) return
    const sk = new Sketch()
    const text = new TextLayer(GROUND)
    const owners: Owner[] = []
    const own = (o: Owner) => owners.push(o) - 1
    for (const b of scene.boards) board(sk, GROUND, { u: b.u + b.w / 2, v: b.v + b.h / 2, w: b.w, h: b.h }, { r: 3 })
    scene.links.forEach((l, k) => {
      const owner = own({ kind: 'link', link: k })
      drawLink(sk, l.points, { owner, tone: 'line', lift: LINK_LIFT, dash: l.dash, start: l.start, end: l.end })
      if (l.label) linkLabel(sk, text, l.points, l.label, owner)
    })
    scene.cards.forEach((c, i) => {
      const card = own({ kind: 'card', card: i })
      drawCard(sk, text, c, { card, row: (section, row) => own({ kind: 'row', card: i, section, row }) }, ON_BOARD)
    })
    this.main = this.finish(sk, text, owners)
    this.main.drawing.setOpacity(this.still ? 1 : 0)
    this.main.text.setOpacity(this.still ? 1 : 0)
  }

  /** The selected card above the board when it has rows left out, and the arcs of its connectors kept off the board. */
  private openCard(card: number) {
    this.clear(this.open)
    this.open = null
    this.opened = card
    const scene = this.scene!
    const c = scene.cards[card]
    // nothing to open: every row shows, and no connector of its waits off the board
    if (card < 0 || !c || (!c.full && !scene.arcs.some(a => a.from === card || a.to === card))) return
    const sk = new Sketch()
    const text = new TextLayer(GROUND)
    const owners: Owner[] = []
    const own = (o: Owner) => owners.push(o) - 1
    if (c.full) {
      const opened: PlacedCard = { ...c, shape: c.full }
      const shadow = { u: c.u + c.full.w / 2 + 0.5, v: c.v + c.full.h / 2 + 0.6, w: c.full.w, h: c.full.h }
      sk.plate({ tone: 'shadow' }, GROUND, shadow, { r: CARD.r, lift: ON_BOARD + 0.05 })
      drawCard(sk, text, opened, { card: own({ kind: 'card', card }), row: (section, row) => own({ kind: 'row', card, section, row }) }, ON_BOARD + OPEN_LIFT)
    }
    scene.arcs.forEach((a, k) => {
      if (a.from === card || a.to === card) arc(sk, scene, a, own({ kind: 'arc', arc: k }))
    })
    this.open = this.finish(sk, text, owners)
    this.engine.requestRender()
  }

  private finish(sk: Sketch, text: TextLayer, owners: Owner[]): Built {
    const drawing = sk.build()
    text.build()
    this.object.add(drawing.object, text.object)
    return { drawing, text, owners }
  }

  private clear(built: Built | null) {
    if (!built) return
    this.object.remove(built.drawing.object, built.text.object)
    built.drawing.dispose()
    built.text.dispose()
  }

  /** What a click on an owner selects: a row's own id, else its card's. */
  private idOf(o: Owner | undefined, opened: boolean): string | undefined {
    const scene = this.scene!
    if (!o) return undefined
    if (o.kind === 'link' || o.kind === 'arc') {
      const l = o.kind === 'link' ? scene.links[o.link] : scene.arcs[o.arc]
      return scene.cards[l.from].content.id
    }
    const card = scene.cards[o.card]
    const own = card.content.id || undefined
    if (o.kind === 'card') return own
    const shape = opened && card.full ? card.full : card.shape
    const row = shape.sections[o.section]?.rows[o.row]?.id
    return row && own ? (this.hooks.rowId?.(row, own) ?? row) : own
  }

  // ── color ─────────────────────────────────────────────────────────────────

  private paint(ink: Ink) {
    const focus = this.focus
    for (const built of [this.main, this.open]) {
      if (!built) continue
      const color = (tone: string, owner: number) => paintOf(ink, tone, built.owners[owner], focus)
      built.drawing.paint(color)
      built.text.paint(color)
    }
    this.engine.requestRender()
  }
}

const fullOf = (c: PlacedCard) => c.full ?? c.shape

/** The color of a tone for what an owner stands for, given the selection's focus. */
function paintOf(ink: Ink, tone: string, o: Owner | undefined, focus: Focus | null): THREE.Color {
  if (!focus || !o) return diagramTone(ink, tone)
  const lit = isLit(o, focus)
  const c = focusTone(ink, tone, o, focus, lit) ?? diagramTone(ink, tone)
  if (!lit) fade(c, ink, tone === 'paper' || tone === 'zebra' || tone.startsWith('band:') ? DIM_PAPER : DIM)
  return c
}

/** Part of the focus: a connector of it, an arc (drawn only for it), a card of it and its rows. */
function isLit(o: Owner, focus: Focus): boolean {
  if (o.kind === 'link') return focus.links.has(o.link)
  return o.kind === 'arc' || focus.cards.has(o.card)
}

/** The accent where the focus has it: its connectors, the selected card's rim and band. */
function focusTone(ink: Ink, tone: string, o: Owner, focus: Focus, lit: boolean): THREE.Color | undefined {
  if (o.kind === 'link' || o.kind === 'arc') return lit && tone === 'line' ? ink.accent.clone() : undefined
  if (o.card !== focus.card) return undefined
  if (tone === 'rim') return ink.accent.clone()
  return tone.startsWith('band:') ? ink.accent.clone().lerp(ink.paper, ink.light ? 0.7 : 0.6) : undefined
}

/** The diagram kit's tones, then the arc42 kit's. */
export function diagramTone(ink: Ink, tone: string): THREE.Color {
  if (tone.startsWith('band:')) return toneColor(ink, tone.slice(5)).lerp(ink.paper, ink.light ? 0.66 : 0.62)
  switch (tone) {
    case 'cardWall':
      return ink.edge.clone().lerp(ink.ink, ink.light ? 0.08 : 0.04)
    case 'rim':
      return ink.edge.clone().lerp(ink.ink, ink.light ? 0.18 : 0.12)
    case 'zebra':
      return ink.paper.clone().lerp(ink.board, ink.light ? 0.55 : 0.45)
    case 'text':
      return ink.ink.clone()
    case 'text2':
      return ink.ink.clone().lerp(ink.paper, 0.2)
    case 'quiet':
      return ink.ink.clone().lerp(ink.paper, ink.light ? 0.48 : 0.45)
    case 'key':
      return ink.warn.clone()
    case 'ghostFill':
      return ink.board.clone().lerp(ink.edge, 0.3)
    case 'ghostRim':
      return ink.muted.clone()
    case 'shadow':
      return ink.board.clone().lerp(ink.ground, 0.6)
    case 'labelBack':
      return ink.board.clone()
    default:
      return toneColor(ink, tone)
  }
}

/** A connector's name on a small plate of the board's color, at the middle of its longest run. */
function linkLabel(sk: Sketch, text: TextLayer, points: readonly [number, number][], label: string, owner: number) {
  const { at } = labelPlace(points)
  const size = CARD.smallEm
  const w = text.width(label, 'text', size) + 0.6
  sk.plate({ tone: 'labelBack', owner }, GROUND, { u: at[0], v: at[1], w, h: 1.05 }, { r: 0.4, lift: LINK_LIFT + 0.02 })
  text.add({ text: label, font: 'text', size, u: at[0], v: at[1] + 0.22, align: 'center', lift: LINK_LIFT + 0.04, tone: 'quiet', owner })
}

/** A connector kept off the board, while one of its ends is selected: an arc from one card's side over the board to the other's. */
function arc(sk: Sketch, scene: DiagramScene, a: SceneArc, owner: number) {
  const [from, to] = [scene.cards[a.from], scene.cards[a.to]]
  const fromMid = from.u + from.shape.w / 2
  const toMid = to.u + to.shape.w / 2
  // leave and meet on the sides facing each other
  const p0: V3 = [toMid >= fromMid ? from.u + from.shape.w : from.u, ON_BOARD + CARD_HEIGHT, from.v + a.fromAt]
  const p1: V3 = [toMid >= fromMid ? to.u : to.u + to.shape.w, ON_BOARD + CARD_HEIGHT, to.v + a.toAt]
  const span = Math.hypot(p1[0] - p0[0], p1[2] - p0[2])
  const height = 2 + span * 0.18
  const points: V3[] = []
  for (let k = 0; k <= 24; k++) {
    const t = k / 24
    const lift = 4 * height * t * (1 - t)
    points.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + lift, p0[2] + (p1[2] - p0[2]) * t])
  }
  sk.tube({ tone: 'line', owner }, points, 0.12, { samples: 48, radial: 6 })
  const tip = new THREE.Matrix4().makeTranslation(p1[0], p1[1], p1[2])
  sk.solid({ tone: 'line', owner }, new THREE.SphereGeometry(0.32, 12, 8), tip)
}

/** A card's middle row offset for an attach point, falling back to the title band when the row isn't shown. */
export function attachAt(card: PlacedCard, section: number, row: number): number {
  return rowMiddle(card.shape, section, row) ?? card.shape.band / 2
}
