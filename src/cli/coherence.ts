// `archrift coherence` (docs/COHERENCE.md): how many ways the code does each
// job, as text or JSON. Blocks are the config's groups, else folders; `query`
// and `diff` find them the same way.
import { GraphIndex } from '../core/graph-index.ts'
import { coherenceModel, fileLinks, folderBlocks, recentSince } from '../core/coherence.ts'
import type { CoherenceModel, ConcernStats } from '../core/coherence.ts'
import type { Graph, GraphNode } from '../core/model.ts'

/** Stragglers are listed by path up to this many. */
const LIST = 12

/**
 * Each path's block: its group when the project has groups (a path no file has yet: `groupOf`,
 * from the config), else the folder the production code splits in (tests lie beside it, a block
 * of their own).
 */
export function blockFinder(graph: Graph, groupOf?: (path: string) => string | undefined): (path: string) => string | undefined {
  const files = graph.nodes.filter(n => n.kind === 'file')
  if (files.some(f => f.tags?.some(t => t.startsWith('group:')))) {
    const group = new Map(files.map(f => [f.path ?? f.id, f.tags?.find(t => t.startsWith('group:'))?.slice(6)]))
    return p => (group.has(p) ? group.get(p) : groupOf?.(p))
  }
  return folderBlocks(files.filter(f => !f.tags?.includes('test')).map(f => f.path ?? f.id))
}

export function coherenceOf(graph: Graph, blockOf = blockFinder(graph)): CoherenceModel {
  const index = new GraphIndex(graph)
  const files = graph.nodes.filter(n => n.kind === 'file')
  return coherenceModel({ files, concerns: graph.meta.concerns ?? [], links: fileLinks(graph, index), blockOf: (f: GraphNode) => blockOf(f.path ?? f.id), since: recentSince(files) })
}

export function coherenceJson(graph: Graph, m: CoherenceModel) {
  return {
    project: graph.meta.name,
    totals: m.totals,
    since: m.since,
    concerns: m.concerns.map(c => ({
      id: c.concern.id,
      label: c.concern.label,
      stack: c.concern.stack,
      about: c.concern.about,
      ...(c.concern.accepted ? { accepted: c.concern.accepted } : {}),
      kind: c.kind,
      users: c.users,
      ways: c.ways,
      coherence: round(c.coherence),
      local: round(c.local),
      effective: round(c.effective),
      paradigms: c.paradigms.map(p => ({ id: p.id, label: p.label, legacy: p.legacy, files: p.files.length, loc: p.loc, recent: p.added.length })),
      stragglers: c.stragglers.map(pathOf),
      strays: c.strays.map(pathOf),
      mixed: c.mixed.map(pathOf),
      transitions: c.transitions.length,
      links: c.links,
      blocks: c.blocks,
      recent: c.fresh.length,
      recentStrays: c.freshStrays.map(pathOf),
      trend: c.trend,
      ...(c.migration ? { migration: { ...c.migration, done: round(c.migration.done), left: c.migration.left.map(pathOf) } } : {}),
      ...(c.newest ? { newest: c.newest } : {}),
    })),
    blocks: m.blocks,
  }
}

export function coherenceText(graph: Graph, m: CoherenceModel): string {
  const t = m.totals
  const lines = [
    `archrift coherence ${graph.meta.name}: ${t.concerns} concerns · ${t.coherent} done one way · ${t.perBlock} one way per block · ${t.decoherent} mixed${t.accepted ? ` · ${t.accepted} accepted` : ''} · ${n(t.strays)} of ${n(t.users)} files off their block's main way`,
  ]
  if (!t.concerns) return `${lines[0]}\n  (no file uses a concern of the catalog; see docs/COHERENCE.md)\n`
  if (m.since !== undefined) lines.push(`recent work: files first committed after ${day(m.since)} (the newest fifth)`)
  const mixed = m.concerns.filter(c => c.kind === 'mixed' && !c.concern.accepted)
  const perBlock = m.concerns.filter(c => c.kind === 'per-block' && !c.concern.accepted)
  const accepted = m.concerns.filter(c => c.kind !== 'one' && c.concern.accepted)
  const one = m.concerns.filter(c => c.kind === 'one')
  if (mixed.length) lines.push('', 'Mixed: blocks doing one job several ways, least coherent first')
  for (const c of mixed) lines.push(...concernLines(c, m))
  if (perBlock.length) lines.push('', 'One way per block: the blocks differ, none mixes')
  for (const c of perBlock) lines.push(`  ${title(c)}: ${ways(c)}`, `    ${c.blocks.map(b => `${b.block} ${labelOf(c, b.paradigms[0])}`).join(' · ')}`)
  if (accepted.length) lines.push('', 'Several ways, accepted')
  for (const c of accepted) lines.push(`  ${title(c)}: ${ways(c)}`, `    ${c.concern.accepted}`)
  if (one.length) lines.push('', 'One way')
  for (const c of one) lines.push(`  ${title(c)}: ${c.main.label}${c.main.legacy ? ' (legacy)' : ''}, ${n(c.users)} file${c.users === 1 ? '' : 's'}`)
  const loaded = m.blocks.filter(b => b.load > 0)
  if (loaded.length) {
    lines.push('', 'Blocks by load: extra ways to learn (ways beyond one, summed over the concerns a block mixes)')
    const label = new Map(m.concerns.map(c => [c.concern.id, title(c)]))
    for (const b of loaded) lines.push(`  ${b.block.padEnd(24)} ${String(b.load).padStart(3)}  ${b.concerns.map(c => `${label.get(c.id)} ${c.ways}`).join(' · ')}`)
  }
  return `${lines.join('\n')}\n`
}

function concernLines(c: ConcernStats, m: CoherenceModel): string[] {
  const out = [`  ${title(c)}: ${c.concern.about}`, `    ${ways(c)}`]
  const facts = [`coherence ${pct(c.local)} within blocks, ${pct(c.coherence)} overall`, `off their block's main way ${n(c.strays.length)}`, `on several ways ${n(c.mixed.length)}`]
  if (c.links) facts.push(`transitions ${n(c.transitions.length)} of ${n(c.links)} links`)
  out.push(`    ${facts.join(' · ')}`)
  if (c.migration) out.push(`    migration ${c.migration.from.map(id => labelOf(c, id)).join(', ')} → ${labelOf(c, c.migration.to)}: ${pct(c.migration.done)} done, ${n(c.migration.left.length)} file${c.migration.left.length === 1 ? '' : 's'} left`)
  else if (c.newest) out.push(`    newest way (youngest files): ${labelOf(c, c.newest)}`)
  if (m.since !== undefined) {
    const fresh = c.paradigms.filter(p => p.added.length).map(p => `${p.label} ${p.added.length}`)
    out.push(`    recent work: ${fresh.length ? `${fresh.join(' · ')}; ${c.freshStrays.length ? `${n(c.freshStrays.length)} off their block's main way (spreading)` : 'all on their block\'s main way (converging)'}` : 'no new files'}`)
  }
  const mixing = c.blocks.filter(b => b.paradigms.length > 1)
  out.push(`    mixed in ${mixing.length} of ${c.blocks.length} blocks: ${mixing.slice(0, 5).map(b => `${b.block} (${b.paradigms.map(id => labelOf(c, id)).join(', ')})`).join('; ')}${mixing.length > 5 ? ' …' : ''}`)
  const off = c.migration?.left ?? c.strays
  if (off.length && off.length <= LIST) out.push(...off.map(id => `      ${pathOf(id)}  ${(m.ways.get(id)?.get(c.concern.id) ?? []).map(w => labelOf(c, w)).join(', ')}`))
  return out
}

const title = (c: ConcernStats) => `${c.concern.stack} · ${c.concern.label}`
const labelOf = (c: ConcernStats, id: string) => c.paradigms.find(p => p.id === id)?.label ?? id
const ways = (c: ConcernStats) => c.paradigms.map(p => `${p.label}${p.legacy ? ' (legacy)' : ''} ${n(p.files.length)}`).join(' · ')
const pathOf = (id: string) => (id.startsWith('f:') ? id.slice(2) : id)
const pct = (x: number) => `${Math.round(x * 100)} %`
const n = (x: number) => x.toLocaleString('en-US')
const round = (x: number) => Math.round(x * 1000) / 1000
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
