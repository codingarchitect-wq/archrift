// Glue between the store and the SceneEngine: turns state (world, view,
// filters, grouping, selection, focus, path, loaded file details) into what
// the scene draws, and scene events (hover, pick) into actions. Each part
// recomputes only when its inputs changed. The Galaxy's simulation runs in a
// worker; its positions are cached per set of visible nodes and grouping.
import * as THREE from 'three'
import { fileIdOf } from '../core/ids.ts'
import { matcher } from '../core/glob.ts'
import type { GraphNode } from '../core/model.ts'
import {
  ADDED_COLOR,
  AREA_PALETTE,
  CO_CHANGE_COLOR,
  CYCLE_COLOR,
  GROWN_COLOR,
  IN_COLOR,
  NEUTRAL,
  OUT_COLOR,
  PATH_COLOR,
  SHRUNK_COLOR,
  SUBKIND_COLORS,
  UP_COLOR,
  VIOLATION_COLOR,
  WARNING_COLOR,
  heat,
} from './colors.ts'
import { findingsByFile, worstTone } from '../core/changes.ts'
import { NO_FEATURE_GROUP, SHARED_GROUP, featureGroupId, isGroupId } from './groups.ts'
import { autoLayers } from '../core/auto-layers.ts'
import { buildingHeight, cityLayout } from './layouts/city.ts'
import { floorsFor, moonsFor } from './layouts/floors.ts'
import { galaxyLayout } from './layouts/galaxy.ts'
import type { GalaxyInput, Vec3 } from './layouts/galaxy.ts'
import { groupedLayout } from './layouts/grouped.ts'
import { UNASSIGNED, baseId, layersLayout } from './layouts/layers.ts'
import type { Layout } from './layouts/types.ts'
import type { ArcSpec, SceneEngine, Theme } from './scene/engine.ts'
import { folderPriority } from './scene/labels.ts'
import type { LabelSpec } from './scene/labels.ts'
import { ANSWER_ID, CHANGES_ID, actions, answerSceneId, areaOrder, changedFileIds, findNode, fixAt, labelOf, previousWorld, store, violationNodes, violationOf } from './store.ts'
import type { FocusDir, State } from './store.ts'
import { isKnownView, pluginFor } from './views/registry.ts'
import type { ViewContext, ViewDecoration } from './views/types.ts'
import { depGraph, modules, pathsBetween, reachEdges } from './world.ts'
import type { DepGraph, World } from './world.ts'

/** Most background arcs drawn in `auto`: beyond that they fold into directories. */
const AUTO_EDGE_LIMIT = 600
const MAX_FOCUS_ARCS = 4000
const MAX_NEIGHBOR_LABELS = 40

export function readTheme(): Theme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    background: v('--scene-bg', '#0e1117'),
    ground: v('--scene-ground', '#141922'),
    district: v('--scene-district', '#232a35'),
    selection: v('--scene-selection', '#ffffff'),
    accent: v('--accent', '#58a6ff'),
  }
}

// ── what the filters let through ───────────────────────────────────────────

export interface Visibility {
  key: string
  isVisible: (n: GraphNode) => boolean
  ids: Set<string>
}

let lastVisibility: { world: World; v: Visibility } | undefined

export function visibilityOf(s: State): Visibility {
  const world = s.world!
  const o = s.options
  const key = `${o.tests}|${o.externals}|${o.hide.join(',')}|${o.minLoc}|${o.onlyCycles}`
  if (lastVisibility?.world === world && lastVisibility.v.key === key) return lastVisibility.v
  const hidden = o.hide.length ? matcher(o.hide) : () => false
  const isVisible = (n: GraphNode) => {
    // a topic or a database is part of the system (`infra`), not a package: shown unless hidden by id (`x:kafka:*`)
    if (n.kind === 'external') return (o.externals || !!n.tags?.includes('infra')) && !hidden(n.id)
    if (n.kind !== 'file') return true
    if (!o.tests && n.tags?.includes('test')) return false
    if (o.onlyCycles && !n.tags?.includes('in-cycle')) return false
    if (o.minLoc && (n.metrics?.loc ?? 0) < o.minLoc) return false
    return !hidden(n.path ?? '')
  }
  const ids = new Set(world.graph.nodes.filter(n => (n.kind === 'file' || n.kind === 'external') && isVisible(n)).map(n => n.id))
  const v = { key, isVisible, ids }
  lastVisibility = { world, v }
  return v
}

/** The file-level dependency graph under the current filters, edge kinds and target. */
export function graphOf(s: State): DepGraph {
  const v = visibilityOf(s)
  const o = s.options
  return depGraph(s.world!, `${v.key}|${o.kinds.join(',')}|${o.target}`, o.kinds, o.target, id => v.ids.has(id))
}

// ── grouping and layers ────────────────────────────────────────────────────

export interface Grouping {
  key: string
  groups: { id: string; label: string }[]
  groupOf: (fileId: string) => string | undefined
}

export function layerAssignment(s: State) {
  const world = s.world!
  const v = visibilityOf(s)
  const configured = world.graph.meta.layers
  if (s.options.layering === 'config' && configured?.length) {
    return {
      order: configured,
      labels: undefined as Map<string, string> | undefined,
      layerOf: (n: GraphNode) => n.tags?.find(t => t.startsWith('layer:'))?.slice(6),
    }
  }
  const files = [...v.ids].filter(id => id.startsWith('f:'))
  const areas = [...new Set(files.map(f => world.areaOf.get(f)!))]
  const g = graphOf(s)
  const edges: { source: string; target: string }[] = []
  for (const [a, targets] of g.out)
    for (const b of targets) if (a.startsWith('f:') && b.startsWith('f:')) edges.push({ source: world.areaOf.get(a)!, target: world.areaOf.get(b)! })
  const auto = autoLayers(areas, edges, id => world.node(id)?.path || world.node(id)?.name || id)
  return { order: auto.order, labels: auto.labels, layerOf: (n: GraphNode) => auto.layerOfArea.get(world.areaOf.get(n.id) ?? '') }
}

export function groupingOf(s: State): Grouping | null {
  const world = s.world!
  if (s.options.groupBy === 'community') {
    const g = graphOf(s)
    const files = [...visibilityOf(s).ids].filter(id => id.startsWith('f:'))
    const m = modules(world, g, files)
    return {
      key: `community|${g.key}`,
      groups: m.list.map(x => ({ id: `module:${x.index}`, label: x.label })),
      groupOf: f => (m.of.has(f) ? `module:${m.of.get(f)}` : undefined),
    }
  }
  if (s.options.groupBy === 'custom' && world.graph.meta.groups?.length) {
    const names = [...world.graph.meta.groups, '(ungrouped)']
    return {
      key: `custom|${visibilityOf(s).key}`,
      groups: names.map(name => ({ id: `layer:${name}`, label: name })),
      groupOf: f => `layer:${world.node(f)?.tags?.find(t => t.startsWith('group:'))?.slice(6) ?? '(ungrouped)'}`,
    }
  }
  if (s.options.groupBy === 'feature' && world.graph.meta.features?.length) {
    // the features, most files first; then common code, split by area (shared · lib, shared · components); then the rest
    const v = visibilityOf(s)
    const areaName = (area: string) => world.node(area)?.name ?? area
    const sharedAreas = new Map<string, number>()
    for (const id of v.ids) if (world.node(id)?.tags?.includes('feature-shared')) sharedAreas.set(world.areaOf.get(id)!, (sharedAreas.get(world.areaOf.get(id)!) ?? 0) + 1)
    return {
      key: `feature|${v.key}`,
      groups: [
        ...world.graph.meta.features.map(f => ({ id: featureGroupId(f.name), label: f.name })),
        ...[...sharedAreas].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([area]) => ({ id: `${SHARED_GROUP}${area}`, label: `shared · ${areaName(area)}` })),
        { id: NO_FEATURE_GROUP, label: '(no feature)' },
      ],
      groupOf: f => {
        const n = world.node(f)
        const feature = n?.tags?.find(t => t.startsWith('feature:'))
        if (feature) return featureGroupId(feature.slice(8))
        return n?.tags?.includes('feature-shared') ? `${SHARED_GROUP}${world.areaOf.get(f)}` : NO_FEATURE_GROUP
      },
    }
  }
  if (s.options.groupBy === 'layer') {
    const l = layerAssignment(s)
    return {
      key: `layer|${s.options.layering}|${visibilityOf(s).key}`,
      groups: [...l.order, UNASSIGNED].map(name => ({ id: `layer:${name}`, label: l.labels?.get(name) ?? name })),
      groupOf: f => `layer:${l.layerOf(world.node(f)!) ?? UNASSIGNED}`,
    }
  }
  return null
}

// ── the controller ─────────────────────────────────────────────────────────

export function connect(engine: SceneEngine) {
  let theme = readTheme()
  let layout: Layout | null = null
  let layoutKey = ''
  let floorsKey = ''
  let appliedKey = ''
  let entered: string | null = null
  let travelSeq = -1

  // galaxy positions per visible set and grouping, computed off the main thread
  const galaxies = new Map<string, Record<string, Vec3>>()
  let lastGalaxy: Record<string, Vec3> | undefined
  let pendingGalaxy = ''
  let worker: Worker | undefined
  let request = 0

  // a view plug-in's own 3D content, while it is shown
  let decoration: ViewDecoration | null = null
  let decorationView = ''
  const contextFor = (s: State, grouping: Grouping | null): ViewContext => ({
    s,
    world: s.world!,
    visibility: visibilityOf(s),
    graph: graphOf(s),
    grouping,
    layers: () => layerAssignment(s),
    theme,
    refresh: () => update(store.getState(), undefined),
  })
  /** Background and focus arcs as the view wants them: none, or routed its own way. */
  const arcsFor = (s: State, layout: Layout, background: () => ArcSpec[], focusArcs: ArcSpec[], grouping: Grouping | null): [ArcSpec[], ArcSpec[]] => {
    if (layout.arcs === 'none') return [[], []]
    const plugin = pluginFor(layout.view)
    if (!plugin?.routeArc) return [background(), focusArcs]
    const ctx = contextFor(s, grouping)
    const route = (arcs: ArcSpec[]) => arcs.flatMap(a => plugin.routeArc!(ctx, layout, a) ?? [])
    return [route(background()), route(focusArcs)]
  }

  // semantic zoom: close in, background arcs count only what is near the camera's focus
  let zoom: Zoom | null = null
  let lastFrame: { shown: (id: string) => boolean; focusArcs: ArcSpec[]; grouping: Grouping | null } | null = null
  engine.onCameraSettled = (target, distance) => {
    const s = store.getState()
    const next = { x: target.x, y: target.y, z: target.z, distance }
    const moved = !zoom || Math.abs(Math.log(distance / zoom.distance)) > 0.25 || Math.hypot(target.x - zoom.x, target.y - zoom.y, target.z - zoom.z) > zoom.distance * 0.25
    if (!moved || !layout || !lastFrame || !s.world || s.options.edges !== 'auto') return void (zoom = next)
    zoom = next
    const frame = lastFrame
    const l = layout
    engine.setArcs(...arcsFor(s, l, () => backgroundArcs(s, frame.shown, l, graphOf(s), frame.grouping, zoom), frame.focusArcs, frame.grouping))
  }

  engine.onHover = (hit, x, y) => actions.hover(hit && hit.kind !== 'plane' ? { id: baseId(hit.id), x, y } : null)
  engine.onPick = hit => void actions.select(hit && hit.kind !== 'plane' ? baseId(hit.id) : null)

  const galaxyKey = (s: State, grouping: Grouping | null) => `${visibilityOf(s).key}|${grouping?.key ?? 'area'}|${s.options.timeline ? s.options.at : ''}`

  const runGalaxy = (key: string, input: GalaxyInput) => {
    if (pendingGalaxy === key) return
    pendingGalaxy = key
    const id = ++request
    worker ??= new Worker(new URL('./layouts/galaxy.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; progress?: number; positions?: Record<string, Vec3> }>) => {
      if (e.data.id !== request) return // superseded
      if (e.data.positions) {
        galaxies.set(key, e.data.positions)
        lastGalaxy = e.data.positions
        pendingGalaxy = ''
        store.setState({ task: null }) // re-runs update, which now finds the positions
      } else {
        store.setState({ task: { label: 'Forming the galaxy', progress: e.data.progress ?? 0 } })
      }
    }
    store.setState({ task: { label: 'Forming the galaxy', progress: 0 } })
    worker.postMessage({ id, input })
  }

  const computeLayout = (s: State, grouping: Grouping | null): Layout | undefined => {
    const world = s.world!
    const { isVisible, ids } = visibilityOf(s)
    // on the timeline, City and Layers place everything that ever existed, so nothing moves in time;
    // in watch mode, everything seen since the page loaded, so a save grows a building without moving the rest
    const base = s.options.timeline && s.union ? s.union : s.liveBase
    const nodes = base ?? world.graph.nodes
    const shownThen = (layout: Layout) => (base ? presentIn(layout, world) : layout)
    const plugin = pluginFor(s.options.view)
    if (plugin) return plugin.layout(contextFor(s, grouping))
    if (s.options.view === 'city' || !isKnownView(s.options.view))
      return shownThen(
        grouping
          ? groupedLayout({ nodes, rootId: world.rootId, isVisible, groups: grouping.groups, groupOf: f => grouping.groupOf(f.id) })
          : cityLayout({ nodes, rootId: world.rootId, isVisible }),
      )
    if (s.options.view === 'layers') {
      const l = layerAssignment(s)
      return shownThen(layersLayout({ nodes, rootId: world.rootId, isVisible, order: l.order, layerOf: l.layerOf, labels: l.labels }))
    }
    // galaxy
    const key = galaxyKey(s, grouping)
    const positions = galaxies.get(key)
    if (positions) return galaxyLayout(positions, nodes)
    const g = graphOf(s)
    const links: GalaxyInput['links'] = []
    for (const [a, targets] of g.out) for (const b of targets) links.push({ source: a, target: b })
    runGalaxy(key, {
      nodes: [...ids].map(id => {
        const n = world.node(id)!
        if (n.kind === 'external') return { id, group: 'external', dir: 'external' }
        return { id, group: grouping?.groupOf(id) ?? world.areaOf.get(id) ?? '', dir: n.parent ?? '' }
      }),
      links,
      previous: lastGalaxy,
    })
    return undefined
  }

  const update = (s: State, prev: State | undefined) => {
    const world = s.world
    if (!world) return
    const changed = <K extends keyof State>(...keys: K[]) => !prev || keys.some(k => s[k] !== prev[k])
    const o = s.options

    // 1. layout (a view switch tweens every box to its new place)
    const grouping = o.view === 'layers' ? null : groupingOf(s)
    const plugin = pluginFor(o.view)
    const key = `${o.view}|${visibilityOf(s).key}|${o.view === 'layers' ? o.layering : ''}|${grouping?.key ?? 'dirs'}|${o.timeline && s.union ? 'union' : s.liveBase ? 'live' : ''}|${plugin?.layoutKey?.(contextFor(s, grouping)) ?? ''}`
    const waiting = o.view === 'galaxy' && pendingGalaxy === galaxyKey(s, grouping)
    if ((!layout || key !== layoutKey || changed('world')) && !waiting) {
      const next = computeLayout(s, grouping)
      if (next) {
        const first = !layout
        const viewChanged = layout?.view !== next.view
        layout = next
        layoutKey = key
        floorsKey = ''
        appliedKey = ''
        engine.setLayout(layout, !first)
        if (layout.view !== decorationView) {
          decorationView = layout.view
          decoration = pluginFor(layout.view)?.decoration?.(contextFor(s, grouping), engine) ?? null
          engine.setDecoration(decoration)
        }
        store.setState({ viewStats: statsFor(s, layout) })
        if (!first && viewChanged) {
          const sel = s.selected ? sceneId(s, s.selected, null) : undefined
          if (sel && layout.boxes.has(sel)) engine.flyTo(sel, undefined, true)
          else engine.home()
        }
      }
    }
    if (!layout) return

    // 2. the opened file: the selection's file, drawn as floors (moons in the galaxy)
    const file = s.selected ? fileIdOf(s.selected) : undefined
    const details = file ? s.details[file] : undefined
    const fKey = `${layoutKey}|${file ?? ''}|${details ? 1 : 0}`
    if (fKey !== floorsKey) {
      floorsKey = fKey
      const box = file ? layout.boxes.get(file) : undefined
      entered = box && details ? file! : null
      const how = layout.openFile ?? (layout.view === 'galaxy' ? 'moons' : 'floors')
      if (how === 'none') entered = null
      const open = how === 'moons' ? moonsFor : floorsFor
      engine.setFloors(entered, entered && box && details ? open(box, details.symbols) : null)
    }
    // what the scene has a box for: the layout, plus the open file's floors
    const floorIds = new Set(entered && details ? details.symbols.filter(x => x.kind === 'symbol').map(x => x.id) : [])
    const shown = (id: string) => layout!.boxes.has(id) || floorIds.has(id)

    // 3–6. colors, arcs, selection frame, labels
    if (changed('selected', 'details', 'options', 'world', 'path', 'descriptions', 'changes', 'ask') || fKey !== appliedKey) {
      appliedKey = fKey
      const g = graphOf(s)
      const focus = focusOf(s, shown, layout, g, grouping)
      lastFrame = { shown, focusArcs: focus.arcs, grouping }
      const view = pluginFor(layout.view)
      const ctx = view ? contextFor(s, grouping) : undefined
      const colors = colorsFor(s, layout, focus, theme, grouping)
      view?.colors?.(ctx!, layout, colors)
      engine.setColors(colors)
      const l = layout
      engine.setArcs(...arcsFor(s, l, () => backgroundArcs(s, shown, l, g, grouping, zoom), focus.arcs, grouping))
      engine.setSelection(s.selected ? (sceneId(s, s.selected, entered) ?? null) : null)
      engine.setLabels([...labelsFor(s, layout, focus), ...(view?.labels?.(ctx!, layout) ?? [])])
      if (ctx) decoration?.update?.(ctx, layout)
    }
    if (changed('hovered')) engine.setHovered(s.hovered ? (sceneId(s, s.hovered.id, entered) ?? null) : null)

    // 7. camera trips
    if (s.travel && s.travel.seq !== travelSeq) {
      travelSeq = s.travel.seq
      const v = violationOf(s, s.travel.to)
      const to = travelTarget(s, s.travel.to, entered)
      const from = s.travel.from ? sceneId(s, s.travel.from, entered) : undefined
      const changedIds = (s.travel.to === CHANGES_ID ? changedFileIds(s) : s.travel.to === ANSWER_ID ? [...new Set((s.ask.answer?.nodes ?? []).map(n => answerSceneId(n.id)))] : []).filter(id => layout!.boxes.has(id))
      if (v) engine.frameAll([...new Set(violationNodes(v))], innerWidth > 760 ? INSPECTOR_WIDTH : 0)
      else if (changedIds.length) engine.frameAll(changedIds, innerWidth > 760 ? INSPECTOR_WIDTH : 0)
      else if (to) engine.flyTo(to, from && from !== to ? from : undefined)
    }
  }

  store.subscribe(update)
  update(store.getState(), undefined)

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    theme = readTheme()
    engine.setTheme(theme)
    appliedKey = ''
    update(store.getState(), undefined)
  })
}

/**
 * A layout of the timeline's union, cut down to what exists in `world`: the
 * rest sinks, and buildings take that time's height.
 */
function presentIn(layout: Layout, world: World): Layout {
  for (const [id, placement] of [...layout.placement]) {
    if (placement === 'plane' || placement === 'cluster') continue
    const base = baseId(id)
    if (isGroupId(base)) continue
    const n = world.node(base)
    if (!n) {
      layout.boxes.delete(id)
      layout.placement.delete(id)
      layout.depth.delete(id)
    } else if (placement === 'building') layout.boxes.set(id, { ...layout.boxes.get(id)!, h: buildingHeight(n.metrics?.loc ?? 0) })
  }
  return layout
}

/** The scene object that stands for a node: its floor, its building or star, its district. */
export function sceneId(s: State, id: string, entered: string | null): string | undefined {
  const file = fileIdOf(id)
  if (file && file === entered && id !== file) {
    const n = findNode(s, id)
    // members live on their class's floor
    return n?.kind === 'member' ? n.parent : id
  }
  return file ?? id
}

/** Where the camera goes for a selection; a cycle is visited at its first file. */
function travelTarget(s: State, id: string, entered: string | null) {
  if (id.startsWith('cycle:')) return s.world!.graph.meta.cycles[Number(id.slice(6))]?.[0]
  return sceneId(s, id, entered)
}

/** The inspector's width and margin (styles.css), which covers the scene's right side. */
const INSPECTOR_WIDTH = 412

// ── focus: what to keep bright and which arcs to draw ──────────────────────

interface Focus {
  /** Scene ids to keep bright; null = no selection, everything bright. */
  related: Set<string> | null
  arcs: ArcSpec[]
  neighbors: string[]
}

/** Layers view: an edge from a lower layer to a higher one points the wrong way. */
function pointsUp(layout: Layout, source: string, target: string) {
  const a = layout.layerIndex?.get(fileIdOf(source) ?? source)
  const b = layout.layerIndex?.get(fileIdOf(target) ?? target)
  return a !== undefined && b !== undefined && b < a
}

/** The file (or package) a path end stands for. */
export const pathEnd = (s: State, id: string) => {
  const n = findNode(s, id)
  return n?.kind === 'external' ? id : fileIdOf(id)
}

type AddArc = (source: string, target: string, colors: readonly [THREE.Color, THREE.Color]) => void

/**
 * What the files in `start` use and what uses them (`dir`), `depth` steps out, as arcs fading with
 * the steps (reachEdges: each start file's own, then one way on to each file further); the files
 * reached join `related`, the first step's `firstStep`.
 */
function addReach(g: DepGraph, start: string[], dir: FocusDir, depth: number, related: Set<string>, addArc: AddArc, firstStep?: string[]) {
  const { edges, reached, first } = reachEdges(g, start, dir, depth)
  reached.forEach(id => related.add(id))
  firstStep?.push(...first)
  const fade = (base: string, depth: number) => new THREE.Color(base).multiplyScalar(Math.max(0.35, 1 - (depth - 1) * 0.22))
  for (const e of edges) addArc(e.source, e.target, e.dir === 'out' ? [fade(OUT_COLOR, e.depth), fade(OUT_COLOR, e.depth + 1)] : [fade(IN_COLOR, e.depth + 1), fade(IN_COLOR, e.depth)])
}

/** The dependencies among the files of a set (addReach leaves them out: it starts from all of them). */
function addBetween(g: DepGraph, files: string[], addArc: AddArc) {
  const inSet = new Set(files)
  const color = [new THREE.Color(OUT_COLOR), new THREE.Color(IN_COLOR)] as const
  for (const f of files) for (const t of g.out.get(f) ?? []) if (t !== f && inSet.has(t)) addArc(f, t, color)
}

function focusOf(s: State, shown: (id: string) => boolean, layout: Layout, g: DepGraph, grouping: Grouping | null): Focus {
  const world = s.world!
  let arcsOn = s.options.edges !== 'none'
  const related = new Set<string>()
  const arcs: ArcSpec[] = []
  const neighbors: string[] = []
  const up = [new THREE.Color(UP_COLOR), new THREE.Color(UP_COLOR)] as const
  const addArc: AddArc = (source, target, colors) => {
    if (!arcsOn || arcs.length >= MAX_FOCUS_ARCS || !shown(source) || !shown(target)) return
    const c = pointsUp(layout, source, target) ? up : colors
    arcs.push({ source, target, from: c[0], to: c[1] })
  }

  // the path finder wins while it has both ends
  if (s.path?.to) {
    const a = pathEnd(s, s.path.from)
    const b = pathEnd(s, s.path.to)
    if (a && b) {
      const { paths } = pathsBetween(g, a, b)
      const color = [new THREE.Color(PATH_COLOR), new THREE.Color(PATH_COLOR)] as const
      const seen = new Set<string>()
      for (const p of paths) {
        p.forEach(n => related.add(n))
        for (let i = 1; i < p.length; i++) {
          const k = `${p[i - 1]}\u0000${p[i]}`
          if (seen.has(k)) continue
          seen.add(k)
          addArc(p[i - 1], p[i], color)
        }
      }
      related.add(a).add(b)
      return { related, arcs, neighbors: [...related] }
    }
  }

  if (!s.selected) return { related: null, arcs, neighbors }
  const sel = s.selected

  if (sel.startsWith('cycle:')) {
    const members = world.graph.meta.cycles[Number(sel.slice(6))] ?? []
    const inCycle = new Set(members)
    const color = [new THREE.Color(CYCLE_COLOR), new THREE.Color(CYCLE_COLOR).multiplyScalar(0.7)] as const
    for (const m of members) {
      related.add(m)
      for (const t of g.out.get(m) ?? []) if (inCycle.has(t)) addArc(m, t, color)
    }
    return { related, arcs, neighbors: members }
  }
  const v = violationOf(s, sel)
  if (v) {
    const on = violationNodes(v)
    const color = [new THREE.Color(VIOLATION_COLOR).multiplyScalar(0.75), new THREE.Color(VIOLATION_COLOR)] as const
    on.forEach(id => related.add(id))
    // the pair itself, or each step of the path (a cycle's path comes back to its start)
    for (let i = 1; i < on.length; i++) if (on[i] !== on[i - 1]) addArc(on[i - 1], on[i], color)
    return { related, arcs, neighbors: [...new Set(on)] }
  }
  // an answer: the nodes it is about bright, its walkthrough drawn step to step
  if (sel === ANSWER_ID) {
    const answer = s.ask.answer
    if (!answer) return { related: null, arcs, neighbors }
    const color = [new THREE.Color(PATH_COLOR), new THREE.Color(PATH_COLOR)] as const
    const visible = visibilityOf(s).ids
    for (const n of answer.nodes) {
      const id = answerSceneId(n.id)
      related.add(id)
      if (id.startsWith('d:')) for (const d of world.index.descendants(id)) if (visible.has(d.id)) related.add(d.id)
    }
    const steps = answer.steps.map(x => answerSceneId(x.id))
    for (let i = 1; i < steps.length; i++) if (steps[i] !== steps[i - 1]) addArc(steps[i - 1], steps[i], color)
    return { related, arcs, neighbors: [...new Set(answer.nodes.map(n => answerSceneId(n.id)))].filter(shown) }
  }
  // the Changes panel: the changed files bright with the dependencies among them, or every one they have (its
  // own switch, not the Focus bar's: one step, both ways); the rest ghosted
  if (sel === CHANGES_ID) {
    if (s.options.edges === 'violations') arcsOn = false
    const changed = changedFileIds(s).filter(shown)
    changed.forEach(id => related.add(id))
    addBetween(g, changed, addArc)
    if (s.options.changeEdges === 'all') addReach(g, changed, 'both', 1, related, addArc)
    return { related, arcs, neighbors: changed.slice(0, MAX_NEIGHBOR_LABELS) }
  }
  if (isGroupId(sel)) {
    for (const id of visibilityOf(s).ids) if (grouping?.groupOf(id) === sel) related.add(id)
    related.add(sel)
    return { related, arcs, neighbors }
  }

  const node = findNode(s, sel)
  if (!node) return { related: null, arcs, neighbors }
  // only the violations are drawn: a selected node's own violations light up among them (backgroundArcs)
  if (s.options.edges === 'violations') arcsOn = false

  if (node.kind === 'directory' || node.kind === 'file' || node.kind === 'external') {
    // focus: what it uses and/or what uses it, `focusDepth` steps out
    const visible = visibilityOf(s).ids
    const start = node.kind === 'directory' ? world.index.descendants(node.id).filter(d => visible.has(d.id)).map(d => d.id) : [node.id]
    related.add(node.id)
    start.forEach(id => related.add(id))
    addReach(g, start, s.options.focusDir, s.options.focusDepth, related, addArc, neighbors)
    // files that change with it (git), the ones it has no dependency with brighter
    if (s.options.coChange && node.kind === 'file')
      for (const p of world.coChanges(node.id)) {
        if (!shown(p.other)) continue
        related.add(p.other)
        neighbors.push(p.other)
        const c = new THREE.Color(CO_CHANGE_COLOR).multiplyScalar(p.depends ? 0.55 : 1)
        addArc(node.id, p.other, [c, c])
      }
    return { related, arcs, neighbors }
  }

  // a symbol or member: its references, from its floor to the other ends' buildings
  const target = s.options.target
  const file = fileIdOf(node.id)!
  const details = s.details[file]
  related.add(file)
  if (!details) return { related, arcs, neighbors }
  const out = [new THREE.Color(OUT_COLOR), new THREE.Color(OUT_COLOR).multiplyScalar(0.55)] as const
  const inc = [new THREE.Color(IN_COLOR).multiplyScalar(0.55), new THREE.Color(IN_COLOR)] as const
  const kinds = s.options.kinds.length ? new Set(s.options.kinds) : null
  const group = new Set([node.id, ...(node.kind === 'symbol' ? details.symbols.filter(m => m.parent === node.id).map(m => m.id) : [])])
  const seen = new Set<string>()
  for (const e of details.edges) {
    if (!e.targets.includes(target) || (kinds && !kinds.has(e.kind))) continue
    const outgoing = group.has(e.source)
    if (!outgoing && !group.has(e.target)) continue
    const own = sceneId(s, outgoing ? e.source : e.target, file)!
    const other = sceneId(s, outgoing ? e.target : e.source, file)!
    if (!other || other === own) continue
    const key = `${outgoing ? 'o' : 'i'}${other}`
    if (seen.has(key)) continue
    seen.add(key)
    related.add(other)
    neighbors.push(other)
    if (outgoing) addArc(own, other, out)
    else addArc(other, own, inc)
  }
  return { related, arcs, neighbors }
}

// ── background arcs: level of detail and bundling ──────────────────────────

interface Zoom {
  x: number
  y: number
  z: number
  distance: number
}

/**
 * Background arcs at the finest level that stays under the limit. Zoomed in
 * (camera nearer than the layout is wide), only dependencies with an end near
 * the focus point count, so the level gets finer as the camera gets closer.
 */
function backgroundArcs(s: State, shown: (id: string) => boolean, layout: Layout, g: DepGraph, grouping: Grouping | null, zoom: Zoom | null = null): ArcSpec[] {
  const mode = s.options.edges
  if (mode === 'none' || mode === 'selection') return []
  if (mode === 'violations') return violationArcs(s, layout)
  // auto: a selection (or a found path) shows its own connections, drawn as focus arcs, and
  // nobody else's; only a group (a detected module, a layer, a feature), which has no arcs of its own, keeps them
  if (mode === 'auto' && (s.path?.to || (s.selected && !isGroupId(s.selected)))) return []
  const world = s.world!
  const near =
    mode === 'auto' && zoom && zoom.distance < layout.size * 0.9
      ? (id: string) => {
          const b = layout.boxes.get(id)
          return !!b && Math.hypot(b.x - zoom.x, b.y + b.h / 2 - zoom.y, b.z - zoom.z) < zoom.distance * 0.9
        }
      : () => true
  const files: { source: string; target: string; count: number }[] = []
  for (const [a, targets] of g.weight)
    for (const [b, count] of targets)
      if (shown(a) && shown(b) && a.startsWith('f:') && b.startsWith('f:') && (near(a) || near(b))) files.push({ source: a, target: b, count })
  let pairs = files
  const limit = mode === 'all' ? Infinity : AUTO_EDGE_LIMIT
  if (pairs.length > limit) {
    // fold into groups, or into directories as deep as the limit allows
    const lifts: ((id: string) => string)[] = grouping
      ? [id => grouping.groupOf(id) ?? id]
      : [...Array(maxDirDepth(world)).keys()].reverse().map(depth => (id: string) => {
          const dirs = world.index.ancestors(id).reverse() // root first
          return dirs.length > depth + 1 ? dirs[depth + 1].id : id
        })
    for (const lift of lifts) {
      const folded = new Map<string, { source: string; target: string; count: number }>()
      for (const p of files) {
        const a = lift(p.source)
        const b = lift(p.target)
        if (a === b || !layout.boxes.has(a) || !layout.boxes.has(b)) continue
        const k = `${a}\u0000${b}`
        const f = folded.get(k)
        if (f) f.count += p.count
        else folded.set(k, { source: a, target: b, count: p.count })
      }
      pairs = [...folded.values()]
      if (pairs.length <= limit) break
    }
  }
  // widths by weight: the top tenth thick, the next third medium
  const sorted = pairs.map(p => p.count).sort((a, b) => b - a)
  const thick = sorted[Math.floor(sorted.length * 0.1)] ?? Infinity
  const medium = sorted[Math.floor(sorted.length * 0.4)] ?? Infinity
  const from = new THREE.Color(OUT_COLOR).multiplyScalar(0.45)
  const to = new THREE.Color(IN_COLOR).multiplyScalar(0.45)
  const upColor = new THREE.Color(UP_COLOR)
  const bundle = s.options.bundle && !grouping && layout.view !== 'layers'
  return pairs.map(p => {
    const up = pointsUp(layout, p.source, p.target)
    const width: 1 | 2 | 3 = pairs.length < 3 ? 2 : p.count >= thick ? 3 : p.count >= medium ? 2 : 1
    const arc: ArcSpec = { source: p.source, target: p.target, from: up ? upColor : from, to: up ? upColor : to, width }
    if (bundle) arc.via = treePath(world, p.source, p.target).filter(id => layout.boxes.has(id))
    return arc
  })
}

/**
 * Edges → violations: every dependency that breaks a rule in the target shown,
 * each step of a reach path or cycle; red, brighter at the file that imports
 * what it shouldn't. With a node selected, its own stay bright and the rest dim.
 */
function violationArcs(s: State, layout: Layout): ArcSpec[] {
  const world = s.world!
  const sel = s.selected && !violationOf(s, s.selected) ? s.selected : null
  const selFile = sel ? fileIdOf(sel) : undefined
  const mine = (id: string) => !sel || id === sel || id === selFile || (sel.startsWith('d:') && world.index.ancestors(id).some(d => d.id === sel))
  const bright = new THREE.Color(VIOLATION_COLOR)
  const dim = bright.clone().multiplyScalar(0.3)
  const bundle = s.options.bundle && layout.view !== 'layers'
  const seen = new Set<string>()
  const arcs: ArcSpec[] = []
  for (const v of world.graph.meta.violations ?? []) {
    if (!v.targets.includes(s.options.target)) continue
    const on = violationNodes(v)
    const lit = on.some(mine)
    for (let i = 1; i < on.length; i++) {
      const [a, b] = [on[i - 1], on[i]]
      const k = `${a}\u0000${b}`
      if (a === b || seen.has(k) || !layout.boxes.has(a) || !layout.boxes.has(b)) continue
      seen.add(k)
      const c = lit ? bright : dim
      const arc: ArcSpec = { source: a, target: b, from: c.clone().multiplyScalar(i === 1 ? 1 : 0.75), to: c, width: lit && sel ? 3 : 2 }
      if (bundle) arc.via = treePath(world, a, b).filter(id => layout.boxes.has(id))
      arcs.push(arc)
    }
  }
  return arcs
}

/** The containers between two nodes: up from a to their common ancestor, then down to b. */
function treePath(world: World, a: string, b: string): string[] {
  const up = world.index.ancestors(a).map(n => n.id)
  const down = world.index.ancestors(b).map(n => n.id)
  const common = up.find(id => down.includes(id))
  if (common === undefined) return []
  return [...up.slice(0, up.indexOf(common) + 1), ...down.slice(0, down.indexOf(common)).reverse()]
}

const depthMemo = new WeakMap<World, number>()
function maxDirDepth(world: World) {
  let d = depthMemo.get(world)
  if (d === undefined) {
    d = 1
    for (const n of world.graph.nodes) if (n.kind === 'directory' && n.path) d = Math.max(d, n.path.split('/').length)
    depthMemo.set(world, d)
  }
  return d
}

/** Layers view: how many file dependencies point up, the ones to look at first. */
function statsFor(s: State, layout: Layout): State['viewStats'] {
  // a view that never opens a file into floors has no symbol kinds to explain
  if (layout.openFile === 'none') return { closedFiles: true }
  if (layout.view !== 'layers') return null
  const g = graphOf(s)
  let upward = 0
  for (const [a, targets] of g.out) for (const b of targets) if (pointsUp(layout, a, b)) upward++
  return { upward, layers: [...layout.placement.values()].filter(p => p === 'plane').length }
}

// ── colors and labels ──────────────────────────────────────────────────────

function colorsFor(s: State, layout: Layout, focus: Focus, theme: Theme, grouping: Grouping | null): Map<string, THREE.Color> {
  const world = s.world!
  const colors = new Map<string, THREE.Color>()
  const ghost = new THREE.Color(theme.background)
  const gray = new THREE.Color(NEUTRAL)
  const areaColor = new Map(areaOrder(s).map((a, i) => [a.id, new THREE.Color(AREA_PALETTE[i % AREA_PALETTE.length])]))
  const groupIndex = new Map(grouping?.groups.map((g, i) => [g.id, i]))
  const cycleIndex = new Map<string, number>()
  world.graph.meta.cycles.forEach((c, i) => c.forEach(id => cycleIndex.set(id, i)))
  const colorBy = s.options.colorBy
  // violations: the file to fix (the importer) is brightest; the rest of a path dimmer
  const broken = new Map<string, number>() // id → 2 importer of an error, 1 on an error's path; warnings -2/-1
  if (colorBy === 'violations')
    for (const v of world.graph.meta.violations ?? []) {
      const on = violationNodes(v)
      const fix = fixAt(v)
      for (const id of on) {
        const level = (id === fix ? 2 : 1) * (v.severity === 'error' ? 1 : -1)
        const had = broken.get(id)
        // errors win over warnings, the importer over the path
        if (had === undefined || Math.sign(level) > Math.sign(had) || (Math.sign(level) === Math.sign(had) && Math.abs(level) > Math.abs(had))) broken.set(id, level)
      }
    }
  const metric = RANKED[colorBy]
  const rank = new Map<string, number>()
  if (metric) {
    // by rank, so a few giants don't wash the rest out; files never committed stay grey for `age`
    const files = [...layout.placement].filter(([id, p]) => p === 'building' && world.node(id)?.metrics?.[metric] !== undefined).map(([id]) => id)
    const values = files.map(id => world.node(id)!.metrics![metric]).sort((a, b) => a - b)
    for (const id of files) {
      const v = world.node(id)!.metrics![metric]
      rank.set(id, values.length > 1 ? lowerBound(values, v) / (values.length - 1) : 0)
    }
  }
  const before = colorBy === 'change' ? previousWorld(s) : undefined
  // the change in progress: what each changed file is, and the worst of what the diff found in it
  const changedStatus = new Map(colorBy === 'changes' ? (s.changes.report?.files ?? []).map(f => [`f:${f.path}`, f.status]) : [])
  const findings = colorBy === 'changes' && s.changes.report ? findingsByFile(s.changes.report.diff) : new Map()
  const district = new THREE.Color(theme.district)
  const palette = (i: number) => new THREE.Color(AREA_PALETTE[i % AREA_PALETTE.length])
  for (const [id, placement] of layout.placement) {
    if (placement === 'cluster') continue
    const n = world.node(id)
    let c: THREE.Color
    if (placement === 'plane') {
      c = district.clone().offsetHSL(0, 0, 0.08)
    } else if (placement === 'district') {
      const depth = layout.depth.get(id) ?? 0
      c = district.clone().offsetHSL(0, 0, depth * 0.03)
      if (groupIndex.has(id) && colorBy === 'group') c.lerp(palette(groupIndex.get(id)!), 0.25)
      if (focus.related && s.selected === baseId(id)) c.offsetHSL(0, 0, 0.12)
    } else if (placement === 'external') {
      c = gray.clone().multiplyScalar(0.8)
    } else {
      if (n?.tags?.includes('asset')) c = gray.clone()
      else if (colorBy === 'group' && grouping) c = palette(groupIndex.get(grouping.groupOf(id) ?? '') ?? 0)
      else if (colorBy === 'cycles')
        c = cycleIndex.has(id) ? palette(cycleIndex.get(id)!).lerp(new THREE.Color(CYCLE_COLOR), 0.3) : gray.clone().lerp(ghost, 0.5)
      else if (metric) c = rank.has(id) ? new THREE.Color(heat(rank.get(id)!)) : gray.clone().lerp(ghost, 0.5)
      else if (colorBy === 'change') {
        const was = before?.node(id)?.metrics?.loc
        const is = n?.metrics?.loc ?? 0
        c =
          !before || was === is
            ? gray.clone().lerp(ghost, 0.5)
            : was === undefined
              ? new THREE.Color(ADDED_COLOR)
              : new THREE.Color(is > was ? GROWN_COLOR : SHRUNK_COLOR).multiplyScalar(0.55 + 0.45 * Math.min(1, Math.abs(is - was) / Math.max(40, was)))
      }
      else if (colorBy === 'changes') {
        const status = changedStatus.get(id)
        const tone = worstTone(findings.get(n?.path ?? ''))
        c =
          tone === 'error'
            ? new THREE.Color(VIOLATION_COLOR)
            : tone === 'warn'
              ? new THREE.Color(WARNING_COLOR)
              : status === 'added'
                ? new THREE.Color(ADDED_COLOR)
                : status
                  ? new THREE.Color(GROWN_COLOR)
                  : gray.clone().lerp(ghost, 0.5)
      } else if (colorBy === 'violations') {
        const level = broken.get(id)
        c =
          level === undefined
            ? gray.clone().lerp(ghost, 0.5)
            : new THREE.Color(VIOLATION_COLOR).multiplyScalar(Math.abs(level) === 2 ? 1 : 0.6)
      }
      // untested red, reached by many tests blue
      else if (colorBy === 'tests') c = new THREE.Color(heat(1 - Math.min(1, Math.log2(1 + (n?.metrics?.testReach ?? 0)) / 4)))
      else c = (areaColor.get(world.areaOf.get(id) ?? '') ?? gray).clone()
      if (n?.tags?.includes('test')) c.lerp(gray, 0.55)
    }
    if (placement !== 'district' && placement !== 'plane' && focus.related && !focus.related.has(id)) c.lerp(ghost, 0.8)
    if (id === s.selected && placement !== 'district') c.lerp(new THREE.Color('#ffffff'), 0.45)
    colors.set(id, c)
  }
  // floors (or moons) of the opened file
  const file = s.selected ? fileIdOf(s.selected) : undefined
  const details = file ? s.details[file] : undefined
  if (details) {
    const selectedFloor = sceneId(s, s.selected!, file!)
    for (const sym of details.symbols) {
      if (sym.kind !== 'symbol') continue
      const c = new THREE.Color(SUBKIND_COLORS[sym.subkind ?? ''] ?? NEUTRAL)
      if (sym.id === selectedFloor) c.lerp(new THREE.Color('#ffffff'), 0.5)
      else if (selectedFloor !== file) c.multiplyScalar(0.7)
      colors.set(sym.id, c)
    }
  }
  return colors
}

/** Heat colors: which metric each ranks files by. */
const RANKED: Partial<Record<State['options']['colorBy'], string>> = {
  complexity: 'complexity',
  fanIn: 'fanIn',
  churn: 'churn',
  hotspot: 'hotspot',
  age: 'lastCommit',
}

function labelsFor(s: State, layout: Layout, focus: Focus): LabelSpec[] {
  const world = s.world!
  const specs: LabelSpec[] = []
  for (const [id, placement] of layout.placement) {
    if (placement === 'plane') {
      specs.push({ id, text: layout.names?.get(id) ?? id, priority: 950, className: 'plane' })
      continue
    }
    if (placement !== 'district' && placement !== 'cluster') continue
    const depth = layout.depth.get(id) ?? 0
    const maxDepth = placement === 'cluster' ? 2 : 4
    if (depth < 1 || depth > maxDepth) continue
    const group = isGroupId(id)
    const code = layout.names?.get(id) ?? world.node(baseId(id))?.name ?? id
    const text = labelOf(s, baseId(id), code)
    specs.push({ id, text, priority: folderPriority(depth, group ? 'group' : text !== code ? 'named' : 'plain'), className: group ? 'group' : `district d${depth}`, minScreenWidth: group ? 30 : 60 })
  }
  for (const [id, p] of layout.placement)
    if (p === 'external' && (s.options.externals || world.node(id)?.tags?.includes('infra'))) specs.push({ id, text: labelOf(s, id, world.node(id)?.name ?? id), priority: 120, className: 'external' })
  // an answer's walkthrough numbers its stops
  const stops = s.selected === ANSWER_ID ? (s.ask.answer?.steps ?? []).map(x => answerSceneId(x.id)) : []
  for (const id of focus.neighbors.slice(0, MAX_NEIGHBOR_LABELS)) {
    const name = labelOf(s, id, findNode(s, id)?.name ?? id)
    const at = stops.flatMap((x, i) => (x === id ? [i + 1] : []))
    specs.push({ id, text: at.length ? `${at.join(', ')} · ${name}` : name, priority: at.length ? 650 : 600, className: 'neighbor' })
  }
  const file = s.selected ? fileIdOf(s.selected) : undefined
  const details = file ? s.details[file] : undefined
  if (details) for (const sym of details.symbols) if (sym.kind === 'symbol') specs.push({ id: sym.id, text: labelOf(s, sym.id, sym.name), priority: 700, className: 'floor' })
  if (s.selected) {
    const n = findNode(s, s.selected)
    const id = file && details ? sceneId(s, s.selected, file) : s.selected
    if (n && id) specs.push({ id, text: labelOf(s, n.id, n.name), priority: 1000, className: 'selected' })
  }
  return specs
}

function lowerBound(sorted: number[], v: number) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}
