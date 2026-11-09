// Runtime view, part 2: the sequence diagram's geometry, in the coordinates
// of the wall it's drawn on (u to the right, v down from the board's top
// edge, world units). The home view fits the diagram's height, so a row has a
// known height on screen; lifelines are spaced for their names at that scale
// (on two lines where neighbors would collide), while a message's label may
// run past the lifelines, as it has its row to itself. One row per message,
// with room before each alt and between its operands for the guards;
// activations nested on their lifelines, standing out of the wall as far as
// their call is deep. Pure and deterministic.
import type { P2 } from '../arc42-kit/sketch.ts'
import type { Message, Scenario } from './scenario.ts'

/**
 * Distance between message rows; every size here is a fraction of it. Small
 * on purpose: the camera stays close, so ink a hair off the board doesn't
 * fight it for depth.
 */
export const ROW = 2
/** Activation bar width, and how far a nested one (a call within a file) shifts right. */
export const ACT_W = 0.29 * ROW
const NEST = 0.14 * ROW
/** How far an activation stands out of the wall at depth 1, and per level deeper. */
const RELIEF_BASE = 0.14 * ROW
const RELIEF_STEP = 0.22 * ROW
/** The header box under a lifeline's name, and how far it stands out. */
export const HEADER_H = 0.8 * ROW
export const HEADER_RELIEF = 0.33 * ROW
/** The viewer puts a box's name this far above it (engine.ts): names sit above their headers. */
export const NAME_ABOVE = 1.5
/** Rows (in ROWs from the board's top edge) where the caption, the heading and the lower line of names end. */
const CAPTION = 1.0
const HEADING = 2.05
const NAMES = 4.05
/** From the headers' foot to the first message. */
const FIRST_GAP = 1.1
/** Extra room before an alt and before each operand (its top line and guard), and after an alt. */
const GUARD_GAP = 1.6
/** Where a fragment's (or an operand's) top line is, and its guard's baseline, above its first row. */
const LINE_ABOVE = 2.1
const GUARD_ABOVE = 1.15
const AFTER_ALT = 0.45
/** A self-call's loop: how far right it reaches, and how far down it comes back. */
const LOOP_W = 0.6 * ROW
const LOOP_H = 0.5 * ROW

/** Screen metrics at the home view: a row's height bound, label sizes (labels.ts, arc42.css), spacing. */
const MAX_ROW_PX = 26
/** The share of the screen's height the diagram takes at home (the toolbar and the legend take the rest). */
export const FIT = 0.68
const LABEL_PX = 22
const NAME_CHAR_PX = 7.4
const NOTE_CHAR_PX = 6.1
/** How the viewer's labels guess a label's width when they keep labels apart (labels.ts). */
const GUESS_CHAR_PX = 7
const GUESS_PAD_PX = 12
const MIN_GAP_PX = 64
const NAME_GAP_PX = 12
const SIDE_PX = 40

export const relief = (depth: number) => RELIEF_BASE + RELIEF_STEP * Math.max(0, depth - 1)

export interface Column {
  u: number
  headerW: number
  /** Where its name's label ends (v): the lower line, or the upper one for a name moved out of a neighbor's way. */
  nameV: number
  top: number
  bottom: number
}

export interface Activation {
  participant: number
  /** The message that starts it. */
  message: number
  u: number
  v0: number
  v1: number
  depth: number
}

export interface Arrow {
  message: number
  points: P2[]
  /** How far off the wall it's drawn: the front of the activation it starts. */
  lift: number
}

export interface FragmentBox {
  index: number
  u0: number
  u1: number
  v0: number
  v1: number
  /** Where operands after the first start (dashed lines across). */
  dividers: number[]
  /** Each operand's guard, just under its top line (centered there). */
  guards: { u: number; v: number; text: string }[]
  /** The `alt` tag's label (centered there), and the tag's width. */
  tag: P2
  tagW: number
}

export interface Diagram {
  scenario: Scenario
  width: number
  height: number
  /** The screen height it was laid out for, and the pixels a world unit takes there at the home view (labels were sized for it). */
  viewport: number
  pixels: number
  /** Where the headers are (their middle, v). */
  headerV: number
  /** Per participant: its lifeline, header and name. */
  columns: Column[]
  /** Per message: its row. */
  rows: number[]
  activations: Activation[]
  arrows: Arrow[]
  /** Per message: where its label is centered. */
  labels: { message: number; u: number; v: number }[]
  fragments: FragmentBox[]
  /** Between the client side and the server side, when there are both. */
  boundary?: { u: number; label: string }
  caption: P2
  heading: P2
  /** Per message with calls left out under it: a note at its activation's end (centered there). */
  more: { message: number; u: number; v: number; text: string }[]
}

/**
 * Where to center a label that should start at `u`: the viewer keeps labels
 * apart by a guess of their width around their anchor, so a label is anchored
 * at its middle rather than shifted after (which the guess wouldn't know).
 */
export const startingAt = (u: number, text: string, pixels: number) => u + guessWidth(text, pixels) / 2

/** A label's width as the viewer guesses it, in world units. */
const guessWidth = (text: string, pixels: number) => (text.length * GUESS_CHAR_PX + GUESS_PAD_PX) / pixels

/** The text on a message's arrow: its label, how often, whether it goes on as a call above. */
export function messageText(m: Message): string {
  return `${m.label}${m.times > 1 ? ` ×${m.times}` : ''}${m.collapsed ? ' ⋯' : ''}`
}

/**
 * The diagram for a scenario. `viewport` is the screen height it should fit
 * at the home view (labels are sized to it), and `aspect` the screen's.
 */
export function layoutDiagram(scenario: Scenario, o: { viewport?: number; aspect?: number } = {}): Diagram {
  const { participants, messages, fragments } = scenario
  const viewport = o.viewport ?? 1000
  const aspect = o.aspect ?? 1.6

  // rows: one per message, with room for each alt's guards
  const headerTop = NAMES * ROW + NAME_ABOVE
  const headerV = headerTop + HEADER_H / 2
  const rows: number[] = []
  const starts = new Map<number, number>() // message → how many fragments start there
  const operandStarts = new Set<number>()
  const ends = new Map<number, number>() // message → how many fragments end there
  for (const f of fragments) {
    const first = f.operands[0]?.first
    const last = f.operands[f.operands.length - 1]?.last
    if (first === undefined || last === undefined) continue
    starts.set(first, (starts.get(first) ?? 0) + 1)
    for (const op of f.operands.slice(1)) operandStarts.add(op.first)
    ends.set(last, (ends.get(last) ?? 0) + 1)
  }
  let v = headerTop + HEADER_H + FIRST_GAP * ROW
  messages.forEach((_, k) => {
    if (starts.has(k)) v += GUARD_GAP * ROW * starts.get(k)!
    else if (operandStarts.has(k)) v += GUARD_GAP * ROW
    rows.push(v)
    v += ROW + (ends.get(k) ?? 0) * AFTER_ALT * ROW
  })
  const height = (rows.length ? rows[rows.length - 1] : headerTop + HEADER_H) + 1.9 * ROW

  // the scale the home view has when it fits the height (never more than MAX_ROW_PX a row)
  const fitHeight = Math.min((viewport * FIT) / height, MAX_ROW_PX / ROW)

  // lifelines, in pixels at that scale: at least MIN_GAP_PX apart, room for a self-call's loop, names on
  // the lower line unless a neighbor's is in the way (then the upper one, or further along)
  const nameW = participants.map(p => p.name.length * NAME_CHAR_PX + 12)
  const loops = participants.map((_, i) => messages.some(m => m.from === i && m.to === i))
  const px: number[] = []
  const line: number[] = []
  const rightOf = [-Infinity, -Infinity] // the right end of the last name on each line
  participants.forEach((_, i) => {
    let x = i === 0 ? SIDE_PX + nameW[0] / 2 : px[i - 1] + Math.max(MIN_GAP_PX, loops[i - 1] ? LOOP_W * fitHeight + 70 : 0)
    const fits = (l: number) => rightOf[l] + NAME_GAP_PX <= x - nameW[i] / 2
    let l = fits(0) ? 0 : fits(1) ? 1 : -1
    if (l < 0) {
      // neither line has room: move along until the line that frees up first has
      l = rightOf[0] <= rightOf[1] ? 0 : 1
      x = rightOf[l] + NAME_GAP_PX + nameW[i] / 2
    }
    px.push(x)
    line.push(l)
    rightOf[l] = x + nameW[i] / 2
  })
  const widthPx = Math.max(...rightOf, px.length ? px[px.length - 1] : 0) + SIDE_PX
  const width = Math.max(widthPx / fitHeight, 15 * ROW)
  const pixels = Math.min(fitHeight, (viewport * aspect * 0.86) / width)
  const lineH = LABEL_PX / fitHeight
  const columns: Column[] = px.map((x, i) => ({
    u: x / fitHeight,
    headerW: Math.max(0.8 * ROW, Math.min(nameW[i], MIN_GAP_PX * 0.85) / fitHeight),
    nameV: headerTop - NAME_ABOVE - line[i] * lineH,
    top: headerTop + HEADER_H,
    bottom: height - 0.9 * ROW,
  }))

  // activations: from the message that starts one to the last message under it; nested ones shift right
  const activations: Activation[] = []
  const open: Activation[][] = participants.map(() => [])
  const actOf = new Map<number, Activation>() // message → the activation it starts
  const lastUnder = (k: number) => {
    let j = k
    while (j + 1 < messages.length && messages[j + 1].depth > messages[k].depth) j++
    return j
  }
  messages.forEach((m, k) => {
    if (participants[m.to]?.kind === 'actor') return
    const self = m.from === m.to
    // what's still open on the callee's lifeline at this row (closed ones drop off)
    const stack = open[m.to].filter(a => a.v1 >= rows[k])
    open[m.to] = stack
    const v0 = rows[k] + (self ? LOOP_H - 0.15 * ROW : -0.15 * ROW)
    const a: Activation = {
      participant: m.to,
      message: k,
      u: columns[m.to].u + stack.length * NEST,
      v0,
      v1: Math.max(rows[lastUnder(k)] + 0.45 * ROW, v0 + 0.5 * ROW),
      depth: m.depth,
    }
    activations.push(a)
    stack.push(a)
    actOf.set(k, a)
  })

  // the activation a message starts from: the innermost one open on the caller's lifeline at its row
  const callerAt = (k: number): Activation | undefined => {
    const m = messages[k]
    let best: Activation | undefined
    for (const a of activations) if (a.participant === m.from && a.message < k && a.v0 <= rows[k] && a.v1 >= rows[k] && (!best || a.depth > best.depth)) best = a
    return best
  }

  const arrows: Arrow[] = []
  const labels: Diagram['labels'] = []
  messages.forEach((m, k) => {
    const row = rows[k]
    const fromU = callerAt(k)?.u ?? columns[m.from].u
    const to = actOf.get(k)
    const lift = relief(m.depth) + 0.03
    if (m.from === m.to) {
      const x0 = fromU + ACT_W / 2
      const x1 = (to?.u ?? fromU) + ACT_W / 2
      arrows.push({ message: k, lift, points: [[x0, row], [x0 + LOOP_W, row], [x0 + LOOP_W, row + LOOP_H], [x1, row + LOOP_H]] })
      labels.push({ message: k, u: startingAt(x0 + 0.15 * ROW, messageText(m), pixels), v: row - 0.12 * ROW })
      return
    }
    const toU = to?.u ?? columns[m.to].u
    const dir = Math.sign(toU - fromU) || 1
    const start = fromU + (dir * ACT_W) / 2
    const end = toU - (dir * ACT_W) / 2
    arrows.push({ message: k, lift, points: [[start, row], [end, row]] })
    // a label wider than its arrow starts at the arrow's tail instead, so it reads from where the call comes
    const w = (messageText(m).length * NOTE_CHAR_PX + 10) / pixels
    const centered = w <= Math.abs(end - start) * 0.95
    labels.push({ message: k, u: centered ? (start + end) / 2 : startingAt(Math.min(start, end) + 0.1 * ROW, messageText(m), pixels), v: row - 0.12 * ROW })
  })

  // alt fragments round the lifelines their messages touch (the dispatching one too), nested ones inset
  const boxes: FragmentBox[] = []
  fragments.forEach((f, i) => {
    const first = f.operands[0]?.first
    const last = f.operands[f.operands.length - 1]?.last
    if (first === undefined || last === undefined || last < first) return
    const lanes = new Set<number>()
    for (let k = first; k <= last; k++) lanes.add(messages[k].from).add(messages[k].to)
    const right = Math.max(...[...lanes].map(p => columns[p].u + (loops[p] ? LOOP_W + 0.3 * ROW : 0)))
    const left = Math.min(...[...lanes].map(p => columns[p].u))
    const inset = fragments.slice(0, i).filter(g => contains(g, f)).length * 0.2 * ROW
    const u0 = left - 0.65 * ROW + inset
    const u1 = right + 0.65 * ROW - inset
    const v0 = rows[first] - LINE_ABOVE * ROW + inset
    const lastEnd = activations.filter(a => a.message >= first && a.message <= last).reduce((y, a) => Math.max(y, a.v1), rows[last])
    const v1 = Math.max(rows[last] + 0.55 * ROW, lastEnd + 0.15 * ROW) - inset * 0.5
    // the tag holds its label (as wide as the viewer guesses it), and the first guard follows it on the top line
    const tagW = guessWidth('alt', pixels) + 0.1 * ROW
    boxes.push({
      index: i,
      u0,
      u1,
      v0,
      v1,
      dividers: f.operands.slice(1).map(op => rows[op.first] - LINE_ABOVE * ROW),
      guards: f.operands.map((op, n) => {
        const text = `[${op.guard}]`
        return { u: startingAt(u0 + (n === 0 ? tagW + 0.25 * ROW : 0.3 * ROW), text, pixels), v: rows[op.first] - GUARD_ABOVE * ROW, text }
      }),
      tag: [startingAt(u0 + 0.05 * ROW, 'alt', pixels), v0 + 0.82 * ROW],
      tagW,
    })
  })

  // the network: between the last client lifeline and the first server one
  let boundary: Diagram['boundary']
  const server = participants.findIndex(p => p.side === 'server')
  if (server > 0) {
    const u = (columns[server - 1].u + columns[server].u) / 2
    // tRPC when a call names a procedure; HTTP for a route (GET /x) or no call at all
    const trpc = messages.some(m => m.kind === 'rpc' && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY|\*) /.test(m.label))
    boundary = { u, label: trpc ? 'network · tRPC' : 'network · HTTP' }
  }

  const more: Diagram['more'] = []
  messages.forEach((m, k) => {
    const a = actOf.get(k)
    const text = `+${m.hidden} call${m.hidden === 1 ? '' : 's'}`
    if (m.hidden && a) more.push({ message: k, u: startingAt(a.u + ACT_W / 2 + 0.12 * ROW, text, pixels), v: a.v1, text })
  })

  return {
    scenario,
    width,
    height,
    viewport,
    pixels,
    headerV,
    columns,
    rows,
    activations,
    arrows,
    labels,
    fragments: boxes,
    boundary,
    caption: [SIDE_PX / fitHeight, CAPTION * ROW],
    heading: [SIDE_PX / fitHeight, HEADING * ROW],
    more,
  }
}

/** One fragment holds another: the other's messages lie within one of its operands. */
function contains(outer: Scenario['fragments'][number], inner: Scenario['fragments'][number]) {
  const a = inner.operands[0]?.first ?? -1
  const b = inner.operands[inner.operands.length - 1]?.last ?? -1
  return outer.operands.some(op => op.first <= a && b <= op.last)
}
