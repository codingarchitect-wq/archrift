// Runtime view, part 1: a scenario. From a page or an API route, the calls
// its code makes, in the order they appear in the source, followed into the
// files they lead to (symbol-level edges, loaded per file on demand): calls,
// renders, `new`, a tRPC or HTTP call across the network to its procedure or
// handler, a query of a Prisma model, a Dexie table or an entity, a message
// published to a topic (a Kafka topic, an NgRx action) and delivered to each
// code that subscribes to it. A call to an interface method becomes an `alt`
// over the classes that implement it. The walk keeps what tells the
// story: the ways down to the data first (each kind of way once in full),
// then what else the code does, up to a few dozen messages. Pure and
// deterministic: the files come from an injected loader.
import { fileIdOf } from '../../../core/ids.ts'
import type { GraphNode } from '../../../core/model.ts'
import type { FileDetails } from '../../api.ts'

export type MessageKind = 'open' | 'call' | 'self' | 'render' | 'new' | 'rpc' | 'query' | 'publish' | 'deliver'

export interface Participant {
  /** The file it stands for (also what selecting it selects); the actor has its entry's; a group's id when grouped. */
  id: string
  kind: 'actor' | 'file' | 'interface' | 'database' | 'topic'
  name: string
  side: 'client' | 'server'
  /** Grouped (grouped.ts): the files it stands for. */
  members?: string[]
}

export interface Message {
  from: number
  to: number
  kind: MessageKind
  label: string
  /** What selecting the message selects: the callee (a symbol), or the entry file for the opening one. */
  target: string
  /** The caller (a symbol), or '' for the opening message. */
  source: string
  /** The callee's activation depth: the entry's is 1. */
  depth: number
  /** Made this many times in a row (or at this many places). */
  times: number
  /** The innermost alt it's in: the fragment's index and the operand. */
  fragment?: { index: number; operand: number }
  /** Calls made under this one that the diagram leaves out. */
  hidden: number
  /** Goes on the way a message above already showed in full: not followed again. */
  collapsed: boolean
}

export interface Fragment {
  kind: 'alt'
  /** Each operand: its guard (the implementing class) and the messages in it. */
  operands: { guard: string; first: number; last: number }[]
  /** The depth of the message that dispatches (the call on the interface). */
  depth: number
}

export interface Scenario {
  entry: string
  name: string
  participants: Participant[]
  messages: Message[]
  fragments: Fragment[]
  /** Messages the walk found but left out (beyond the cap, or too deep). */
  left: number
  /** Files read for it. */
  files: number
}

export interface WalkInput {
  entry: GraphNode
  /** The file's symbols and edges (cached by the caller); undefined when it can't be read. */
  details(file: string): Promise<FileDetails | undefined>
  /** One line of a file's source (for what a query does: `findMany`); optional. */
  line?(path: string, line: number): Promise<string | undefined>
  /** A file node of the overview (for its name, tags and metrics). */
  file(id: string): GraphNode | undefined
  limits?: Partial<Limits>
}

export interface Limits {
  /** Activation depth followed. */
  depth: number
  /** Messages shown. */
  messages: number
  /** Lifelines shown (the actor and the databases count). */
  participants: number
  /** Files read. */
  files: number
  /** Calls explored in all. */
  steps: number
}

export const LIMITS: Limits = { depth: 6, messages: 24, participants: 12, files: 160, steps: 4000 }

/** Calls under one caller going a way already shown, at most. */
const MAX_AGAIN = 2
/** A leaf call to something this widely used is a utility, not part of the story. */
const UTILITY_FAN_IN = 10
const HANDLERS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
/** Symbols a call can't sensibly lead into: values, types. */
const NOT_CALLABLE = new Set(['variable', 'type', 'interface', 'enum', 'namespace', 'property', 'field', 'relation', 'router'])
const WALKED = new Set(['calls', 'renders', 'instantiates', 'rpc-call', 'http-call', 'queries', 'publishes'])
/** Members a class runs as it comes into play: its constructor and lifecycle hooks. */
const LIFECYCLE = new Set(['constructor', 'ngOnInit', 'ngOnChanges', 'ngAfterViewInit', 'ngAfterContentInit', 'componentDidMount', 'init', 'onInit', 'postConstruct'])
/** A message to a topic reaches at most this many subscribers in the diagram. */
const MAX_SUBSCRIBERS = 6
/** The lifeline a node is drawn on: its file, or itself for an outside node (a topic). */
const laneOf = (id: string) => fileIdOf(id) ?? id

/** A call found in the code, before choosing what to show. */
interface Step {
  kind: MessageKind | 'alt'
  callee: string
  caller: string
  label: string
  /** For a query, where it is (to read the operation off the source). */
  site?: { path: string; line: number; col: number }
  times: number
  children: Step[]
  /** Followed no further: the depth limit, a cycle, or the exploration budget. */
  cut: boolean
  /** Hops to the nearest tRPC call or query below (0: this is one); Infinity when none. */
  data: number
  /** Callee's fan-in (utilities are left out). */
  fanIn: number
  server: boolean
  /** An alt operand's guard: the class it runs in. */
  guard?: string
  /** The caller also passes the callee around (a wrapper, a callback): maybe not called right then. */
  wrapped: boolean
  /** A query standing for this many queries of one database in a row. */
  run?: number
}

const routeOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('route:') || t.startsWith('api:'))
const stem = (name: string) => name.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, '')

/** A file's name in the diagram: without its extension; with its folder for an index, page or route file. */
export function participantName(n: GraphNode): string {
  const dir = n.path?.split('/').slice(-2, -1)[0]
  const base = stem(n.name)
  return /^(index|page|route|layout|main|mod)$/.test(base) && dir ? `${dir}/${base}` : base
}

/** What a scenario is called: the route, or the entry file's name. */
export function scenarioName(entry: GraphNode): string {
  const route = routeOf(entry)
  return route ? route.slice(route.indexOf(':') + 1) : participantName(entry)
}

/** The files a scenario can start at: pages and API routes, else entry points (tests left out). */
export function entriesOf(files: readonly GraphNode[]): GraphNode[] {
  const real = files.filter(f => f.kind === 'file' && !f.tags?.includes('test'))
  const routes = real.filter(f => routeOf(f) && !/^layout\./.test(f.name))
  const list = routes.length ? routes : real.filter(f => f.tags?.includes('entrypoint'))
  return [...list].sort((a, b) => cmp(scenarioName(a), scenarioName(b)) || cmp(a.id, b.id))
}

export async function walkScenario(input: WalkInput): Promise<Scenario> {
  const limits = { ...LIMITS, ...input.limits }
  const entry = input.entry
  const fetched = new Map<string, Promise<FileDetails | undefined>>()
  const details = (file: string) => {
    let p = fetched.get(file)
    if (!p) {
      p = fetched.size < limits.files ? input.details(file) : Promise.resolve(undefined)
      fetched.set(file, p)
    }
    return p
  }
  /** A symbol node, from its file's details (each file's nodes indexed once). */
  const indexes = new Map<string, Map<string, GraphNode>>()
  const nodeOf = async (id: string) => {
    const file = fileIdOf(id) ?? id
    const d = await details(file)
    if (!d) return undefined
    let index = indexes.get(file)
    if (!index) indexes.set(file, (index = new Map([...d.endpoints, ...d.symbols].map(n => [n.id, n]))))
    return index.get(id)
  }

  // ── explore: every call reachable within the limits ──────────────────────
  let budget = limits.steps
  const api = entry.tags?.some(t => t.startsWith('api:'))
  const root = await details(entry.id)
  const mains = mainSymbols(root?.symbols ?? [], api ?? false)

  const expand = async (symbol: string, depth: number, stack: Set<string>, server: boolean): Promise<Step[]> => {
    const file = fileIdOf(symbol)
    const d = file ? await details(file) : undefined
    if (!d) return []
    const byTarget = new Map<string, { kind: string; subkind?: string; sites: [number, number][]; count: number }>()
    const passed = new Set(d.edges.filter(e => e.source === symbol && e.kind === 'references').map(e => e.target))
    // a class runs its constructor and lifecycle hooks when it comes into play (an Angular component's ngOnInit)
    const lifecycle = new Set(d.symbols.filter(s => s.parent === symbol && LIFECYCLE.has(s.name)).map(s => s.id))
    for (const e of d.edges) {
      if ((e.source !== symbol && !lifecycle.has(e.source)) || !WALKED.has(e.kind) || !(e.target.startsWith('s:') || (e.kind === 'publishes' && e.target.startsWith('x:')))) continue
      const key = `${e.kind}\u0000${e.target}`
      const had = byTarget.get(key)
      const sites: [number, number][] = []
      for (let i = 0; i + 1 < e.sites.length; i += 2) sites.push([e.sites[i], e.sites[i + 1]])
      if (had) {
        had.sites.push(...sites)
        had.count += e.count
      } else byTarget.set(key, { kind: e.kind, subkind: e.subkind, sites, count: e.count })
    }
    const raw = [...byTarget].map(([key, v]) => ({ target: key.slice(key.indexOf('\u0000') + 1), ...v, first: v.sites.sort((a, b) => a[0] - b[0] || a[1] - b[1])[0] ?? [Infinity, 0] }))
    raw.sort((a, b) => a.first[0] - b.first[0] || a.first[1] - b.first[1] || cmp(a.target, b.target))
    // fetch every file these lead to at once; the walk below then finds them loaded
    for (const r of raw) void details(fileIdOf(r.target) ?? r.target)

    const steps: Step[] = []
    for (const r of raw) {
      if (budget <= 0) break
      const target = await nodeOf(r.target)
      if (!target) continue
      const times = Math.max(1, r.sites.length)
      const step = (kind: Step['kind'], label: string): Step => {
        budget--
        return { kind, callee: r.target, caller: symbol, label, times, children: [], cut: false, data: Infinity, fanIn: target.metrics?.fanIn ?? 0, server, wrapped: passed.has(r.target) }
      }
      if (r.kind === 'queries') {
        // a Prisma model's or a Dexie table's name; what it does comes from the source line later
        const s = step('query', `${target.name}${r.subkind === 'write' ? ' (write)' : ' (read)'}`)
        s.site = { path: d.symbols.find(x => x.id === symbol)?.path ?? file!.slice(2), line: r.first[0], col: r.first[1] }
        s.data = 0
        steps.push(s)
        continue
      }
      if (r.kind === 'rpc-call') {
        const path = target.tags?.find(t => t.startsWith('rpc:'))?.slice(4) ?? target.name
        const s = step('rpc', `${path}${r.subkind ? `.${r.subkind}()` : '()'}`)
        s.server = true
        await follow(s, depth, stack, true)
        steps.push(s)
        continue
      }
      if (r.kind === 'http-call') {
        // the handler's own route when it has one for this method: GET /projects/{projectId}
        const routes = target.tags?.filter(t => t.startsWith('http:')).map(t => t.slice(5)) ?? []
        const route = routes.find(t => t.startsWith(`${r.subkind} `)) ?? routes[0] ?? `${r.subkind ?? ''} ${target.name}`
        const s = step('rpc', route)
        s.server = true
        await follow(s, depth, stack, true)
        steps.push(s)
        continue
      }
      if (r.kind === 'publishes') {
        // to the topic, then on to each subscriber, which handles it on its own
        const s = step('publish', `publish ${target.name}`)
        const kafka = target.kind === 'external'
        const td = await details(laneOf(r.target))
        const subscribers = [...new Set((td?.edges ?? []).filter(e => e.kind === 'subscribes' && e.target === r.target).map(e => e.source))].sort(cmp).slice(0, MAX_SUBSCRIBERS)
        for (const sub of subscribers) {
          const n = await nodeOf(sub)
          if (!n || budget <= 0) continue
          budget--
          const deliver: Step = { kind: 'deliver', callee: sub, caller: r.target, label: `${n.name}()`, times: 1, children: [], cut: false, data: Infinity, fanIn: 0, server: kafka || server, wrapped: false }
          await follow(deliver, depth, stack, deliver.server)
          s.children.push(deliver)
        }
        steps.push(s)
        continue
      }
      if (NOT_CALLABLE.has(target.subkind ?? '') && !(target.kind === 'member' && target.subkind === 'method')) continue
      // a method of an interface: the call goes to the interface, which hands it to each class implementing it
      const impls = await implementersOf(target)
      if (impls.length) {
        const s = step('call', `${target.name}()`)
        const alt: Step = { ...step('alt', ''), callee: r.target, caller: r.target, times: 1 }
        for (const impl of impls) {
          const owner = impl.parent ? await nodeOf(impl.parent) : undefined
          const op: Step = { ...step('call', `${impl.name}()`), callee: impl.id, caller: r.target, times: 1, fanIn: impl.metrics?.fanIn ?? 0 }
          op.guard = owner?.name ?? participantName(input.file(fileIdOf(impl.id)!) ?? impl)
          // handing the call on to a class isn't a level of its own
          await follow(op, depth, stack, server)
          alt.children.push(op)
        }
        s.children.push(alt)
        steps.push(s)
        continue
      }
      const same = fileIdOf(r.target) === file
      const kind: MessageKind = same ? 'self' : r.kind === 'renders' ? 'render' : r.kind === 'instantiates' ? 'new' : 'call'
      const label = r.kind === 'renders' ? `<${target.name}/>` : r.kind === 'instantiates' ? `new ${target.name}()` : `${target.name}()`
      const s = step(kind, label)
      if (r.kind === 'instantiates') {
        // a constructor is where `new` leads
        const ctor = `${r.target}.constructor`
        if (await nodeOf(ctor)) await follow(s, depth, stack, server, ctor)
      } else await follow(s, same ? depth - 1 : depth, stack, server) // a call within a file isn't a level of its own
      steps.push(s)
    }
    return mergeRepeats(steps)
  }

  /** Classes' methods implementing an interface method (sorted). */
  const implementersOf = async (member: GraphNode): Promise<GraphNode[]> => {
    if (member.kind !== 'member' || !member.parent) return []
    const owner = await nodeOf(member.parent)
    if (owner?.subkind !== 'interface') return []
    const d = await details(fileIdOf(member.id)!)
    const ids = [...new Set((d?.edges ?? []).filter(e => e.kind === 'implements' && e.target === member.id).map(e => e.source))].sort(cmp)
    const nodes: GraphNode[] = []
    for (const id of ids) {
      const n = await nodeOf(id)
      if (n) nodes.push(n)
    }
    return nodes
  }

  const follow = async (s: Step, depth: number, stack: Set<string>, server: boolean, into = s.callee) => {
    if (depth >= limits.depth || stack.has(into) || budget <= 0) {
      s.cut = depth >= limits.depth || budget <= 0
      return
    }
    stack.add(into)
    s.children = await expand(into, depth + 1, stack, server)
    stack.delete(into)
  }

  const roots: Step[] = []
  const route = routeOf(entry)
  for (const main of mains) {
    const method = api && HANDLERS.has(main.name) ? main.name : ''
    const handles = main.tags?.find(t => t.startsWith('http:'))?.slice(5).replace(/^ANY /, '')
    const label = method ? `${method} ${scenarioName(entry)}` : handles ? handles : route ? `open ${scenarioName(entry)}` : `${main.name}()`
    const s: Step = { kind: 'open', callee: main.id, caller: '', label, times: 1, children: [], cut: false, data: Infinity, fanIn: 0, server: !!api, wrapped: false }
    await follow(s, 0, new Set(), !!api)
    roots.push(s)
  }
  for (const r of roots) hops(r)

  // ── choose: the ways to the data first, then the rest, up to the cap ─────
  const chosen = choose(roots, limits.messages, limits.participants)

  // ── lay out as messages between participants ─────────────────────────────
  const participants: Participant[] = []
  const at = new Map<string, number>()
  const participant = (file: string, kind: Participant['kind'], server: boolean) => {
    const key = kind === 'actor' ? 'actor' : file
    let i = at.get(key)
    if (i === undefined) {
      const node = input.file(file)
      const name = kind === 'actor' ? (api ? 'HTTP client' : 'Browser') : node ? participantName(node) : file
      i = participants.length
      participants.push({ id: file, kind, name, side: server ? 'server' : 'client' })
      at.set(key, i)
    } else if ((kind === 'interface' && participants[i].kind === 'file') || kind === 'database' || kind === 'topic') participants[i].kind = kind
    return i
  }
  const messages: Message[] = []
  const fragments: Fragment[] = []
  const queries: { message: Message; site: NonNullable<Step['site']>; table: string; run: number }[] = []
  const actor = participant(entry.id, 'actor', false)

  const emit = (s: Step, from: number, depth: number, fragment?: Message['fragment']) => {
    const file = laneOf(s.callee)
    const kind: Participant['kind'] = s.kind === 'query' ? 'database' : s.kind === 'publish' ? 'topic' : s.children.some(c => c.kind === 'alt') ? 'interface' : 'file'
    const to = s.kind === 'self' ? from : participant(file, kind, s.server)
    const shown = s.children.filter(c => chosen.has(c))
    const message: Message = {
      from,
      to,
      kind: s.kind as MessageKind,
      label: s.label,
      target: s.kind === 'open' ? entry.id : s.callee,
      source: s.caller,
      depth,
      times: s.times,
      fragment,
      hidden: s.children.filter(c => !chosen.has(c) && c.kind !== 'alt' && !isUtility(c) && !(c.kind === 'self' && !c.children.length)).length,
      collapsed: collapsedSteps.has(s),
    }
    messages.push(message)
    if (s.kind === 'query' && s.site) queries.push({ message, site: s.site, table: s.label.replace(/ \((read|write)\)$/, ''), run: s.run ?? 1 })
    for (const c of shown) {
      if (c.kind !== 'alt') {
        emit(c, to, depth + 1, fragment)
        continue
      }
      const index = fragments.length
      const f: Fragment = { kind: 'alt', operands: [], depth }
      fragments.push(f)
      c.children.filter(op => chosen.has(op)).forEach((op, k) => {
        const first = messages.length
        emit(op, to, depth + 1, { index, operand: k })
        f.operands.push({ guard: op.guard ?? '', first, last: messages.length - 1 })
      })
    }
  }
  for (const r of roots) emit(r, actor, 1)

  // a query says what it does when the source line shows it: Account.findMany()
  if (input.line)
    await Promise.all(
      queries.map(async q => {
        const text = await input.line!(q.site.path, q.site.line).catch(() => undefined)
        const op = text ? /^\s*\w+\s*\??\.\s*(\w+)\s*\(/.exec(text.slice(q.site.col - 1)) : null
        if (op) q.message.label = `${q.table}.${op[1]}()`
      }),
    )
  for (const q of queries) if (q.run > 1) q.message.label += ` +${q.run - 1} more`

  const found = countSteps(roots)
  // files sharing a name are told apart by their folder
  const named = new Map<string, number>()
  for (const p of participants) named.set(p.name, (named.get(p.name) ?? 0) + 1)
  for (const p of participants) {
    const node = input.file(p.id)
    const dir = node?.path?.split('/').slice(-2, -1)[0]
    if (p.kind !== 'actor' && named.get(p.name)! > 1 && dir && !p.name.includes('/')) p.name = `${dir}/${p.name}`
  }

  return {
    entry: entry.id,
    name: scenarioName(entry),
    participants: order(participants, messages),
    messages,
    fragments,
    left: Math.max(0, found - messages.length),
    files: fetched.size,
  }

  // ── helpers that need the walk's state ───────────────────────────────────

  function choose(starts: Step[], cap: number, lifelines: number): Set<Step> {
    const chosen = new Set<Step>(starts)
    let used = starts.length
    const seen = new Set<string>()
    // lifelines: the actor, the entry, and each file a chosen message goes to
    const files = new Set<string>(['actor', entry.id])
    const fits = (...steps: Step[]) => {
      const extra = new Set(steps.filter(x => x.kind !== 'self').map(x => laneOf(x.callee)).filter(f => !files.has(f)))
      return files.size + extra.size <= lifelines
    }
    const take = (x: Step) => {
      if (x.kind !== 'self') files.add(laneOf(x.callee))
    }
    // candidates: children of chosen steps. Ways to the data first (nearest first), then the rest by
    // depth, in source order; last, calls going a way already shown (they're shown, not followed)
    const queue: { s: Step; depth: number; order: number; again: boolean }[] = []
    let n = 0
    const offer = (s: Step, depth: number) => {
      for (const c of s.children) queue.push({ s: c, depth, order: n++, again: false })
    }
    // ways to the data; then calls leading somewhere; then leaf calls (a button rendered); then calls
    // also passed around (a wrapper, a callback: they may not run then); last, ways already shown
    const rank = (c: (typeof queue)[number]) => (c.again ? 4 : c.s.wrapped ? 3 : c.s.data < Infinity ? 0 : c.s.children.length ? 1 : 2)
    // calls going a way shown above: at most this many under one caller (the rest count as left out)
    const againPer = new Map<string, number>()
    starts.forEach(s => offer(s, 1))
    while (queue.length && used < cap) {
      queue.sort((a, b) => rank(a) - rank(b) || (rank(a) ? 0 : a.s.data - b.s.data) || a.depth - b.depth || a.order - b.order)
      const next = queue.shift()!
      const { s, depth } = next
      if (isUtility(s)) continue
      if (s.kind === 'alt') {
        const ops = s.children
        if (used + ops.length > cap || !fits(...ops)) continue
        chosen.add(s)
        for (const op of ops) {
          chosen.add(op)
          take(op)
          used++
          offer(op, depth + 1)
        }
        continue
      }
      if (!fits(s)) continue
      // a way down to the data that a message above already showed in full: told once
      const signature = s.data < Infinity && s.kind !== 'self' && s.children.length ? routeSignature(s) : ''
      if (signature && seen.has(signature) && !next.again) {
        queue.push({ ...next, again: true })
        continue
      }
      if (next.again) {
        const n = againPer.get(s.caller) ?? 0
        if (n >= MAX_AGAIN) continue
        againPer.set(s.caller, n + 1)
      }
      chosen.add(s)
      take(s)
      used++
      if (next.again) {
        collapsedSteps.add(s)
        continue
      }
      if (signature) seen.add(signature)
      offer(s, depth + 1)
    }
    // a call within a file is shown only for what it leads to
    const prune = (s: Step): boolean => {
      let keep = false
      for (const c of s.children) if (chosen.has(c) && prune(c)) keep = true
      if (s.kind === 'self' && !keep) chosen.delete(s)
      return chosen.has(s)
    }
    starts.forEach(prune)
    // an alt whose operands all went is gone too
    const altPrune = (s: Step) => {
      for (const c of s.children) {
        if (c.kind === 'alt' && !c.children.some(op => chosen.has(op))) chosen.delete(c)
        altPrune(c)
      }
    }
    starts.forEach(altPrune)
    return chosen
  }
}

/** Steps shown but not followed: another message above went the same way. */
const collapsedSteps = new WeakSet<Step>()

/** The symbols a scenario starts at: a page's default export, an API route's handlers, else what the file exports. */
export function mainSymbols(symbols: readonly GraphNode[], api: boolean): GraphNode[] {
  const top = symbols.filter(s => s.kind === 'symbol')
  if (api) {
    const handlers = top.filter(s => HANDLERS.has(s.name))
    if (handlers.length) return handlers
    // a controller's handler methods (Spring's @GetMapping & co., tagged http:GET /path)
    const routed = symbols.filter(s => s.kind === 'member' && s.tags?.some(t => t.startsWith('http:')))
    if (routed.length) return routed
  }
  const main = top.filter(s => s.tags?.includes('default-export'))
  if (main.length) return main
  const exported = top.filter(s => s.exported && !NOT_CALLABLE.has(s.subkind ?? ''))
  return exported.length ? exported : top.filter(s => !NOT_CALLABLE.has(s.subkind ?? '')).slice(0, 1)
}

/** A call to something used everywhere that doesn't lead to data: a utility (a button, a formatter), left out. */
const isUtility = (s: Step) => s.kind !== 'alt' && s.kind !== 'open' && s.data === Infinity && s.fanIn >= UTILITY_FAN_IN

/** How far each step is from data: 0 for a query or a tRPC call, else 1 + its nearest child's. */
function hops(s: Step): number {
  let best = s.kind === 'query' || s.kind === 'rpc' || s.kind === 'publish' ? 0 : Infinity
  for (const c of s.children) {
    const h = hops(c)
    // an alt adds no message of its own
    best = Math.min(best, c.kind === 'alt' ? h : h + 1)
  }
  if (s.kind === 'rpc' || s.kind === 'publish') best = 0
  s.data = best
  return best
}

/**
 * The way a step takes to its nearest data: the kinds of its messages and
 * where they end. Two calls taking the same way are told once.
 */
function routeSignature(s: Step): string {
  const parts: string[] = []
  let at: Step | undefined = s
  let last = s
  while (at) {
    if (at.kind !== 'self') parts.push(at.kind)
    last = at
    if (at.kind === 'query') break
    at = [...at.children].filter(c => c.data < Infinity).sort((a, b) => a.data - b.data)[0]
  }
  return `${parts.join('>')}@${laneOf(last.callee)}`
}

/** Queries of one database in a row, at least this many, become one message. */
const QUERY_RUN = 3

/**
 * Siblings calling the same thing one after another become one message (×n),
 * and a run of queries of one database becomes one too (`Loan.deleteMany() +13 more`).
 */
function mergeRepeats(steps: Step[]): Step[] {
  const out: Step[] = []
  for (const s of steps) {
    const prev = out[out.length - 1]
    if (prev && prev.kind === s.kind && prev.callee === s.callee && !s.children.length && !prev.children.length) prev.times += s.times
    else out.push(s)
  }
  const merged: Step[] = []
  for (let i = 0; i < out.length; ) {
    let j = i
    const db = out[i].kind === 'query' ? fileIdOf(out[i].callee) : undefined
    while (db && j + 1 < out.length && out[j + 1].kind === 'query' && fileIdOf(out[j + 1].callee) === db) j++
    if (j - i + 1 >= QUERY_RUN) {
      merged.push({ ...out[i], run: j - i + 1 })
      i = j + 1
    } else merged.push(out[i++])
  }
  return merged
}

function countSteps(steps: Step[]): number {
  let n = 0
  for (const s of steps) n += (s.kind === 'alt' ? 0 : 1) + countSteps(s.children)
  return n
}

/**
 * Participants in order: the actor, then the client side, then the server
 * side, each by first appearance with its databases last; message ends
 * renumbered to match.
 */
function order(participants: Participant[], messages: Message[]): Participant[] {
  const first = new Map<number, number>()
  messages.forEach((m, k) => {
    if (!first.has(m.from)) first.set(m.from, k)
    if (!first.has(m.to)) first.set(m.to, k)
  })
  const key = (p: Participant) => (p.kind === 'actor' ? 0 : (p.side === 'server' ? 2 : 1) * 2 + (p.kind === 'database' || p.kind === 'topic' ? 1 : 0))
  const sorted = participants.map((p, i) => i).sort((a, b) => key(participants[a]) - key(participants[b]) || (first.get(a) ?? 0) - (first.get(b) ?? 0) || a - b)
  const renumber = new Map(sorted.map((old, i) => [old, i]))
  for (const m of messages) {
    m.from = renumber.get(m.from)!
    m.to = renumber.get(m.to)!
  }
  return sorted.map(i => participants[i])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
