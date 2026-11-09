// Diagram kit: a layered layout (after Sugiyama) for one connected group of
// cards, in the coordinates of its two axes: `r` runs along the ranks (the
// ERD's parents left of their children, the class diagram's bases above
// their subtypes), `c` across them. Ranks come from the ordering constraints
// (cycles broken, a rank too long wrapping into the next); a connector
// spanning ranks gets a waypoint in each rank between, so it passes between
// the cards; barycenter sweeps order each rank to cross little; positions
// across come as close to the connected cards as order and spacing allow
// (least squares, pool-adjacent-violators); connectors run orthogonally
// through the gaps between ranks, each on a track of its own there. Pure and
// deterministic: the same input always gives the same picture.

export interface LayerNode {
  /** Its extent along the rank axis, and across it. */
  r: number
  c: number
}

export interface LayerEdge {
  from: number
  to: number
  /** Where it leaves `from` and reaches `to`, across from the card's start (a table's row); spread along the side when left out. */
  fromAt?: number
  toAt?: number
}

export interface LayerOptions {
  /** The least room between ranks, and between cards of a rank. */
  gap: number
  spacing: number
  /** Between parallel connectors in a gap. */
  track: number
  /** A rank's extent across beyond which cards move on to the next rank. */
  cap: number
  /** Cards at the start of their rank's band (tops aligned), or centered in it. */
  align: 'start' | 'center'
}

export type P = [number, number]

export interface LayeredResult {
  /** Per card: its rank and its start corner. */
  nodes: { rank: number; r: number; c: number }[]
  /** Per connector: a polyline in (r, c), from `from` to `to`. */
  edges: P[][]
  size: { r: number; c: number }
}

/** An element of a rank: a card, or a connector's waypoint. */
interface Slot {
  node: number
  edge: number
  rank: number
  size: number
  pos: number
}

interface Chain {
  edge: LayerEdge
  /** Slot indices from `from` to `to`. */
  slots: number[]
  fromAt: number
  toAt: number
}

/**
 * Lay out cards `nodes` with `edges` to draw between them; `before` lists
 * [earlier, later] pairs: the earlier card's rank comes first.
 */
export function layered(nodes: readonly LayerNode[], edges: readonly LayerEdge[], before: readonly [number, number][], o: LayerOptions): LayeredResult {
  const rank = ranksOf(nodes, before, o)
  const slots: Slot[] = nodes.map((n, i) => ({ node: i, edge: -1, rank: rank[i], size: n.c, pos: 0 }))
  const chains = edges.map((e, k) => chainOf(e, k, rank, slots, o))
  const byRank = ranksWith(slots, Math.max(0, ...rank) + 1)
  orderRanks(byRank, slots, chains)
  spreadAttachments(chains, slots, byRank, nodes)
  placeAcross(byRank, slots, chains, o)
  return route(nodes, rank, slots, chains, byRank, o)
}

// ── ranks ───────────────────────────────────────────────────────────────────

/** Each card's rank: after every card it must follow (cycles ignored), in the first rank with room. */
function ranksOf(nodes: readonly LayerNode[], before: readonly [number, number][], o: LayerOptions): number[] {
  const after = acyclic(nodes.length, before)
  const preds = nodes.map((): number[] => [])
  for (const [a, b] of after) preds[b].push(a)
  const rank = nodes.map(() => -1)
  const load: number[] = []
  for (const i of topological(nodes.length, after)) {
    let r = Math.max(0, ...preds[i].map(p => rank[p] + 1))
    while ((load[r] ?? 0) > 0 && (load[r] ?? 0) + nodes[i].c > o.cap) r++
    rank[i] = r
    load[r] = (load[r] ?? 0) + nodes[i].c + o.spacing
  }
  return rank
}

/** The pairs without those closing a cycle (depth first, in index order), and without self-pairs. */
function acyclic(n: number, pairs: readonly [number, number][]): [number, number][] {
  const next: number[][] = Array.from({ length: n }, () => [])
  pairs.forEach(([a, b], k) => a !== b && next[a].push(k))
  const state = new Uint8Array(n) // 0 new, 1 on the stack, 2 done
  const kept: [number, number][] = []
  const visit = (v: number) => {
    state[v] = 1
    for (const k of next[v]) {
      const w = pairs[k][1]
      if (state[w] === 1) continue
      kept.push(pairs[k])
      if (state[w] === 0) visit(w)
    }
    state[v] = 2
  }
  for (let v = 0; v < n; v++) if (!state[v]) visit(v)
  return kept
}

/** An order in which every card comes after those it follows: the lowest index first among the free ones. */
function topological(n: number, pairs: readonly [number, number][]): number[] {
  const indegree = new Array<number>(n).fill(0)
  const next: number[][] = Array.from({ length: n }, () => [])
  for (const [a, b] of pairs) {
    next[a].push(b)
    indegree[b]++
  }
  const free = [...Array(n).keys()].filter(i => indegree[i] === 0)
  const out: number[] = []
  while (free.length) {
    const v = free.shift()!
    out.push(v)
    for (const w of next[v]) if (--indegree[w] === 0) insertSorted(free, w)
  }
  return out
}

function insertSorted(list: number[], v: number) {
  let i = list.length
  while (i > 0 && list[i - 1] > v) i--
  list.splice(i, 0, v)
}

/** A connector's slots: its ends, and a waypoint in each rank between them. */
function chainOf(e: LayerEdge, k: number, rank: number[], slots: Slot[], o: LayerOptions): Chain {
  const [ra, rb] = [rank[e.from], rank[e.to]]
  const step = rb > ra ? 1 : -1
  const ids = [e.from]
  for (let r = ra + step; Math.abs(rb - r) > 0 && ra !== rb; r += step) {
    ids.push(slots.length)
    slots.push({ node: -1, edge: k, rank: r, size: o.track * 0.5, pos: 0 })
  }
  ids.push(e.to)
  return { edge: e, slots: ids, fromAt: e.fromAt ?? NaN, toAt: e.toAt ?? NaN }
}

function ranksWith(slots: Slot[], count: number): number[][] {
  const byRank: number[][] = Array.from({ length: count }, () => [])
  slots.forEach((s, i) => byRank[s.rank].push(i))
  return byRank
}

// ── order within ranks ──────────────────────────────────────────────────────

/** Neighbors of each slot in the rank before and after, along the chains. */
function neighbors(slots: Slot[], chains: Chain[]) {
  const prev = slots.map((): number[] => [])
  const next = slots.map((): number[] => [])
  for (const ch of chains)
    for (let i = 1; i < ch.slots.length; i++) {
      const [a, b] = [ch.slots[i - 1], ch.slots[i]]
      if (slots[a].rank === slots[b].rank) continue
      const [lo, hi] = slots[a].rank < slots[b].rank ? [a, b] : [b, a]
      next[lo].push(hi)
      prev[hi].push(lo)
    }
  return { prev, next }
}

const SWEEPS = 6

/** Barycenter sweeps down and up: each slot moves to the mean place of its neighbors in the rank swept from. */
function orderRanks(byRank: number[][], slots: Slot[], chains: Chain[]) {
  const { prev, next } = neighbors(slots, chains)
  const place = new Float64Array(slots.length)
  const index = () => byRank.forEach(list => list.forEach((s, i) => (place[s] = i)))
  index()
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0
    for (let k = 0; k < byRank.length; k++) {
      const r = down ? k : byRank.length - 1 - k
      const from = down ? prev : next
      const key = (s: number) => (from[s].length ? mean(from[s].map(n => place[n])) : place[s])
      byRank[r].sort((a, b) => key(a) - key(b) || place[a] - place[b])
      byRank[r].forEach((s, i) => (place[s] = i))
    }
  }
  index()
}

/** Connectors without a given place on a card's side spread along it, in the order of where they go. */
function spreadAttachments(chains: Chain[], slots: Slot[], byRank: number[][], nodes: readonly LayerNode[]) {
  const place = new Map<number, number>()
  byRank.forEach(list => list.forEach((s, i) => place.set(s, i)))
  const sides = new Map<string, { chain: Chain; end: 'from' | 'to'; toward: number }[]>()
  for (const ch of chains) {
    const s = ch.slots
    const sameRank = slots[s[0]].rank === slots[s[s.length - 1]].rank
    for (const end of ['from', 'to'] as const) {
      if (!Number.isNaN(end === 'from' ? ch.fromAt : ch.toAt)) continue
      const node = end === 'from' ? s[0] : s[s.length - 1]
      const other = end === 'from' ? s[1] : s[s.length - 2]
      const side = sameRank || slots[other].rank > slots[node].rank ? 'end' : 'start'
      push(sides, `${node}:${side}`, { chain: ch, end, toward: place.get(other) ?? 0 })
    }
  }
  for (const [key, list] of sides) {
    const size = nodes[Number(key.split(':')[0])].c
    list.sort((a, b) => a.toward - b.toward)
    list.forEach((x, i) => {
      const at = (size * (i + 1)) / (list.length + 1)
      if (x.end === 'from') x.chain.fromAt = at
      else x.chain.toAt = at
    })
  }
}

// ── positions across ────────────────────────────────────────────────────────

const PASSES = 10

/** Positions across: packed in order first, then drawn toward the connected slots, order and spacing kept. */
function placeAcross(byRank: number[][], slots: Slot[], chains: Chain[], o: LayerOptions) {
  for (const list of byRank) {
    let at = 0
    list.forEach((s, i) => {
      if (i) at += spacingBetween(slots[list[i - 1]], slots[s], o)
      slots[s].pos = at
      at += slots[s].size
    })
  }
  const links = attachLinks(slots, chains)
  for (let pass = 0; pass < PASSES; pass++) {
    const down = pass % 2 === 0
    for (let k = 0; k < byRank.length; k++) {
      const list = byRank[down ? k : byRank.length - 1 - k]
      const want = list.map(s => wanted(s, slots, links, pass === PASSES - 1 ? 0 : down ? -1 : 1))
      const gaps = list.slice(0, -1).map((s, i) => slots[s].size + spacingBetween(slots[s], slots[list[i + 1]], o))
      inOrder(want, gaps).forEach((p, i) => (slots[list[i]].pos = p))
    }
  }
}

/** Two cards keep the spacing apart, two waypoints a track, a card and a waypoint about half way. */
function spacingBetween(a: Slot, b: Slot, o: LayerOptions): number {
  const dummies = Number(a.node < 0) + Number(b.node < 0)
  return dummies === 2 ? o.track : dummies === 1 ? (o.spacing + o.track) / 2 : o.spacing
}

/** For each slot, the other slots it's tied to: its own attach offset and theirs. */
function attachLinks(slots: Slot[], chains: Chain[]) {
  const links = slots.map((): { other: number; mine: number; theirs: number }[] => [])
  for (const ch of chains) {
    const s = ch.slots
    for (let i = 1; i < s.length; i++) {
      const [a, b] = [s[i - 1], s[i]]
      if (a === b) continue
      const offA = i === 1 ? ch.fromAt : slots[a].size / 2
      const offB = i === s.length - 1 ? ch.toAt : slots[b].size / 2
      links[a].push({ other: b, mine: offA, theirs: offB })
      links[b].push({ other: a, mine: offB, theirs: offA })
    }
  }
  return links
}

/** Where a slot would like to start: so that its ties line up with the slots they lead to, on one side (−1 before, 1 after) or both (0). */
function wanted(s: number, slots: Slot[], links: ReturnType<typeof attachLinks>, side: number): number {
  const rank = slots[s].rank
  const ties = links[s].filter(l => slots[l.other].rank !== rank && (side === 0 || Math.sign(slots[l.other].rank - rank) === side))
  if (!ties.length) return slots[s].pos
  return mean(ties.map(l => slots[l.other].pos + l.theirs - l.mine))
}

/**
 * Positions in order, each at least `gaps[i]` after the one before, as close
 * to `want` as that allows in the least-squares sense (isotonic regression of
 * the wanted positions less the gaps before them).
 */
export function inOrder(want: readonly number[], gaps: readonly number[]): number[] {
  const offset = [0]
  for (const g of gaps) offset.push(offset[offset.length - 1] + g)
  const blocks: { sum: number; n: number }[] = []
  for (let i = 0; i < want.length; i++) {
    blocks.push({ sum: want[i] - offset[i], n: 1 })
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const last = blocks.pop()!
      blocks[blocks.length - 1].sum += last.sum
      blocks[blocks.length - 1].n += last.n
    }
  }
  const out: number[] = []
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + offset[out.length])
  return out
}

// ── routing ─────────────────────────────────────────────────────────────────

/** A connector's run through a gap: from one place across to another, on a track. */
interface Run {
  chain: number
  gap: number
  lo: number
  hi: number
  track: number
}

function route(nodes: readonly LayerNode[], rank: number[], slots: Slot[], chains: Chain[], byRank: number[][], o: LayerOptions): LayeredResult {
  const shift = -Math.min(0, ...slots.map(s => s.pos))
  for (const s of slots) s.pos += shift
  const ranks = byRank.length
  const band = byRank.map(list => Math.max(o.track, ...list.filter(s => slots[s].node >= 0).map(s => nodes[slots[s].node].r)))
  const runs = runsOf(chains, slots)
  const tracks = assignTracks(runs, ranks)
  const width = tracks.map(t => Math.max(o.gap, o.gap + (t - 1) * o.track))
  const start = [0]
  for (let k = 1; k < ranks; k++) start.push(start[k - 1] + band[k - 1] + width[k - 1])
  const cardR = (i: number) => start[rank[i]] + (o.align === 'center' ? (band[rank[i]] - nodes[i].r) / 2 : 0)
  const channel = (gap: number, track: number) => start[gap] + band[gap] + (width[gap] - (tracks[gap] - 1) * o.track) / 2 + track * o.track
  const edges = chains.map((ch, k) => polyline(ch, k, nodes, slots, runs, cardR, channel))
  const size = { r: start[ranks - 1] + band[ranks - 1] + (tracks[ranks - 1] ? width[ranks - 1] : 0), c: Math.max(0, ...slots.map(s => s.pos + s.size)) }
  return { nodes: nodes.map((_, i) => ({ rank: rank[i], r: cardR(i), c: slots[i].pos })), edges, size }
}

/** Where each slot of a chain is crossed: a card at its attach offset, a waypoint at its middle. */
function crossings(ch: Chain, slots: Slot[]): number[] {
  return ch.slots.map((s, i) => slots[s].pos + (i === 0 ? ch.fromAt : i === ch.slots.length - 1 ? ch.toAt : slots[s].size / 2))
}

/** The gap runs of every chain that turns (a straight one needs no track). */
function runsOf(chains: Chain[], slots: Slot[]): Run[] {
  const runs: Run[] = []
  chains.forEach((ch, k) => {
    const at = crossings(ch, slots)
    const s = ch.slots
    if (slots[s[0]].rank === slots[s[s.length - 1]].rank) {
      // both ends in one rank (a loop on itself included): a U through the gap after it
      runs.push({ chain: k, gap: slots[s[0]].rank, lo: Math.min(at[0], at[at.length - 1]), hi: Math.max(at[0], at[at.length - 1]), track: 0 })
      return
    }
    for (let i = 1; i < s.length; i++) {
      if (Math.abs(at[i] - at[i - 1]) < 1e-6) continue
      runs.push({ chain: k, gap: Math.min(slots[s[i - 1]].rank, slots[s[i]].rank), lo: Math.min(at[i - 1], at[i]), hi: Math.max(at[i - 1], at[i]), track: 0 })
    }
  })
  return runs
}

/** Tracks per gap: overlapping runs on different ones (interval coloring, lowest free track first). */
function assignTracks(runs: Run[], ranks: number): number[] {
  const count = new Array<number>(ranks).fill(0)
  const byGap = new Map<number, Run[]>()
  for (const run of runs) push(byGap, run.gap, run)
  for (const [gap, list] of byGap) {
    list.sort((a, b) => a.lo - b.lo || a.hi - b.hi || a.chain - b.chain)
    const ends: number[] = []
    for (const run of list) {
      let t = ends.findIndex(end => end < run.lo - 0.01)
      if (t < 0) t = ends.length
      ends[t] = run.hi
      run.track = t
    }
    count[gap] = ends.length
  }
  return count
}

/** A chain's polyline: out of its first card's side, along its gaps' tracks, into its last card's side. */
function polyline(ch: Chain, k: number, nodes: readonly LayerNode[], slots: Slot[], runs: Run[], cardR: (i: number) => number, channel: (gap: number, track: number) => number): P[] {
  const at = crossings(ch, slots)
  const s = ch.slots
  const [a, b] = [ch.edge.from, ch.edge.to]
  const mine = runs.filter(r => r.chain === k)
  const side = (i: number, end: boolean) => cardR(i) + (end ? nodes[i].r : 0)
  if (slots[a].rank === slots[b].rank) {
    const x = channel(mine[0].gap, mine[0].track)
    return [[side(a, true), at[0]], [x, at[0]], [x, at[at.length - 1]], [side(b, true), at[at.length - 1]]]
  }
  const forward = slots[b].rank > slots[a].rank
  const points: P[] = [[side(a, forward), at[0]]]
  let next = 0
  for (let i = 1; i < s.length; i++) {
    if (Math.abs(at[i] - at[i - 1]) < 1e-6) continue
    const run = mine[next++]
    const x = channel(run.gap, run.track)
    points.push([x, at[i - 1]], [x, at[i]])
  }
  points.push([side(b, !forward), at[at.length - 1]])
  return points
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}
