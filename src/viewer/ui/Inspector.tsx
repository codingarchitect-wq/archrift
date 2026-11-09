// The inspector: properties of the selection and its references,
// each of which can be followed. Symbols list their references grouped by
// kind, with the exact places they occur.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from 'zustand'
import { fileIdOf } from '../../core/ids.ts'
import { isRuntimeImport } from '../../core/model.ts'
import type { GraphNode } from '../../core/model.ts'
import type { EdgeWithSites, FileDetails } from '../../server/views.ts'
import { SUBKIND_COLORS } from '../colors.ts'
import { actions, describedOf, findNode, store } from '../store.ts'
import type { Link, World } from '../world.ts'
import { editorUrl } from './runtime.ts'
import { ChangedSection, ChangesView, CoChanges, CycleView, DirectoryInsights, DocsSection, FileRules, FocusBar, GitHistory, GroupView, ViolationView } from './Tools.tsx'
import { ANSWER_ID, CHANGES_ID } from '../store.ts'
import { AnswerView, AskAbout } from './Ask.tsx'
import { isGroupId } from '../groups.ts'

const KIND_ORDER = [
  'rpc-call',
  'http-call',
  'publishes',
  'subscribes',
  'queries',
  'calls',
  'renders',
  'instantiates',
  'provides',
  'consumes',
  'navigates',
  'references',
  'type-ref',
  'extends',
  'implements',
  'overrides',
  'imports',
  're-exports',
  'mocks',
  'spawns-worker',
]
const ROW_LIMIT = 40

/** The selection doesn't exist at this point on the timeline. */
function NotThen({ id }: { id: string }) {
  const s = store.getState()
  const when = s.snapshots.find(x => x.sha === s.options.at)
  return (
    <aside className="panel inspector" aria-label="Inspector">
      <header>
        <h2>{displayName(id, s.now?.node(id))}</h2>
        <p className="path">
          Not there yet on {when ? new Date(when.time * 1000).toISOString().slice(0, 10) : 'this snapshot'}. Move the timeline on, or close it, to see it.
        </p>
      </header>
    </aside>
  )
}

export function Inspector() {
  const selected = useStore(store, s => s.selected)
  const at = useStore(store, s => (s.options.timeline ? s.options.at : ''))
  const node = useStore(store, s => (s.selected ? findNode(s, s.selected) : undefined))
  if (selected?.startsWith('cycle:'))
    return (
      <aside className="panel inspector" aria-label="Inspector">
        <CycleView id={selected} />
      </aside>
    )
  if (selected?.startsWith('violation:'))
    return (
      <aside className="panel inspector" aria-label="Inspector">
        <ViolationView id={selected} />
      </aside>
    )
  if (selected === ANSWER_ID)
    return (
      <aside className="panel inspector" aria-label="Inspector">
        <AnswerView />
      </aside>
    )
  if (selected === CHANGES_ID)
    return (
      <aside className="panel inspector" aria-label="Inspector">
        <ChangesView />
      </aside>
    )
  if (selected && isGroupId(selected))
    return (
      <aside className="panel inspector" aria-label="Inspector">
        <GroupView id={selected} />
      </aside>
    )
  if (!node) return selected && at ? <NotThen id={selected} /> : null
  return (
    <aside className="panel inspector" aria-label="Inspector">
      {node.kind === 'directory' && <DirectoryView node={node} />}
      {node.kind === 'file' && <FileView node={node} />}
      {(node.kind === 'symbol' || node.kind === 'member') && <SymbolView node={node} />}
      {node.kind === 'external' && <ExternalView node={node} />}
    </aside>
  )
}

function Header({ node, sub }: { node: GraphNode; sub?: ReactNode }) {
  return (
    <header>
      <div className="kind-line">
        <span className={`badge kind-${node.kind}`}>{node.subkind ?? node.kind}</span>
        {node.exported && <span className="badge">exported</span>}
        {(node.tags ?? []).map(t => (
          <span key={t} className={`badge tag-${t}`}>
            {t}
          </span>
        ))}
      </div>
      <h2>{node.name}</h2>
      {sub}
      <Described id={node.id} />
      <AskAbout id={node.id} />
    </header>
  )
}

/** What was written about it (`archrift describe`): the name a person gives it, and what it is for. */
export function Described({ id }: { id: string }) {
  const d = useStore(store, s => describedOf(s, id))
  if (!d) return null
  return (
    <div className={`described${d.stale ? ' stale' : ''}`} aria-label="Description">
      {d.name && <strong>{d.name}</strong>}
      <p>{d.summary}</p>
      {d.ownFiles && <p className="dim">Written for the files right in this folder, not the folders below it.</p>}
      {d.stale && (
        <p className="stale-note" title="Its exports or signature changed after this was written. `archrift describe set <path>` marks it as still fitting; `archrift describe todo` lists every stale one.">
          written before its code's surface changed: check it still fits
        </p>
      )}
    </div>
  )
}

function Metrics({ node, keys }: { node: GraphNode; keys: [string, string][] }) {
  const m = node.metrics ?? {}
  const shown = keys.filter(([k]) => m[k] !== undefined)
  if (!shown.length) return null
  return (
    <dl className="metrics">
      {shown.map(([k, label]) => (
        <div key={k}>
          <dt>{label}</dt>
          <dd>{Number.isInteger(m[k]) ? m[k].toLocaleString('en-US') : m[k].toFixed(2)}</dd>
        </div>
      ))}
    </dl>
  )
}

function Actions({ path, line = 1, col = 1, end }: { path: string; line?: number; col?: number; end?: number }) {
  const root = useStore(store, s => s.info?.root ?? '')
  const mounts = useStore(store, s => s.info?.mounts)
  const title = end ? `${path}:${line}–${end}` : path
  return (
    <div className="actions">
      {root && (
        <a className="button" href={editorUrl(root, path, line, col, mounts)}>
          Open in VS Code
        </a>
      )}
      <button
        onClick={() =>
          actions.openSource({ path, start: Math.max(1, line - 3), end: (end ?? line + 60) + 3, focus: end ? [line, end] : undefined, title })
        }
      >
        View source
      </button>
    </div>
  )
}

// ── directory ──────────────────────────────────────────────────────────────

function DirectoryView({ node }: { node: GraphNode }) {
  const world = useStore(store, s => s.world!)
  const children = (world.index.children.get(node.id) ?? [])
    .map(id => world.node(id)!)
    .sort((a, b) => (b.metrics?.loc ?? 0) - (a.metrics?.loc ?? 0))
  return (
    <>
      <Header node={node} sub={<p className="path">{node.path || '/'}</p>} />
      <Metrics node={node} keys={[['files', 'files'], ['loc', 'lines']]} />
      <FocusBar node={node} />
      <DirectoryInsights node={node} />
      <DocsSection node={node} />
      <Section title={`Contents (${children.length})`}>
        <ul className="rows">
          {children.slice(0, 100).map(c => (
            <li key={c.id}>
              <button className="row" onClick={() => actions.select(c.id)}>
                <span className="name">
                  {c.kind === 'directory' ? '▸ ' : ''}
                  {c.name}
                </span>
                <span className="dim">{(c.metrics?.loc ?? 0).toLocaleString('en-US')} lines</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}

// ── file ───────────────────────────────────────────────────────────────────

function FileView({ node }: { node: GraphNode }) {
  const details = useStore(store, s => s.details[node.id])
  const target = useStore(store, s => s.options.target)
  const world = useStore(store, s => s.world!)
  const links = world.links(node.id, target)
  const symbols = details?.symbols.filter(s => s.kind === 'symbol') ?? []
  return (
    <>
      <Header node={node} sub={<p className="path">{node.path}</p>} />
      <Metrics
        node={node}
        keys={[
          ['loc', 'lines'],
          ['complexity', 'complexity'],
          ['fanIn', 'fan-in'],
          ['fanOut', 'fan-out'],
          ['instability', 'instability'],
          ['externalDeps', 'packages'],
          ['testReach', 'tests reach it'],
        ]}
      />
      <GitHistory node={node} />
      <Actions path={node.path!} />
      <ChangedSection node={node} />
      <FocusBar node={node} />
      <FileRules node={node} />
      <TestedBy node={node} />
      <DocsSection node={node} />
      <CoChanges node={node} />
      <Section title={`Symbols (${symbols.length})`}>
        {!details && <p className="dim">Loading…</p>}
        <ul className="rows">
          {symbols.map(sym => (
            <li key={sym.id}>
              <button className="row" onClick={() => actions.select(sym.id)}>
                <span className="name">
                  <i className="swatch" style={{ background: SUBKIND_COLORS[sym.subkind ?? ''] }} />
                  {sym.name}
                </span>
                <span className="dim">
                  {sym.subkind} · {sym.metrics?.loc ?? 0}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <LinkList title="Uses" links={links.out} from={node.id} dir="out" />
      <LinkList title="Used by" links={links.in} from={node.id} dir="in" />
    </>
  )
}

function LinkList({ title, links, from, dir }: { title: string; links: Link[]; from: string; dir: 'out' | 'in' }) {
  const [all, setAll] = useState(false)
  const s = store.getState()
  if (!links.length) return null
  const shown = all ? links : links.slice(0, ROW_LIMIT)
  return (
    <Section title={`${title} (${links.length})`} className={dir}>
      <ul className="rows">
        {shown.map(l => {
          const n = findNode(s, l.other)
          return (
            <li key={l.other}>
              <button className="row stacked" onClick={() => actions.select(l.other, { from })} title={n?.path ?? n?.name}>
                <span className="name">{n?.name ?? l.other}</span>
                <span className="dim">
                  {n?.path ? `${n.path.slice(0, n.path.lastIndexOf('/') + 1)} · ` : ''}
                  {kindSummary(l.kinds)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {links.length > shown.length && (
        <button className="more" onClick={() => setAll(true)}>
          Show all {links.length}
        </button>
      )}
    </Section>
  )
}

/** Which tests reach a file: importing or mocking it directly, or through other files. */
function TestedBy({ node }: { node: GraphNode }) {
  const world = useStore(store, s => s.world!)
  const [all, setAll] = useState(false)
  if (node.tags?.includes('test')) return null
  const reaching = testsReaching(world, node.id)
  if (!reaching.length && !node.metrics?.testReach) return null
  const shown = all ? reaching : reaching.slice(0, 12)
  return (
    <Section title={`Tested by (${reaching.length})`}>
      {!reaching.length && <p className="dim">No test reaches it.</p>}
      <ul className="rows">
        {shown.map(r => (
          <li key={r.id}>
            <button className="row" onClick={() => actions.select(r.id)} title={world.node(r.id)?.path}>
              <span className="name">{world.node(r.id)?.name}</span>
              <span className="dim">{r.mocks ? 'mocks it' : r.depth === 1 ? 'imports it' : `through ${r.depth - 1} file${r.depth > 2 ? 's' : ''}`}</span>
            </button>
          </li>
        ))}
      </ul>
      {reaching.length > shown.length && (
        <button className="more" onClick={() => setAll(true)}>
          Show all {reaching.length}
        </button>
      )}
    </Section>
  )
}


/** Tests that import (or mock) a file, directly or through other files, nearest first. */
function testsReaching(world: World, fileId: string) {
  const found: { id: string; depth: number; mocks: boolean }[] = []
  const seen = new Set([fileId])
  let frontier = [fileId]
  for (let depth = 1; frontier.length; depth++) {
    const next: string[] = []
    for (const id of frontier)
      for (const e of world.index.in(id)) {
        if (seen.has(e.source) || !e.source.startsWith('f:')) continue
        const importing = isRuntimeImport(e) || (depth === 1 && e.kind === 'mocks')
        if (!importing) continue
        seen.add(e.source)
        if (world.node(e.source)?.tags?.includes('test')) found.push({ id: e.source, depth, mocks: e.kind === 'mocks' })
        else next.push(e.source)
      }
    frontier = next
  }
  return found
}

// ── symbol / member ────────────────────────────────────────────────────────

interface RefRow {
  /** The other end, folded to its top-level symbol when it is a member. */
  other: string
  kind: string
  count: number
  /** Members (on either side) the references run through. */
  via: Set<string>
  edges: EdgeWithSites[]
}

function SymbolView({ node }: { node: GraphNode }) {
  const file = fileIdOf(node.id)!
  const details = useStore(store, s => s.details[file])
  const target = useStore(store, s => s.options.target)
  if (!details) return <Header node={node} sub={<p className="dim">Loading…</p>} />
  const members = details.symbols.filter(m => m.parent === node.id)
  const parent = node.kind === 'member' ? details.symbols.find(p => p.id === node.parent) : undefined
  const out = referenceRows(details, node, members, target, 'out')
  const inc = referenceRows(details, node, members, target, 'in')
  const [line, col, endLine] = node.range ?? [1, 1, 1]
  return (
    <>
      <Header
        node={node}
        sub={
          <p className="path">
            <button className="link" onClick={() => actions.select(file)}>
              {node.path}
            </button>
            :{line}
          </p>
        }
      />
      {node.signature && <pre className="signature">{node.signature}</pre>}
      <Metrics
        node={node}
        keys={[
          ['loc', 'lines'],
          ['complexity', 'complexity'],
          ['fanIn', 'fan-in'],
          ['fanOut', 'fan-out'],
        ]}
      />
      <Actions path={node.path!} line={line} col={col} end={endLine} />
      <DocsSection node={node} />
      {parent && (
        <Section title="Member of">
          <button className="row" onClick={() => actions.select(parent.id)}>
            <span className="name">{parent.name}</span>
            <span className="dim">{parent.subkind}</span>
          </button>
        </Section>
      )}
      <RefList title="References" rows={out} from={node.id} dir="out" />
      <RefList title="Referenced by" rows={inc} from={node.id} dir="in" />
      {members.length > 0 && <Members members={members} />}
    </>
  )
}

function Members({ members }: { members: GraphNode[] }) {
  const [open, setOpen] = useState(members.length <= 12)
  return (
    <Section title={`Members (${members.length})`}>
      {!open && (
        <button className="more" onClick={() => setOpen(true)}>
          Show {members.length} members
        </button>
      )}
      {open && (
        <ul className="rows">
          {members.map(m => (
            <li key={m.id}>
              <button className="row" onClick={() => actions.select(m.id)}>
                <span className="name">{m.name}</span>
                <span className="dim">
                  {m.subkind}
                  {m.metrics?.fanIn ? ` · used ${m.metrics.fanIn}×` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** A symbol's references (a class's include its members'), one row per other end and kind. */
function referenceRows(details: FileDetails, node: GraphNode, members: GraphNode[], target: string, dir: 'out' | 'in') {
  const group = new Set([node.id, ...members.map(m => m.id)])
  const known = new Map([...details.symbols, ...details.endpoints].map(n => [n.id, n]))
  const rows = new Map<string, RefRow>()
  for (const e of details.edges) {
    if (!e.targets.includes(target)) continue
    const own = dir === 'out' ? e.source : e.target
    const end = dir === 'out' ? e.target : e.source
    if (!group.has(own) || group.has(end)) continue
    const endNode = known.get(end)
    // fold members into their class (160 `implements` rows would say nothing), except those
    // that are destinations in their own right: procedures, tables, routers
    const fold = endNode?.kind === 'member' && endNode.parent && !['procedure', 'table', 'router'].includes(endNode.subkind ?? '')
    const other = fold ? endNode!.parent! : end
    const key = `${e.kind}\u0000${other}`
    const row = rows.get(key) ?? { other, kind: e.kind, count: 0, via: new Set<string>(), edges: [] }
    row.count += e.count
    if (own !== node.id) row.via.add(own.slice(own.lastIndexOf('.') + 1))
    else if (other !== end) row.via.add(end.slice(end.lastIndexOf('.') + 1))
    row.edges.push(e)
    rows.set(key, row)
  }
  const byKind = new Map<string, RefRow[]>()
  for (const r of rows.values()) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r])
  for (const list of byKind.values()) list.sort((a, b) => b.count - a.count || (a.other < b.other ? -1 : 1))
  return [...byKind.entries()].sort((a, b) => kindRank(a[0]) - kindRank(b[0]))
}

function RefList({ title, rows, from, dir }: { title: string; rows: [string, RefRow[]][]; from: string; dir: 'out' | 'in' }) {
  const count = rows.reduce((a, [, r]) => a + r.length, 0)
  if (!count) return null
  return (
    <Section title={`${title} (${count})`} className={dir}>
      {rows.map(([kind, list]) => (
        <RefGroup key={kind} kind={kind} rows={list} from={from} />
      ))}
    </Section>
  )
}

function RefGroup({ kind, rows, from }: { kind: string; rows: RefRow[]; from: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, ROW_LIMIT)
  return (
    <div className="ref-group">
      <h4>
        {kind} <span className="dim">{rows.length}</span>
      </h4>
      <ul className="rows">
        {shown.map(r => (
          <RefItem key={r.other} row={r} from={from} />
        ))}
      </ul>
      {rows.length > shown.length && (
        <button className="more" onClick={() => setAll(true)}>
          Show all {rows.length}
        </button>
      )}
    </div>
  )
}

function RefItem({ row, from }: { row: RefRow; from: string }) {
  const [open, setOpen] = useState(false)
  const other = useStore(store, s => findNode(s, row.other))
  const label = displayName(row.other, other)
  const sites = row.edges.flatMap(e => {
    const path = fileIdOf(e.source)?.slice(2) ?? ''
    const out: { path: string; line: number; col: number }[] = []
    for (let i = 0; i < e.sites.length; i += 2) out.push({ path, line: e.sites[i], col: e.sites[i + 1] })
    return out
  })
  return (
    <li>
      <div className="ref-row">
        <button className="twisty" aria-label={open ? 'Hide places' : 'Show places'} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <button className="row stacked" onClick={() => actions.select(row.other, { from })} title={other?.path}>
          <span className="name">
            {label} <span className="dim">×{row.count}</span>
          </span>
          {row.via.size > 0 && (
            <span className="dim">
              via {[...row.via].slice(0, 4).join(', ')}
              {row.via.size > 4 ? ` +${row.via.size - 4}` : ''}
            </span>
          )}
        </button>
      </div>
      {open && (
        <ul className="sites">
          {sites.slice(0, 30).map(site => (
            <li key={`${site.path}:${site.line}:${site.col}`}>
              <button
                className="link"
                onClick={() =>
                  actions.openSource({ path: site.path, start: Math.max(1, site.line - 6), end: site.line + 6, focus: [site.line, site.line], title: `${site.path}:${site.line}` })
                }
              >
                {site.path.slice(site.path.lastIndexOf('/') + 1)}:{site.line}
              </button>
            </li>
          ))}
          {sites.length > 30 && <li className="dim">…{sites.length - 30} more</li>}
        </ul>
      )}
    </li>
  )
}

// ── external ───────────────────────────────────────────────────────────────

/** What an outside node is, said in a few words. */
function externalKind(node: GraphNode): string {
  const t = node.tags ?? []
  if (t.includes('topic')) return `${t.includes('kafka') ? 'Kafka topic' : 'message topic'}${node.signature ? ` · ${node.signature}` : ''}`
  if (t.includes('database')) return `${node.signature ?? 'database'}`
  if (t.includes('npm')) return 'npm package'
  if (t.includes('node')) return 'Node.js builtin'
  if (t.includes('jvm')) return 'JVM package'
  if (t.includes('go')) return 'Go package'
  return 'outside the analyzed code'
}

function ExternalView({ node }: { node: GraphNode }) {
  const world = useStore(store, s => s.world!)
  const target = useStore(store, s => s.options.target)
  const links = world.links(node.id, target)
  // a topic or a database: who sends, who listens, who queries, who creates it (the only references to one)
  const by = (kind: string) => links.in.filter(l => l.kinds.has(kind))
  const infra = node.tags?.includes('infra')
  return (
    <>
      <Header node={node} sub={<p className="path">{externalKind(node)}</p>} />
      <FocusBar node={node} />
      <FileRules node={node} />
      {infra ? (
        <>
          <LinkList title="Published by" links={by('publishes')} from={node.id} dir="in" />
          <LinkList title="Subscribed by" links={by('subscribes')} from={node.id} dir="in" />
          <LinkList title="Queried by" links={by('queries')} from={node.id} dir="in" />
          <LinkList title="Declared by" links={by('references')} from={node.id} dir="in" />
        </>
      ) : (
        <LinkList title="Used by" links={links.in} from={node.id} dir="in" />
      )}
    </>
  )
}

// ── bits ───────────────────────────────────────────────────────────────────

function Section({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={className}>
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function kindSummary(kinds: Map<string, number>) {
  return [...kinds.entries()]
    .sort((a, b) => kindRank(a[0]) - kindRank(b[0]))
    .map(([k, n]) => (k === 'imports' || k === 're-exports' ? k : `${k} ${n}`))
    .join(' · ')
}

const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k)
  return i < 0 ? KIND_ORDER.length : i
}

/** `Class.method` for members, the name otherwise. */
export function displayName(id: string, node: GraphNode | undefined) {
  if (id.startsWith('s:')) return id.slice(id.indexOf('#') + 1)
  return node?.name ?? id.replace(/^[a-z]:(npm:|node:|excluded:)?/, '')
}
