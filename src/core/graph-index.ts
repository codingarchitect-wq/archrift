// Lookup structures over a Graph: by id, containment children, in/out edges,
// and the ancestor at a given containment level. Built once, read often.
import type { Graph, GraphEdge, GraphNode } from './model.ts'

export class GraphIndex {
  readonly graph: Graph
  readonly byId: Map<string, GraphNode>
  readonly children = new Map<string, string[]>()
  readonly outgoing = new Map<string, number[]>() // node id → edge indices
  readonly incoming = new Map<string, number[]>()

  constructor(graph: Graph) {
    this.graph = graph
    this.byId = new Map(graph.nodes.map(n => [n.id, n]))
    for (const n of graph.nodes) if (n.parent !== undefined) push(this.children, n.parent, n.id)
    graph.edges.forEach((e, i) => {
      push(this.outgoing, e.source, i)
      push(this.incoming, e.target, i)
    })
  }

  node(id: string) {
    return this.byId.get(id)
  }

  out(id: string): GraphEdge[] {
    return (this.outgoing.get(id) ?? []).map(i => this.graph.edges[i])
  }

  in(id: string): GraphEdge[] {
    return (this.incoming.get(id) ?? []).map(i => this.graph.edges[i])
  }

  /** The file node containing a node (itself for files); undefined for directories and externals. */
  fileOf(id: string): GraphNode | undefined {
    let n = this.byId.get(id)
    while (n && n.kind !== 'file') n = n.parent === undefined ? undefined : this.byId.get(n.parent)
    return n
  }

  /** Ancestors from the node up to the root, nearest first (excluding the node). */
  ancestors(id: string): GraphNode[] {
    const out: GraphNode[] = []
    let n = this.byId.get(id)
    while (n?.parent !== undefined) {
      n = this.byId.get(n.parent)
      if (n) out.push(n)
    }
    return out
  }

  /** Nodes in the subtree below `id`, depth-first, excluding `id`. */
  descendants(id: string): GraphNode[] {
    const out: GraphNode[] = []
    const stack = [...(this.children.get(id) ?? [])]
    while (stack.length) {
      const c = stack.pop()!
      out.push(this.byId.get(c)!)
      stack.push(...(this.children.get(c) ?? []))
    }
    return out
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}
