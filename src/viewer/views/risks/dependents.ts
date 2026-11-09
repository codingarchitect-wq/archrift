// Risks view: how much breaks with a file, as the number of files that
// depend on it, directly or not. Counted on the graph condensed to its
// strongly connected components (an import cycle's files depend on each
// other, and share their dependents), one bitset of dependents per component,
// filled from the components nothing depends on downward. About 13 MB of
// bitsets and well under a second at 10k files; pure and deterministic.

/**
 * For each id, how many other ids reach it along `dependents` (id → the ids
 * that depend on it), every step counted, the id itself never.
 */
export function dependentCounts(ids: readonly string[], dependents: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const n = ids.length
  const index = new Map(ids.map((id, i) => [id, i]))
  // the edges between the ids given, as int lists
  const next: number[][] = ids.map(id => {
    const list: number[] = []
    for (const d of dependents.get(id) ?? []) {
      const j = index.get(d)
      if (j !== undefined && j !== index.get(id)) list.push(j)
    }
    return list
  })

  const { component, order } = components(n, next)
  const words = Math.ceil(n / 32)
  const reach: (Uint32Array | null)[] = new Array(order.length).fill(null)
  const members: number[][] = order.map(() => [])
  for (let i = 0; i < n; i++) members[component[i]].push(i)

  // a component comes after every component it reaches (Tarjan's order), so its dependents' sets are done
  for (const c of order) {
    let set: Uint32Array | null = null
    for (const i of members[c])
      for (const j of next[i]) {
        const d = component[j]
        if (d === c) continue
        set ??= new Uint32Array(words)
        for (const k of members[d]) set[k >> 5] |= 1 << (k & 31)
        const r = reach[d]
        if (r) for (let w = 0; w < words; w++) set[w] |= r[w]
      }
    // inside a cycle, each member depends on all the others
    if (members[c].length > 1) {
      set ??= new Uint32Array(words)
      for (const k of members[c]) set[k >> 5] |= 1 << (k & 31)
    }
    reach[c] = set
  }

  const counts = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const set = reach[component[i]]
    let count = 0
    if (set) for (let w = 0; w < words; w++) count += popcount(set[w])
    // the file itself is in its own cycle's set
    if (set && set[i >> 5] & (1 << (i & 31))) count--
    counts.set(ids[i], count)
  }
  return counts
}

/**
 * Strongly connected components (iterative Tarjan): each node's component,
 * and the components in the order found, every one after all it reaches.
 */
function components(n: number, next: readonly (readonly number[])[]): { component: Int32Array; order: number[] } {
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const component = new Int32Array(n).fill(-1)
  const stack: number[] = []
  const order: number[] = []
  let counter = 0
  for (let start = 0; start < n; start++) {
    if (index[start] >= 0) continue
    const work: [node: number, edge: number][] = [[start, 0]]
    index[start] = low[start] = counter++
    stack.push(start)
    onStack[start] = 1
    while (work.length) {
      const frame = work[work.length - 1]
      const [v, e] = frame
      if (e < next[v].length) {
        frame[1]++
        const w = next[v][e]
        if (index[w] < 0) {
          index[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = 1
          work.push([w, 0])
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w])
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        low[parent] = Math.min(low[parent], low[v])
      }
      if (low[v] === index[v]) {
        const c = order.length
        let w: number
        do {
          w = stack.pop()!
          onStack[w] = 0
          component[w] = c
        } while (w !== v)
        order.push(c)
      }
    }
  }
  return { component, order }
}

function popcount(x: number) {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
