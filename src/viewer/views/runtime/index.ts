// The arc42 §6 Runtime View (a view plug-in): one scenario, a page or an API
// route, as a sequence diagram on a board standing on the floor. Read
// straight on it's the textbook diagram: lifelines, messages in source order,
// an alt where an interface hands a call to the classes implementing it, the
// network as a glass pane between the browser's side and the server's. The
// depth is the call stack: an activation stands out of the board as far as
// it is deep, so orbiting shows the stack in relief. A pulse replays the
// messages in order. Messages come from static, symbol-level edges, read per
// file on demand (see scenario.ts). With the toolbar's grouping, the
// lifelines are its groups (grouped.ts): the scenario between building blocks.
import { emptyLayout } from '../../layouts/types.ts'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { labelOf, namesKey, store } from '../../store.ts'
import type { State } from '../../store.ts'
import { anchor, stand } from '../arc42-kit/anchors.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import { groupName } from '../arc42-kit/blocks.ts'
import type { BlockGrouping } from '../arc42-kit/blocks.ts'
import { ARC42, SECTIONS } from '../arc42-kit/sections.ts'
import type { ViewPlugin } from '../types.ts'
import { currentEntry, entriesFor, publishEntries, publishShown, runtime, scenarioFor, setRefresh } from './choice.ts'
import { Controls } from './Controls.tsx'
import { HEADER_H, HEADER_RELIEF, NAME_ABOVE, ROW, layoutDiagram, messageText, relief } from './diagram.ts'
import type { Diagram } from './diagram.ts'
import { RuntimeDecoration, diagrams, onWall, relatedTo } from './decoration.ts'
import { groupScenario } from './grouped.ts'
import { Legend } from './Legend.tsx'
import type { Scenario } from './scenario.ts'
import './runtime.css'

/** The home camera: straight at the board, a little from above. */
const HOME: [number, number, number] = [0, 0.08, 1]
const FOV_HEIGHT = 2 * Math.tan((25 * Math.PI) / 180)

const CLIENT = 'client ←'
const SERVER = '→ server'
/** A label's width as the viewer guesses it (labels.ts), in pixels. */
const guess = (text: string) => text.length * 7 + 12

/** A scenario as the toolbar groups it, per grouping, so a refresh keeps the same one (and its diagram). */
const regrouped = new WeakMap<Scenario, { key: string; scenario: Scenario }>()

function groupedAs(scenario: Scenario, grouping: (BlockGrouping & { key: string }) | null): Scenario {
  if (!grouping) return scenario
  const had = regrouped.get(scenario)
  if (had?.key === grouping.key) return had.scenario
  const labels = new Map(grouping.groups.map(g => [g.id, groupName(g)]))
  const grouped = groupScenario(scenario, grouping.groupOf, id => labels.get(id) ?? id)
  regrouped.set(scenario, { key: grouping.key, scenario: grouped })
  return grouped
}

/** A diagram per scenario and screen size, so a refresh doesn't rebuild the drawing. */
const laidOut = new WeakMap<Scenario, { key: string; diagram: Diagram }>()

function diagramOf(scenario: Scenario): Diagram {
  const viewport = typeof innerHeight === 'number' && innerHeight > 200 ? innerHeight : 1000
  const aspect = typeof innerWidth === 'number' && innerWidth > 200 ? Math.max(1, (innerWidth - 24) / viewport) : 1.6
  const key = `${Math.round(viewport / 50)}|${Math.round(aspect * 10)}`
  const had = laidOut.get(scenario)
  if (had?.key === key) return had.diagram
  const diagram = layoutDiagram(scenario, { viewport, aspect })
  laidOut.set(scenario, { key, diagram })
  return diagram
}

// opening the view with a page or an API route selected starts at it
let lastView = ''
store.subscribe(s => {
  const view = s.options.view
  if (view === 'runtime' && lastView !== 'runtime' && lastView && s.world && s.selected?.startsWith('f:') && entriesFor(s.world).some(e => e.id === s.selected))
    runtime.setState({ picked: s.selected })
  lastView = view
})

const view: ViewPlugin = {
  id: 'runtime',
  label: SECTIONS.runtime.label,
  description: 'arc42 §6: a page or API route as a sequence diagram, its calls in order down to the data; the call stack stands out in relief',
  order: SECTIONS.runtime.order,
  group: ARC42,
  // the messages are the view: no edges to choose
  edges: false,

  // the participants' names set the lifelines' spacing
  layoutKey: ctx => `${runtime.getState().picked ?? ''}|${namesKey(ctx.s)}`,

  layout(ctx) {
    setRefresh(ctx.refresh)
    const entries = entriesFor(ctx.world)
    const entry = currentEntry(entries, runtime.getState().picked)
    publishEntries(entries)
    const node = entry ? ctx.world.node(entry.id) : undefined
    if (!entry || !node) return note('No pages, API routes or entry points to start a scenario at')
    const walk = scenarioFor(ctx.world, node)
    if (!walk) return undefined // being walked: the view refreshes when it's there
    if (!walk.scenario) return note(`Couldn’t trace ${entry.name}: ${walk.failed ?? 'unknown error'}`)
    publishEntries(entries)
    const scenario = named(groupedAs(walk.scenario, ctx.grouping), ctx.s)
    const d = diagramOf(scenario)
    publishShown(scenario)

    // the layers' colors, a database's own, the actor in ink
    const layers = ctx.layers()
    const tones = d.scenario.participants.map(p => {
      if (p.kind === 'actor') return 'ink'
      if (p.kind === 'database' || p.kind === 'topic') return 'data'
      // a group's: the layer most of its files are in
      const votes = new Map<number, number>()
      for (const f of p.members ?? [p.id]) {
        const n = ctx.world.node(f)
        const i = n ? layers.order.indexOf(layers.layerOf(n) ?? '') : -1
        if (i >= 0) votes.set(i, (votes.get(i) ?? 0) + 1)
      }
      const i = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
      return i !== undefined ? `cat:${i}` : 'muted'
    })

    // the camera as far away as the scale the diagram was laid out for needs
    const distance = d.viewport / (FOV_HEIGHT * d.pixels)
    const out: Layout = {
      ...emptyLayout(),
      view: 'runtime',
      size: distance / Math.hypot(...HOME),
      shape: 'box',
      arcAnchor: 'center',
      ground: true,
      arcs: 'none',
      openFile: 'none',
      hideBoxes: true,
      keepView: true,
      home: HOME,
      center: [0, d.height / 2, ON_BOARD],
    }
    // the lifelines' headers: what the engine selects and frames. Its box reaches up to where the
    // engine puts its name (NAME_ABOVE over the top), so a name moved to the upper line has its box taller
    d.scenario.participants.forEach((p, i) => {
      const c = d.columns[i]
      if (p.kind === 'actor') return anchor(out, 'runtime:actor', onWall(d, c.u, c.nameV), c.headerW)
      const [x, bottom] = onWall(d, c.u, d.headerV + HEADER_H / 2)
      const top = onWall(d, c.u, c.nameV + NAME_ABOVE)[1]
      stand(out, p.id, { x, y: bottom, z: ON_BOARD + HEADER_RELIEF / 2, w: c.headerW, h: top - bottom, d: HEADER_RELIEF })
    })
    anchor(out, 'runtime:caption', onWall(d, d.caption[0], d.caption[1], ON_BOARD))
    anchor(out, 'runtime:heading', onWall(d, d.heading[0], d.heading[1], ON_BOARD))
    for (const l of d.labels) anchor(out, `runtime:msg:${l.message}`, onWall(d, l.u, l.v, ON_BOARD + relief(d.scenario.messages[l.message].depth) + 0.2))
    for (const f of d.fragments) {
      anchor(out, `runtime:alt:${f.index}`, onWall(d, f.tag[0], f.tag[1], ON_BOARD))
      f.guards.forEach((g, n) => anchor(out, `runtime:guard:${f.index}:${n}`, onWall(d, g.u, g.v, ON_BOARD)))
    }
    for (const m of d.more) anchor(out, `runtime:more:${m.message}`, onWall(d, m.u, m.v + 0.35 * ROW, ON_BOARD))
    const foot = d.height - 0.35 * ROW
    if (d.boundary) {
      // the network's name on the pane's foot, the two sides' either side of it (as far as the labels' widths need)
      const apart = (guess(d.boundary.label) / 2 + guess(CLIENT) / 2 + 8) / d.pixels
      anchor(out, 'runtime:net', onWall(d, d.boundary.u, foot, ON_BOARD))
      anchor(out, 'runtime:client', onWall(d, d.boundary.u - apart, foot, ON_BOARD))
      anchor(out, 'runtime:server', onWall(d, d.boundary.u + apart, foot, ON_BOARD))
    }
    anchor(out, 'runtime:left', onWall(d, d.width - 5 * ROW, foot, ON_BOARD))
    diagrams.set(out, { diagram: d, tones })
    return out
  },

  decoration: (_ctx, engine) => new RuntimeDecoration(engine),

  labels(ctx, layout) {
    const entry = diagrams.get(layout)
    if (!entry) {
      const text = notes.get(layout)
      return text ? [{ id: 'runtime:note', text, priority: 1000, className: 'a42-heading' }] : []
    }
    const d = entry.diagram
    const s = d.scenario
    const related = relatedTo(ctx.s.selected, d)
    const dim = (on: boolean) => (related && !on ? ' a42-dim' : '')
    const specs: LabelSpec[] = [
      { id: 'runtime:caption', text: `arc42 §${SECTIONS.runtime.number} · ${SECTIONS.runtime.title}`, priority: 1100, className: 'a42-title a42-left' },
      { id: 'runtime:heading', text: `${s.name}${s.participants[1] ? ` · ${s.participants[0].name} → ${s.participants[1].name}` : ''}`, priority: 1100, className: 'a42-heading a42-left' },
    ]
    s.participants.forEach((p, i) => {
      const selected = p.kind !== 'actor' && ctx.s.selected === p.id
      specs.push({
        id: p.kind === 'actor' ? 'runtime:actor' : p.id,
        text: p.name,
        // above the viewer's own name for the selection and its neighbors, which it hides
        priority: 1050 - i / 100,
        className: `a42-name${selected ? ' selected' : ''}${p.kind === 'interface' || p.kind === 'topic' ? ' rt-interface' : ''}${selected ? '' : dim(!!related?.participants.has(i))}`,
      })
    })
    s.messages.forEach((m, k) => {
      const kind = m.collapsed ? ' rt-collapsed' : m.kind === 'rpc' ? ' rt-rpc' : m.kind === 'query' || m.kind === 'publish' ? ' rt-query' : ''
      specs.push({ id: `runtime:msg:${k}`, text: messageText(m), priority: 800 - k / 100, className: `a42-small${kind}${dim(!!related?.messages.has(k))}` })
    })
    for (const f of d.fragments) {
      specs.push({ id: `runtime:alt:${f.index}`, text: 'alt', priority: 790, className: 'a42-small rt-tag' })
      f.guards.forEach((g, n) => specs.push({ id: `runtime:guard:${f.index}:${n}`, text: g.text, priority: 789, className: 'a42-small rt-guard' }))
    }
    for (const m of d.more) specs.push({ id: `runtime:more:${m.message}`, text: m.text, priority: 300, className: 'a42-small' })
    if (d.boundary) {
      specs.push({ id: 'runtime:net', text: d.boundary.label, priority: 1060, className: 'a42-small a42-accent a42-pill' })
      specs.push({ id: 'runtime:client', text: CLIENT, priority: 1040, className: 'a42-title' })
      specs.push({ id: 'runtime:server', text: SERVER, priority: 1040, className: 'a42-title' })
    }
    if (s.left) specs.push({ id: 'runtime:left', text: `${s.messages.length} of ${s.messages.length + s.left} calls shown`, priority: 1000, className: 'a42-small' })
    return specs
  },

  Controls,
  Legend,
}

export default view

/** Layouts that only say something (nothing to show, or it failed). */
const notes = new WeakMap<Layout, string>()

function note(text: string): Layout {
  const out: Layout = { ...emptyLayout(), view: 'runtime', size: 80, ground: true, arcs: 'none', openFile: 'none', hideBoxes: true, keepView: true, home: HOME, center: [0, 8, 0] }
  anchor(out, 'runtime:note', [0, 10, 0], 1)
  notes.set(out, text)
  return out
}

/** The scenario with the names written for its files (described names on) on their lifelines. */
function named(scenario: Scenario, s: State): Scenario {
  if (s.options.names !== 'described') return scenario
  return { ...scenario, participants: scenario.participants.map(p => (p.kind === 'file' ? { ...p, name: labelOf(s, p.id, p.name) } : p)) }
}
