// §5 Building Block View, part 2: one board's diagram, as an architect would
// draw it. Blocks sit in rows (layers, top to bottom), ordered within a row
// to cross as little as possible; dependencies run as orthogonal connectors:
// out of a port on the block's side, along a lane in the channel between two
// rows, down (or up) through a lane in the gap between two blocks of a row
// they pass, and into the target's provided interface (a lollipop on its top),
// or into its bottom when they point up. Lanes never share a stretch, and no
// connector crosses a block. Pure and deterministic; board coordinates: u to
// the right, v down, from the board's top-left corner.
import type { P2 } from '../arc42-kit/sketch.ts'

export interface DiagramNode {
  w: number
  h: number
  /** Row, top first (rows left empty are dropped). */
  row: number
  /** Order within the row before crossings are reduced (lower first). */
  rank: number
  /** Incoming connectors end at a lollipop on its top; otherwise at the top edge. */
  lollipop: boolean
}

export interface DiagramEdge {
  from: number
  to: number
  weight: number
}

/** A block's place: its center and size. */
export interface Placed {
  u: number
  v: number
  w: number
  h: number
}

export interface Wire {
  edge: number
  /** From the source's side to the arrow's tip. */
  points: P2[]
  /** What it ends at. */
  end: 'lollipop' | 'top' | 'bottom'
}

export interface Diagram {
  width: number
  height: number
  boxes: Placed[]
  /** Each node's lollipop ring center (null without one or with nothing coming in). */
  lollipops: (P2 | null)[]
  wires: Wire[]
  /** Each (compacted) row's top and bottom. */
  rows: { top: number; bottom: number }[]
}

export interface DiagramOptions {
  /** Room at the top for the board's caption and heading. */
  header: number
  minWidth: number
  /** Most nodes in a row: a longer one wraps into several. */
  maxPerRow?: number
}

/** Lollipop proportions: the stem above the block's top, and the ring's radius. */
export const LOLLIPOP = { stem: 1.0, r: 0.75, ring: 0.28 }
const ARROW = 1.5
/** Space between two lanes, the least gap between two blocks of a row, and beside a row. */
export const LANE = 1.05
const GAP = 7
const OUTER = 5
/** Channels: above the first lane, below the last one (room for lollipops), and the least height. */
const TOP_PAD = 1.8
const BOTTOM_PAD = LOLLIPOP.stem + 2 * LOLLIPOP.r + ARROW + 0.7
const MIN_CHANNEL = 5.5
const PORT_PAD = 1.2
const CENTER_ZONE = 1.8

interface Crossing {
  edge: number
  row: number
  gap: number
}

export function diagram(nodesIn: readonly DiagramNode[], edges: readonly DiagramEdge[], o: DiagramOptions): Diagram {
  const maxPerRow = o.maxPerRow ?? 7
  // rows: compacted, then long ones wrapped (in rank order) into rows of their own
  const usedRows = [...new Set(nodesIn.map(n => n.row))].sort((a, b) => a - b)
  const rowsOf: number[][] = []
  const row = new Array<number>(nodesIn.length)
  for (const r of usedRows) {
    const members = nodesIn.map((n, i) => i).filter(i => nodesIn[i].row === r)
    members.sort((a, b) => nodesIn[a].rank - nodesIn[b].rank || a - b)
    const chunks = Math.ceil(members.length / maxPerRow)
    const per = Math.ceil(members.length / chunks)
    for (let c = 0; c < chunks; c++) {
      const part = members.slice(c * per, (c + 1) * per)
      part.forEach(i => (row[i] = rowsOf.length))
      rowsOf.push(part)
    }
  }
  const R = rowsOf.length
  orderRows(rowsOf, row, edges)

  // u: rows centered, gaps as wide as the lanes passing them need (two passes: place, count, place again)
  let gapWidths: number[][] = rowsOf.map(r => r.map((_, k) => (k === 0 ? OUTER : GAP)).concat(OUTER))
  let place = placeRows(nodesIn, rowsOf, gapWidths, o.minWidth)
  const crossings = chooseGaps(edges, row, rowsOf, place)
  const passing = rowsOf.map(r => new Array<number>(r.length + 1).fill(0))
  for (const c of crossings) passing[c.row][c.gap]++
  gapWidths = gapWidths.map((gaps, r) => gaps.map((g, k) => Math.max(g, (passing[r][k] + 1) * LANE + 2)))
  place = placeRows(nodesIn, rowsOf, gapWidths, o.minWidth)
  const { centerU, width, gapSpan } = place

  // where each crossing passes its gap: lanes spread across it, in the order the edges come from
  const crossingsAt = new Map<string, Crossing[]>()
  for (const c of crossings) push(crossingsAt, `${c.row}:${c.gap}`, c)
  const crossU = new Map<string, number>()
  for (const [key, list] of crossingsAt) {
    const [r, g] = key.split(':').map(Number)
    const [l, rr] = gapSpan(r, g)
    list.sort((a, b) => centerU[edges[a.edge].from] - centerU[edges[b.edge].from] || centerU[edges[a.edge].to] - centerU[edges[b.edge].to] || a.edge - b.edge)
    list.forEach((c, k) => crossU.set(`${c.edge}:${c.row}`, l + ((k + 1) * (rr - l)) / (list.length + 1)))
  }

  // the u each edge passes on its way, source side first (crossed rows only)
  const way = edges.map((e, i) => {
    const [ra, rb] = [row[e.from], row[e.to]]
    return between(ra, rb).map(r => crossU.get(`${i}:${r}`)!)
  })

  // ports: bottom for going down and arriving from below; top for going up or along the row; incoming from above at the lollipop
  const hasLollipop = nodesIn.map((n, i) => n.lollipop && edges.some(e => e.to === i && row[e.from] <= row[i]))
  const ports = new Map<string, number>() // `${edge}:from` / `${edge}:to` → u
  const bottom = nodesIn.map(() => [] as { key: string; toward: number }[])
  const top = nodesIn.map(() => [] as { key: string; toward: number }[])
  edges.forEach((e, i) => {
    const [ra, rb] = [row[e.from], row[e.to]]
    const first = way[i][0] ?? centerU[e.to]
    const last = way[i][way[i].length - 1] ?? centerU[e.from]
    if (ra < rb) bottom[e.from].push({ key: `${i}:from`, toward: first })
    else top[e.from].push({ key: `${i}:from`, toward: first })
    if (ra > rb) bottom[e.to].push({ key: `${i}:to`, toward: last })
    else if (!nodesIn[e.to].lollipop) top[e.to].push({ key: `${i}:to`, toward: last })
  })
  nodesIn.forEach((n, i) => {
    const left = centerU[i] - n.w / 2 + Math.min(PORT_PAD, n.w * 0.15)
    const right = centerU[i] + n.w / 2 - Math.min(PORT_PAD, n.w * 0.15)
    spread(bottom[i], left, right, ports)
    if (!hasLollipop[i]) spread(top[i], left, right, ports)
    else {
      const c = centerU[i]
      spread(top[i].filter(p => p.toward < c), left, c - CENTER_ZONE, ports)
      spread(top[i].filter(p => p.toward >= c), c + CENTER_ZONE, right, ports)
    }
  })

  // horizontal runs: channel c lies above row c (channel R below the last row)
  interface Run {
    edge: number
    channel: number
    u0: number
    u1: number
    lane: number
  }
  const runs: Run[] = []
  const endU = (i: number) => {
    const e = edges[i]
    if (row[e.from] > row[e.to] || !nodesIn[e.to].lollipop) return ports.get(`${i}:to`)!
    return centerU[e.to]
  }
  edges.forEach((e, i) => {
    const [ra, rb] = [row[e.from], row[e.to]]
    const stops = [ports.get(`${i}:from`)!, ...way[i], endU(i)]
    // down: the channels below each row from the source's to the one above the target's; up: the other way
    const channels = ra < rb ? [...between(ra, rb), rb] : ra > rb ? [ra, ...between(ra, rb)] : [ra]
    channels.forEach((c, k) => runs.push({ edge: i, channel: c, u0: stops[k], u1: stops[k + 1], lane: -1 }))
  })
  // lanes: runs into the same lollipop share one (a bus: they merge on their way in); the rest get one each, greedily
  const lanes = new Array<number>(R + 1).fill(0)
  const lastRun = new Map<number, Run>()
  for (const r of runs) lastRun.set(r.edge, r)
  for (let c = 0; c <= R; c++) {
    const items = new Map<string, Run[]>()
    for (const r of runs) {
      if (r.channel !== c || Math.abs(r.u1 - r.u0) < 1e-6) continue
      const e = edges[r.edge]
      const bus = lastRun.get(r.edge) === r && row[e.from] <= row[e.to] && nodesIn[e.to].lollipop
      push(items, bus ? `to:${e.to}` : `edge:${r.edge}`, r)
    }
    const spans = [...items.values()].map(list => ({
      list,
      lo: Math.min(...list.map(r => Math.min(r.u0, r.u1))),
      hi: Math.max(...list.map(r => Math.max(r.u0, r.u1))),
    }))
    spans.sort((a, b) => a.lo - b.lo || a.hi - b.hi || a.list[0].edge - b.list[0].edge)
    const lastEnd: number[] = []
    for (const sp of spans) {
      let lane = lastEnd.findIndex(end => end + 0.9 < sp.lo)
      if (lane < 0) lane = lastEnd.length
      lastEnd[lane] = sp.hi
      for (const r of sp.list) r.lane = lane
    }
    lanes[c] = lastEnd.length
  }

  // v: the header, then channel, row, channel … each channel as high as its lanes need
  const channelTop: number[] = []
  const rowTop: number[] = []
  const rowHeight = rowsOf.map(r => Math.max(...r.map(i => nodesIn[i].h)))
  let v = o.header
  for (let c = 0; c <= R; c++) {
    channelTop[c] = v
    v += Math.max(MIN_CHANNEL, TOP_PAD + Math.max(0, lanes[c] - 1) * LANE + BOTTOM_PAD)
    if (c < R) {
      rowTop[c] = v
      v += rowHeight[c]
    }
  }
  const height = v
  const centerV = nodesIn.map((_, i) => rowTop[row[i]] + rowHeight[row[i]] / 2)
  const boxes = nodesIn.map((n, i) => ({ u: centerU[i], v: centerV[i], w: n.w, h: n.h }))
  const topOf = (i: number) => centerV[i] - nodesIn[i].h / 2
  const bottomOf = (i: number) => centerV[i] + nodesIn[i].h / 2
  const laneV = (c: number, lane: number) => channelTop[c] + TOP_PAD + lane * LANE
  const lollipops = nodesIn.map((_, i) => (hasLollipop[i] ? ([centerU[i], topOf(i) - LOLLIPOP.stem - LOLLIPOP.r] as P2) : null))

  const wires: Wire[] = edges.map((e, i) => {
    const [ra, rb] = [row[e.from], row[e.to]]
    const mine = runs.filter(r => r.edge === i)
    const start: P2 = [ports.get(`${i}:from`)!, ra < rb ? bottomOf(e.from) : topOf(e.from)]
    const points: P2[] = [start]
    for (const r of mine) {
      // a run that goes straight through its channel needs no lane
      const lv = r.lane < 0 ? undefined : laneV(r.channel, r.lane)
      if (lv === undefined) continue
      points.push([r.u0, lv], [r.u1, lv])
    }
    let end: Wire['end']
    let tip: P2
    if (ra > rb) {
      end = 'bottom'
      tip = [endU(i), bottomOf(e.to)]
    } else if (nodesIn[e.to].lollipop) {
      end = 'lollipop'
      tip = [centerU[e.to], lollipops[e.to]![1] - LOLLIPOP.r - LOLLIPOP.ring / 2]
    } else {
      end = 'top'
      tip = [endU(i), topOf(e.to)]
    }
    points.push(tip)
    return { edge: i, points: simplify(points), end }
  })
  const rows = rowsOf.map((_, r) => ({ top: rowTop[r], bottom: rowTop[r] + rowHeight[r] }))
  return { width, height, boxes, lollipops, wires, rows }
}

/** Barycenter sweeps: each row ordered by where its neighbors in the rows above (then below) are. */
function orderRows(rowsOf: number[][], row: number[], edges: readonly DiagramEdge[]) {
  const pos = new Map<number, number>()
  const update = () => rowsOf.forEach(r => r.forEach((n, k) => pos.set(n, (k + 0.5) / r.length)))
  update()
  const weightOf = (e: DiagramEdge) => Math.log2(2 + e.weight)
  const neighbors = new Map<number, { other: number; w: number }[]>()
  for (const e of edges) {
    if (e.from === e.to) continue
    push(neighbors, e.from, { other: e.to, w: weightOf(e) })
    push(neighbors, e.to, { other: e.from, w: weightOf(e) })
  }
  const sweep = (r: number, above: boolean) => {
    const key = new Map<number, number>()
    for (const n of rowsOf[r]) {
      let sum = 0
      let w = 0
      for (const { other, w: ew } of neighbors.get(n) ?? []) {
        if (above ? row[other] >= r : row[other] <= r) continue
        sum += pos.get(other)! * ew
        w += ew
      }
      key.set(n, w ? sum / w : pos.get(n)!)
    }
    rowsOf[r].sort((a, b) => key.get(a)! - key.get(b)! || pos.get(a)! - pos.get(b)! || a - b)
    rowsOf[r].forEach((n, k) => pos.set(n, (k + 0.5) / rowsOf[r].length))
  }
  for (let it = 0; it < 4; it++) {
    for (let r = 1; r < rowsOf.length; r++) sweep(r, true)
    for (let r = rowsOf.length - 2; r >= 0; r--) sweep(r, false)
  }
}

/** Rows laid out left to right with the given gaps, each centered on the widest. */
function placeRows(nodes: readonly DiagramNode[], rowsOf: number[][], gapWidths: number[][], minWidth: number) {
  const rowWidth = rowsOf.map((r, ri) => r.reduce((s, n) => s + nodes[n].w, 0) + gapWidths[ri].reduce((a, b) => a + b, 0))
  const width = Math.max(minWidth, ...rowWidth)
  const centerU = new Array<number>(nodes.length)
  const starts: number[] = []
  rowsOf.forEach((r, ri) => {
    let u = (width - rowWidth[ri]) / 2
    starts[ri] = u
    r.forEach((n, k) => {
      u += gapWidths[ri][k]
      centerU[n] = u + nodes[n].w / 2
      u += nodes[n].w
    })
  })
  /** A gap's extent: between two blocks, or from the row's end to its outer margin. */
  const gapSpan = (ri: number, k: number): [number, number] => {
    const r = rowsOf[ri]
    const left = k === 0 ? starts[ri] : centerU[r[k - 1]] + nodes[r[k - 1]].w / 2
    const right = k === r.length ? left + gapWidths[ri][k] : centerU[r[k]] - nodes[r[k]].w / 2
    return [left, right]
  }
  return { width, centerU, gapSpan }
}

/** For each row an edge passes (neither its source's nor its target's), the gap nearest to where the edge would be. */
function chooseGaps(edges: readonly DiagramEdge[], row: number[], rowsOf: number[][], place: ReturnType<typeof placeRows>): Crossing[] {
  const out: Crossing[] = []
  edges.forEach((e, i) => {
    const [ra, rb] = [row[e.from], row[e.to]]
    if (Math.abs(ra - rb) < 2) return
    const [ua, ub] = [place.centerU[e.from], place.centerU[e.to]]
    const step = ra < rb ? 1 : -1
    for (let r = ra + step; r !== rb; r += step) {
      const want = ua + ((ub - ua) * (r - ra)) / (rb - ra)
      let best = 0
      let bestD = Infinity
      for (let k = 0; k <= rowsOf[r].length; k++) {
        const [l, rr] = place.gapSpan(r, k)
        const d = want < l ? l - want : want > rr ? want - rr : 0
        if (d < bestD - 1e-9) {
          best = k
          bestD = d
        }
      }
      out.push({ edge: i, row: r, gap: best })
    }
  })
  return out
}

/** Ports spread evenly along a side, in the order of where their connectors head. */
function spread(list: { key: string; toward: number }[], left: number, right: number, ports: Map<string, number>) {
  if (!list.length) return
  list.sort((a, b) => a.toward - b.toward || (a.key < b.key ? -1 : 1))
  if (right < left) [left, right] = [(left + right) / 2, (left + right) / 2]
  list.forEach((p, k) => ports.set(p.key, left + ((k + 1) * (right - left)) / (list.length + 1)))
}

/** Drop repeated points and the middle of straight runs. */
function simplify(points: P2[]): P2[] {
  const out: P2[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue
    out.push(p)
  }
  // a turn needs both an axis change; collinear middles go
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]]
    const sameU = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - c[0]) < 1e-6
    const sameV = Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - c[1]) < 1e-6
    if (sameU || sameV) out.splice(i, 1)
  }
  return out
}

/** The rows strictly between two rows, in the order an edge from the first to the second passes them. */
function between(a: number, b: number): number[] {
  const out: number[] = []
  if (a < b) for (let r = a + 1; r < b; r++) out.push(r)
  else for (let r = a - 1; r > b; r--) out.push(r)
  return out
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}
