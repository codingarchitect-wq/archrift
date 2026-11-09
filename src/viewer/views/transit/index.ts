// Transit: a subway map of how requests travel through the code. Each line
// runs from a page or API route (or an entry point) down through the layers,
// columns left to right, to the data it reads; a file on several lines is an
// interchange. Stations are the layout's boxes (flat discs, so selecting,
// hovering, labels and fly-to work as everywhere); the lines are the
// decoration's ribbons, and they stand in for the dependency arcs.
import * as THREE from 'three'
import { emptyLayout } from '../../layouts/types.ts'
import type { Layout } from '../../layouts/types.ts'
import type { GraphNode } from '../../../core/model.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { labelOf, namesKey } from '../../store.ts'
import type { State } from '../../store.ts'
import type { ViewPlugin } from '../types.ts'
import { choice, choiceKey, publishLines, setRefresh, shownIds } from './choice.ts'
import { Controls } from './Controls.tsx'
import { Legend } from './Legend.tsx'
import { STATION_H, STATION_Y, TransitDecoration } from './decoration.ts'
import { DIM, headersOf, lineColor, lineColorOn, litLines, maps, networkOf, stationsOf } from './model.ts'
import { stationName } from './network.ts'
import { ROW, SLOT, schematic } from './schematic.ts'

/** A name below its station hangs this far under the disc (a label's height at the usual zoom). */
const LABEL_DROP = 3.2
/** About how many pixels the layout's size spans at the home view, and a label character's width (labels.ts). */
const HOME_PIXELS = 1100
const CHAR_PX = 7

const transit: ViewPlugin = {
  id: 'transit',
  label: 'Transit',
  description: 'A subway map: lines from each page or API route down through the layers to the data; shared files are interchanges',
  order: 50,

  // the names' widths place them above or below their stations
  layoutKey: ctx => `${ctx.graph.key}|${ctx.s.options.layering}|${choiceKey(choice.getState())}|${namesKey(ctx.s)}`,

  layout(ctx) {
    setRefresh(ctx.refresh)
    const network = networkOf(ctx)
    publishLines(network.lines.map((l, rank) => ({ id: l.id, name: l.name, stations: stationsOf(l).length, end: l.end, color: lineColor(rank) })))
    const ids = shownIds(choice.getState(), network.lines)
    const ranks = network.lines.flatMap((l, rank) => (ids.has(l.id) ? [rank] : []))
    const shown = ranks.map(r => network.lines[r])
    const map = schematic(shown, network.column, network.columns)

    const width = map.maxX - map.minX + SLOT * 2
    // room above for the column headers, clear of the toolbar, and below for the legend
    const height = map.maxZ - map.minZ + ROW * 9
    const size = Math.max(60, width, height * 1.5)
    const out: Layout = {
      ...emptyLayout(),
      view: 'transit',
      size,
      shape: 'sphere',
      arcAnchor: 'center',
      ground: true,
      arcs: 'none',
      openFile: 'none',
      // from above, tilted just a little
      home: [0, 0.86, 0.03],
      center: [(map.minX + map.maxX) / 2, 0, (map.minZ + map.maxZ) / 2 - ROW * 1.6],
    }
    // label anchors are clusters: not drawn, and their width lets names hide when zoomed out
    const anchor = (id: string, x: number, z: number, w: number) => {
      out.boxes.set(id, { x, y: 0, z, w, d: 0.1, h: 0 })
      out.placement.set(id, 'cluster')
    }
    // names above their stations; where two in a row would overlap at the home view, the second one's below (when that's free)
    const lineNames = new Map(shown.map(l => [l.id, l.name]))
    const text = (id: string) => lineNames.get(id) ?? nameOf(ctx.s, id, ctx.world.node(id))
    const pixels = (id: string) => text(id).length * CHAR_PX + 14
    const taken = new Set([...map.stations.values()].map(s => `${s.slot}:${s.row}`))
    const below = new Set<string>()
    const byRow = [...map.stations.values()].sort((a, b) => a.row - b.row || a.slot - b.slot)
    byRow.forEach((s, i) => {
      out.boxes.set(s.id, { x: s.x, y: STATION_Y, z: s.z, w: s.radius * 2, d: s.radius * 2, h: STATION_H })
      out.placement.set(s.id, 'building')
      const prev = byRow[i - 1]
      const crowded = prev?.row === s.row && !below.has(prev.id) && (pixels(prev.id) + pixels(s.id)) / 2 + 6 > ((s.x - prev.x) * HOME_PIXELS) / size
      if (crowded && !lineNames.has(s.id) && !taken.has(`${s.slot}:${s.row + 1}`)) below.add(s.id)
      anchor(`transit:name:${s.id}`, s.x, below.has(s.id) ? s.z + s.radius + LABEL_DROP : s.z - s.radius - 0.3, SLOT * 0.85)
    })
    for (const l of shown) {
      const s = map.stations.get(l.id)!
      anchor(`transit:line:${l.id}`, s.x, s.z - s.radius - 0.3, SLOT)
    }
    map.bands.forEach((b, i) => anchor(`transit:column:${i}`, (b.x0 + b.x1) / 2, map.minZ - ROW * 1.6, b.x1 - b.x0))
    if (!shown.length) anchor('transit:empty', 0, 0, SLOT)
    maps.set(out, { network, shown, ranks, schematic: map, headers: headersOf(ctx, network) })
    return out
  },

  decoration: () => new TransitDecoration(),

  colors(ctx, layout, colors) {
    const map = maps.get(layout)
    if (!map) return
    const lit = litLines(ctx, map)
    const ground = new THREE.Color(ctx.theme.ground)
    // stations white, interchanges hollow inside their ring
    const white = new THREE.Color('#ffffff')
    const hollow = new THREE.Color(ctx.theme.background)
    for (const s of map.schematic.stations.values()) {
      const c = (s.interchange ? hollow : white).clone()
      if (lit && !s.lines.some(l => lit.has(l))) c.lerp(ground, DIM)
      colors.set(s.id, c)
    }
  },

  labels(ctx, layout) {
    const map = maps.get(layout)
    if (!map) return []
    const lit = litLines(ctx, map)
    const specs: LabelSpec[] = map.headers.map((text, i) => ({ id: `transit:column:${i}`, text, priority: 960, className: 'plane transit-column' }))
    if (!map.shown.length) {
      const text = map.network.lines.length ? 'No lines shown: pick some under Lines' : 'No lines: no pages, API routes or entry points with dependencies'
      specs.push({ id: 'transit:empty', text, priority: 990, className: 'plane' })
    }
    map.shown.forEach((l, i) => {
      const on = !lit || lit.has(i)
      const color = lineColorOn(map.ranks[i], ctx.theme)
      const ink = color.getHSL({ h: 0, s: 0, l: 0 }).l > 0.62 ? ' ink' : ''
      specs.push({ id: `transit:line:${l.id}`, text: l.name, priority: (lit && on ? 990 : 900) - i / 100, className: `transit-line tl${map.ranks[i]}${ink}${on ? '' : ' transit-dim'}` })
    })
    // where the viewer already names a station: its line's name at an entry, the selection and its neighbors
    const named = new Set(map.shown.map(l => l.id))
    const sel = ctx.s.selected
    if (sel && map.schematic.stations.has(sel)) {
      named.add(sel)
      const dir = ctx.s.options.focusDir
      for (const id of [...(dir === 'in' ? [] : (ctx.graph.out.get(sel) ?? [])), ...(dir === 'out' ? [] : (ctx.graph.in.get(sel) ?? []))]) named.add(id)
    }
    for (const s of map.schematic.stations.values()) {
      if (named.has(s.id)) continue
      const node = ctx.world.node(s.id)
      const on = !!lit && s.lines.some(l => lit.has(l))
      specs.push({
        id: `transit:name:${s.id}`,
        text: nameOf(ctx.s, s.id, node),
        // the selected lines' stations and every interchange always; the rest once there's room
        priority: on ? 800 : s.interchange ? 600 + s.lines.length : 300,
        minScreenWidth: on || s.interchange ? undefined : 70,
        className: `transit-station${s.interchange ? ' interchange' : ''}${lit && !on ? ' transit-dim' : ''}`,
      })
    }
    return specs
  },

  Controls,
  Legend,
}

export default transit

/** A station's name: the one written for its file (described names on), else the file's own, its folder's where that says more (`page`, `index`). */
const nameOf = (s: State, id: string, node: GraphNode | undefined) => labelOf(s, id, node ? stationName(node) : id)
