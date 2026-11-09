// The project's building blocks as an archify architecture diagram: a
// component per block (the folders its production code splits into, as
// `archrift init` finds them), one row per layer (the config's layers, else the
// order the blocks' imports keep), the databases the code declares in a row
// below, and a connection wherever one block's files import another's at run
// time or query a database.
import { shapeOf } from '../first-look.ts'
import type { Block } from '../first-look.ts'
import { isRuntimeImport } from '../model.ts'
import type { Graph, GraphNode } from '../model.ts'
import { GRID_MAX, Ids, engineLabel, gridCells, orderRows, outputName } from './common.ts'

export interface ArchComponent {
  id: string
  type: 'frontend' | 'backend' | 'database' | 'external'
  label: string
  sublabel?: string
  row: number
  col: number
}

export interface ArchConnection {
  id: string
  from: string
  to: string
  width: number
}

export interface ArchifyArchitecture {
  schema_version: 1
  diagram_type: 'architecture'
  meta: { title: string; subtitle?: string; output: string; quality_profile: 'standard' | 'showcase' }
  layout: { mode: 'grid'; cols: number }
  components: ArchComponent[]
  connections: ArchConnection[]
}

/** archify's showcase profile is for overviews of about a dozen components. */
const SHOWCASE_COMPONENTS = 12

export function archifyArchitecture(graph: Graph, options: { project: string }): ArchifyArchitecture {
  const shape = shapeOf(graph)
  if (!shape.blocks.length) throw new Error('no production code found to draw')
  // only production code joins a block: a test importing lib is no dependency of the system
  const known = new Set(shape.blocks.map(b => b.path))
  const files = graph.nodes.filter(n => n.kind === 'file' && n.path && !n.tags?.includes('test'))
  const blockOfFile = new Map(files.map(f => [f.id, shape.blockOf(f.path!)]).filter((e): e is [string, string] => !!e[1] && known.has(e[1])))
  const databases = graph.meta.databases ?? []
  const links = weigh(graph, blockOfFile, tableOwners(graph))
  const rows = orderRows([...layerRows(graph, shape.blocks, blockOfFile, shape.layers), ...(databases.length ? [databases.map(d => d.id)] : [])], id => neighborsOf(links, id))
  // an architecture grid takes at most 12 columns (ERD and class grids 13)
  const { cells, cols } = gridCells(rows, GRID_MAX)
  const ids = new Ids()
  const components: ArchComponent[] = [
    ...shape.blocks.map(b => blockComponent(b, ids, cells.get(b.path)!)),
    ...databases.map(d => ({
      id: ids.of(d.id),
      type: 'database' as const,
      label: d.name,
      sublabel: `${engineLabel(d.engine)} · ${d.tables.length} ${d.tables.length === 1 ? 'table' : 'tables'}`,
      row: cells.get(d.id)![0],
      col: cells.get(d.id)![1],
    })),
  ]
  // the count goes into the width, not a label on every line: labels on a dense map would crowd it
  const connections = [...links].map(([key, count]) => {
    const [from, to] = key.split('\u0000')
    return { id: ids.of(`${from}__${to}`), from: ids.of(from), to: ids.of(to), width: widthOf(count) }
  })
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: `${options.project}: building blocks`,
      subtitle: `${shape.blocks.length} blocks${databases.length ? ` and ${databases.length} ${databases.length === 1 ? 'database' : 'databases'}` : ''}, read by archrift from the code`,
      output: outputName(options.project, 'architecture'),
      quality_profile: components.length > SHOWCASE_COMPONENTS ? 'standard' : 'showcase',
    },
    layout: { mode: 'grid', cols },
    components,
    connections,
  }
}

function blockComponent(b: Block, ids: Ids, [row, col]: [number, number]): ArchComponent {
  const top = b.match.endsWith('/*.*')
  return {
    id: ids.of(b.path),
    type: b.ui ? 'frontend' : 'backend',
    label: `${b.path.split('/').pop()}${top ? ' (top files)' : ''}`,
    sublabel: `${b.path} · ${b.files} ${b.files === 1 ? 'file' : 'files'}`,
    row,
    col,
  }
}

/** Rows of blocks top to bottom: the config's layers (each block where most of its files are), else the found ones, else one row. */
function layerRows(graph: Graph, blocks: readonly Block[], blockOfFile: Map<string, string | undefined>, found: { blocks: string[] }[]): string[][] {
  const configured = graph.meta.layers ?? []
  if (!configured.length) return found.length ? found.map(l => l.blocks) : [blocks.map(b => b.path)]
  const votes = new Map<string, Map<string, number>>()
  for (const n of graph.nodes) {
    const block = blockOfFile.get(n.id)
    const layer = layerTag(n)
    if (!block || !layer) continue
    const v = votes.get(block) ?? new Map<string, number>()
    v.set(layer, (v.get(layer) ?? 0) + 1)
    votes.set(block, v)
  }
  const layerOf = (b: string) => [...(votes.get(b) ?? [])].sort((x, y) => y[1] - x[1])[0]?.[0]
  const rows = configured.map(l => blocks.filter(b => layerOf(b.path) === l).map(b => b.path))
  const unlayered = blocks.filter(b => !configured.includes(layerOf(b.path) ?? '')).map(b => b.path)
  return [...rows, unlayered].filter(r => r.length)
}

const layerTag = (n: GraphNode) => n.tags?.find(t => t.startsWith('layer:'))?.slice(6)

/** Which database each table node belongs to. */
function tableOwners(graph: Graph): Map<string, string> {
  const owner = new Map<string, string>()
  for (const d of graph.meta.databases ?? []) for (const t of d.tables) for (const n of t.nodes) owner.set(n, d.id)
  return owner
}

/** Runtime imports between blocks, and queries from a block into a database, counted per pair. */
function weigh(graph: Graph, blockOfFile: Map<string, string | undefined>, owners: Map<string, string>): Map<string, number> {
  const fileOf = fileFinder(graph)
  const links = new Map<string, number>()
  const add = (a: string | undefined, b: string | undefined) => {
    if (!a || !b || a === b || a === '(root)' || b === '(root)') return
    const key = `${a}\u0000${b}`
    links.set(key, (links.get(key) ?? 0) + 1)
  }
  for (const e of graph.edges) {
    if (isRuntimeImport(e)) add(blockOfFile.get(e.source), blockOfFile.get(e.target))
    else if (e.kind === 'queries' && owners.has(e.target)) add(blockOfFile.get(fileOf(e.source) ?? ''), owners.get(e.target))
  }
  return links
}

/** The file a node lives in (a symbol's or member's parent chain up to its file). */
function fileFinder(graph: Graph): (id: string) => string | undefined {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  return id => {
    let n = byId.get(id)
    while (n && n.kind !== 'file') n = n.parent ? byId.get(n.parent) : undefined
    return n?.id
  }
}

function neighborsOf(links: Map<string, number>, id: string): string[] {
  const out: string[] = []
  for (const key of links.keys()) {
    const [a, b] = key.split('\u0000')
    if (a === id) out.push(b)
    else if (b === id) out.push(a)
  }
  return out
}

/** Thicker for more imports: 1 at one, about 4 at a thousand. */
const widthOf = (count: number) => Math.round((1 + Math.log10(count)) * 10) / 10
