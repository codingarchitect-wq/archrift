// Graph algorithms shared by the CLI and the viewer.

/**
 * Strongly connected components that form cycles (size > 1, or a self-loop),
 * via an iterative Tarjan so deep import chains can't overflow the stack.
 * Components come out largest first; members keep the order of `nodes`.
 */
export function cycles(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const found: string[][] = []
  let counter = 0

  for (const start of nodes) {
    if (index.has(start)) continue
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }]
    index.set(start, counter)
    low.set(start, counter++)
    stack.push(start)
    onStack.add(start)
    while (work.length) {
      const frame = work[work.length - 1]
      const succ = adjacency.get(frame.node) ?? []
      if (frame.next < succ.length) {
        const w = succ[frame.next++]
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter++)
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, next: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          component.push(w)
        } while (w !== frame.node)
        if (component.length > 1 || (adjacency.get(frame.node) ?? []).includes(frame.node)) found.push(component)
      }
    }
  }
  const order = new Map(nodes.map((n, i) => [n, i]))
  for (const c of found) c.sort((a, b) => order.get(a)! - order.get(b)!)
  return found.sort((a, b) => b.length - a.length || order.get(a[0])! - order.get(b[0])!)
}

/** Distinct fan-in / fan-out per node over (source, target) pairs, ignoring self-loops. */
export function fanInOut(pairs: Iterable<{ source: string; target: string }>) {
  const outs = new Map<string, Set<string>>()
  const ins = new Map<string, Set<string>>()
  for (const { source, target } of pairs) {
    if (source === target) continue
    ;(outs.get(source) ?? outs.set(source, new Set()).get(source)!).add(target)
    ;(ins.get(target) ?? ins.set(target, new Set()).get(target)!).add(source)
  }
  return {
    fanOut: (id: string) => outs.get(id)?.size ?? 0,
    fanIn: (id: string) => ins.get(id)?.size ?? 0,
  }
}

/** Nodes reachable from `start` within `maxDepth` steps (start nodes at depth 0), with the edge that found each. */
export function reach(
  adjacency: ReadonlyMap<string, readonly string[]>,
  start: Iterable<string>,
  maxDepth = Infinity,
): Map<string, { depth: number; via?: string }> {
  const found = new Map<string, { depth: number; via?: string }>()
  let frontier: string[] = []
  for (const s of start) {
    if (found.has(s)) continue
    found.set(s, { depth: 0 })
    frontier.push(s)
  }
  for (let depth = 1; frontier.length && depth <= maxDepth; depth++) {
    const next: string[] = []
    for (const n of frontier)
      for (const m of adjacency.get(n) ?? []) {
        if (found.has(m)) continue
        found.set(m, { depth, via: n })
        next.push(m)
      }
    frontier = next
  }
  return found
}

/** Up to `limit` shortest paths from `from` to `to` (each a node list), or [] when there is none. */
export function shortestPaths(adjacency: ReadonlyMap<string, readonly string[]>, from: string, to: string, limit = 5): string[][] {
  if (from === to) return [[from]]
  const dist = new Map<string, number>([[from, 0]])
  const preds = new Map<string, string[]>()
  let frontier = [from]
  while (frontier.length && !dist.has(to)) {
    const next: string[] = []
    for (const n of frontier)
      for (const m of adjacency.get(n) ?? []) {
        const d = dist.get(n)! + 1
        if (!dist.has(m)) {
          dist.set(m, d)
          preds.set(m, [n])
          next.push(m)
        } else if (dist.get(m) === d) preds.get(m)!.push(n)
      }
    frontier = next
  }
  if (!dist.has(to)) return []
  const paths: string[][] = []
  const walk = (node: string, tail: string[]) => {
    if (paths.length >= limit) return
    if (node === from) return void paths.push([from, ...tail])
    for (const p of [...(preds.get(node) ?? [])].sort()) walk(p, [node, ...tail])
  }
  walk(to, [])
  return paths
}

/**
 * Louvain community detection (modularity, weighted, undirected), deterministic:
 * nodes are visited in the given order and ties go to the lowest community.
 * Returns each node's community, numbered by community size (0 = largest).
 */
export function louvain(nodes: readonly string[], edges: readonly { source: string; target: string; weight?: number }[], resolution = 1): Map<string, number> {
  const index = new Map(nodes.map((n, i) => [n, i]))
  // current level graph: adjacency as maps of neighbor → weight
  let adj: Map<number, number>[] = nodes.map(() => new Map())
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined) continue
    const w = e.weight ?? 1
    adj[a].set(b, (adj[a].get(b) ?? 0) + w)
    adj[b].set(a, (adj[b].get(a) ?? 0) + w)
  }
  // membership of original nodes in current-level nodes
  let membership = nodes.map((_, i) => i)

  for (let level = 0; level < 20; level++) {
    const n = adj.length
    const degree = adj.map(m => [...m.values()].reduce((a, b) => a + b, 0))
    const m2 = degree.reduce((a, b) => a + b, 0) // 2m
    if (m2 === 0) break
    const community = [...Array(n).keys()]
    const total = [...degree] // sum of degrees per community
    let moved = false
    for (let pass = 0; pass < 50; pass++) {
      let changed = 0
      for (let i = 0; i < n; i++) {
        const own = community[i]
        const toCommunity = new Map<number, number>()
        for (const [j, w] of adj[i]) if (j !== i) toCommunity.set(community[j], (toCommunity.get(community[j]) ?? 0) + w)
        total[own] -= degree[i]
        let best = own
        let bestGain = (toCommunity.get(own) ?? 0) - (resolution * total[own] * degree[i]) / m2
        for (const [c, w] of [...toCommunity].sort((a, b) => a[0] - b[0])) {
          const gain = w - (resolution * total[c] * degree[i]) / m2
          if (gain > bestGain + 1e-12) {
            best = c
            bestGain = gain
          }
        }
        total[best] += degree[i]
        if (best !== own) {
          community[i] = best
          changed++
        }
      }
      if (!changed) break
      moved = true
    }
    if (!moved) break
    // aggregate: communities become the next level's nodes
    const ids = [...new Set(community)].sort((a, b) => a - b)
    const renumber = new Map(ids.map((c, i) => [c, i]))
    const next: Map<number, number>[] = ids.map(() => new Map())
    for (let i = 0; i < n; i++)
      for (const [j, w] of adj[i]) {
        const a = renumber.get(community[i])!
        const b = renumber.get(community[j])!
        next[a].set(b, (next[a].get(b) ?? 0) + w)
      }
    membership = membership.map(c => renumber.get(community[c])!)
    adj = next
  }
  // number communities by size, largest first, ties by first member
  const size = new Map<number, number>()
  const first = new Map<number, number>()
  membership.forEach((c, i) => {
    size.set(c, (size.get(c) ?? 0) + 1)
    if (!first.has(c)) first.set(c, i)
  })
  const order = [...size.keys()].sort((a, b) => size.get(b)! - size.get(a)! || first.get(a)! - first.get(b)!)
  const rank = new Map(order.map((c, i) => [c, i]))
  return new Map(nodes.map((node, i) => [node, rank.get(membership[i])!]))
}

/**
 * Betweenness centrality (Brandes 2001), directed and unweighted: for each node,
 * how many of the shortest paths between two other nodes pass through it, the
 * paths of one pair sharing one. Deterministic: sources and successors are
 * walked in sorted order. Above `sampleAbove` nodes only every k-th source (in
 * sorted order) is walked, about `sampleAbove` of them, and the sums are scaled
 * by n / sources. Not normalized: divide by (n − 1)(n − 2) for the share of
 * ordered pairs.
 */
export function betweenness(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>, sampleAbove = 1500): Map<string, number> {
  const order = [...new Set(nodes)].sort()
  const at = new Map(order.map((n, i) => [n, i]))
  const succ = order.map((n, i) => [...new Set((adjacency.get(n) ?? []).map(m => at.get(m)))].filter((j): j is number => j !== undefined && j !== i).sort((a, b) => a - b))
  const score = new Float64Array(order.length)
  const step = Math.max(1, Math.ceil(order.length / Math.max(1, sampleAbove)))
  const from = brandes(succ, score)
  let sources = 0
  for (let s = 0; s < order.length; s += step, sources++) from(s)
  const scale = sources ? order.length / sources : 0
  return new Map(order.map((n, i) => [n, score[i] * scale]))
}

/** One source's shortest paths (BFS), their counts, and each node's share of them added to `score`. */
function brandes(succ: readonly (readonly number[])[], score: Float64Array): (source: number) => void {
  const n = succ.length
  const sigma = new Float64Array(n)
  const dist = new Int32Array(n)
  const delta = new Float64Array(n)
  const queue = new Int32Array(n)
  return source => {
    sigma.fill(0)
    dist.fill(-1)
    delta.fill(0)
    sigma[source] = 1
    dist[source] = 0
    queue[0] = source
    let tail = 1
    for (let head = 0; head < tail; head++) {
      const v = queue[head]
      for (const w of succ[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1
          queue[tail++] = w
        }
        if (dist[w] === dist[v] + 1) sigma[w] += sigma[v]
      }
    }
    // farthest first: a node's successors one step further are done when it comes up
    for (let i = tail - 1; i > 0; i--) {
      const v = queue[i]
      for (const w of succ[v]) if (dist[w] === dist[v] + 1) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
      score[v] += delta[v]
    }
  }
}
