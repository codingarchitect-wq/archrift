// The panels around the 3D scene: toolbar, breadcrumbs, inspector, source,
// legend, tooltip, and the loading/error overlay.
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { fileIdOf } from '../../core/ids.ts'
import {
  ADDED_COLOR,
  AREA_PALETTE,
  CO_CHANGE_COLOR,
  CYCLE_COLOR,
  GROWN_COLOR,
  IN_COLOR,
  OUT_COLOR,
  PATH_COLOR,
  SHRUNK_COLOR,
  SUBKIND_COLORS,
  UP_COLOR,
  VIOLATION_COLOR,
  WARNING_COLOR,
  heat,
} from '../colors.ts'
import { groupingOf } from '../controller.ts'
import { actions, areaOrder, describedOf, findNode, store } from '../store.ts'
import { api } from '../api.ts'
import { HelpDialog, Onboarding } from './Help.tsx'
import { Inspector, displayName } from './Inspector.tsx'
import { SourcePeek } from './SourcePeek.tsx'
import { TOOLBAR_ENTRIES, pluginFor, viewForEntry } from '../views/registry.ts'
import { Toolbar } from './Toolbar.tsx'
import { PathPanel, Timeline } from './Tools.tsx'

export function App() {
  const status = useStore(store, s => s.status)
  const error = useStore(store, s => s.error)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement
      if (e.altKey && e.key === 'ArrowLeft') actions.goBack()
      else if (e.altKey && e.key === 'ArrowRight') actions.goForward()
      else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key) && Number(e.key) <= TOOLBAR_ENTRIES.length)
        actions.setOption('view', viewForEntry(TOOLBAR_ENTRIES[Number(e.key) - 1], store.getState().options.view))
      else if (!typing && e.key === '?') actions.setHelp(!store.getState().help)
      else if (!typing && e.key === '/' && api.capabilities.ask && store.getState().info?.ask) actions.openAsk()
      else if (e.key === 'Escape' && !typing) {
        if (store.getState().help) actions.setHelp(false)
        else if (store.getState().source) actions.closeSource()
        else if (store.getState().path) actions.clearPath()
        else actions.select(null)
      } else return
      e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <Toolbar>
        <Breadcrumbs />
      </Toolbar>
      <Inspector />
      <SourcePeek />
      <PathPanel />
      <Timeline />
      <Legend />
      <Onboarding />
      <HelpDialog />
      <Tooltip />
      <Task />
      {status !== 'ready' && (
        <div className="overlay" role="status">
          {status === 'loading' ? 'Loading the city…' : `Could not load the graph: ${error}`}
        </div>
      )}
    </>
  )
}

export function Breadcrumbs() {
  // select plain state (a derived array would be a new object every call)
  const selected = useStore(store, s => s.selected)
  useStore(store, s => s.details)
  const s = store.getState()
  const node = selected ? findNode(s, selected) : undefined
  if (!node) return null
  const crumbs = [node]
  for (let p = node.parent ? findNode(s, node.parent) : undefined; p; p = p.parent ? findNode(s, p.parent) : undefined) crumbs.unshift(p)
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      {crumbs.map((c, i) => (
        <span key={c.id}>
          {i > 0 && <span className="sep">›</span>}
          <button onClick={() => actions.select(c.id)} aria-current={i === crumbs.length - 1 ? 'location' : undefined}>
            {c.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

function Legend() {
  const world = useStore(store, s => s.world)
  const view = useStore(store, s => s.options.view)
  // a view plug-in may bring its own key (or none)
  const plugin = pluginFor(view)
  const own = plugin && 'Legend' in plugin
  const OwnKey = plugin?.Legend
  const colorBy = useStore(store, s => s.options.colorBy)
  const edges = useStore(store, s => s.options.edges)
  // dependencies only: a limit's or a requireReach's violation is about one file
  const violations = useStore(store, s => s.world?.graph.meta.violations?.filter(v => !v.measure && !v.expects && v.targets.includes(s.options.target)).length ?? 0)
  const tests = useStore(store, s => s.options.tests)
  const upward = useStore(store, s => s.viewStats?.upward)
  const layering = useStore(store, s => s.options.layering)
  // what the configured `layers: "down"` rule reports, which looks at imports only
  const importsUp = useStore(store, s => {
    const rule = s.world?.graph.meta.rules?.find(r => r.kind === 'layers')
    return rule ? (s.world?.graph.meta.violations ?? []).filter(v => v.rule === rule.name).length : undefined
  })
  const pathOn = useStore(store, s => !!s.path?.to)
  const coChange = useStore(store, s => s.options.coChange && !!s.selected?.startsWith('f:'))
  const windowDays = useStore(store, s => s.now?.graph.meta.history?.windowDays ?? 90)
  useStore(store, s => s.options)
  const grouping = world && colorBy === 'group' && store.getState().options.view !== 'layers' ? groupingOf(store.getState()) : null
  const floorKinds = useStore(store, s => {
    if (s.viewStats?.closedFiles) return ''
    const file = s.selected ? fileIdOf(s.selected) : undefined
    const d = file ? s.details[file] : undefined
    return d ? [...new Set(d.symbols.filter(x => x.kind === 'symbol').map(x => x.subkind ?? ''))].sort().join(',') : ''
  })
  if (!world) return null
  // areas in view (colors stay tied to the area's rank, so they don't shift when tests toggle)
  const shown = new Set<string>()
  for (const [file, area] of world.areaOf) if (tests || !world.node(file)?.tags?.includes('test')) shown.add(area)
  return (
    <aside className="panel legend" aria-label="Legend">
      {own ? (
        OwnKey ? (
          <OwnKey />
        ) : null
      ) : colorBy === 'group' && grouping ? (
        <div className="swatches">
          {grouping.groups.slice(0, 10).map((g, i) => (
            <span key={g.id}>
              <i style={{ background: AREA_PALETTE[i % AREA_PALETTE.length] }} />
              {g.label}
            </span>
          ))}
        </div>
      ) : colorBy === 'cycles' ? (
        <div className="swatches">
          <span>
            <i style={{ background: CYCLE_COLOR }} />
            {world.graph.meta.cycles.length} import cycles, one color each; other files grey
          </span>
        </div>
      ) : colorBy === 'violations' ? (
        <div className="swatches">
          <span>
            <i style={{ background: VIOLATION_COLOR }} />
            breaks a rule (an error or a warning)
          </span>
          <span className="dim">bright: the file that imports it · dim: the rest of the path</span>
        </div>
      ) : colorBy === 'area' || colorBy === 'group' ? (
        <div className="swatches">
          {areaOrder(store.getState())
            .map((a, i) => ({ a, color: AREA_PALETTE[i % AREA_PALETTE.length] }))
            .filter(({ a }) => shown.has(a.id))
            .slice(0, 10)
            .map(({ a, color }) => (
              <span key={a.id}>
                <i style={{ background: color }} />
                {a.path || a.name}
              </span>
            ))}
        </div>
      ) : colorBy === 'changes' ? (
        <div className="swatches">
          <span>
            <i style={{ background: ADDED_COLOR }} />
            new
          </span>
          <span>
            <i style={{ background: GROWN_COLOR }} />
            changed
          </span>
          <span>
            <i style={{ background: WARNING_COLOR }} />
            the diff warns
          </span>
          <span>
            <i style={{ background: VIOLATION_COLOR }} />
            breaks a rule, a new cycle
          </span>
          <span className="dim">since {store.getState().changes.report?.base.label ?? 'the base'} (Changes in the toolbar)</span>
        </div>
      ) : colorBy === 'change' ? (
        <div className="swatches">
          <span>
            <i style={{ background: ADDED_COLOR }} />
            new
          </span>
          <span>
            <i style={{ background: GROWN_COLOR }} />
            grew
          </span>
          <span>
            <i style={{ background: SHRUNK_COLOR }} />
            shrank
          </span>
          <span className="dim">since the previous point on the timeline</span>
        </div>
      ) : (
        <div className="heat">
          <span>{heatLabels(colorBy, windowDays)[0]}</span>
          <i style={{ background: `linear-gradient(90deg, ${heat(0)}, ${heat(0.5)}, ${heat(1)})` }} />
          <span>{heatLabels(colorBy, windowDays)[1]}</span>
        </div>
      )}
      {floorKinds && (
        <div className="swatches">
          {floorKinds.split(',').map(k => (
            <span key={k}>
              <i style={{ background: SUBKIND_COLORS[k] }} />
              {k}
            </span>
          ))}
        </div>
      )}
      <div className="swatches">
        {!own && edges === 'violations' && (
          <span>
            <i style={{ background: VIOLATION_COLOR }} />
            only the dependencies that break a rule{violations ? ` (${violations})` : ''}; a selection’s own bright
          </span>
        )}
        {!own && edges !== 'violations' && (
          <>
            <span>
              <i style={{ background: OUT_COLOR }} />
              uses
            </span>
            <span>
              <i style={{ background: IN_COLOR }} />
              used by
            </span>
          </>
        )}
        {pathOn && (
          <span>
            <i style={{ background: PATH_COLOR }} />
            path
          </span>
        )}
        {coChange && (
          <span>
            <i style={{ background: CO_CHANGE_COLOR }} />
            changes with it
          </span>
        )}
        {upward !== undefined && (
          <span title="Any kind of dependency counts here (calls, tRPC calls, links …); the layers rule counts imports only">
            <i style={{ background: UP_COLOR }} />
            points up: {upward.toLocaleString('en-US')} file dependencies
            {importsUp !== undefined && layering === 'config' ? ` (imports alone: ${importsUp})` : ''}
          </span>
        )}
      </div>
    </aside>
  )
}

function Task() {
  const task = useStore(store, s => s.task)
  if (!task) return null
  return (
    <div className="panel task" role="status">
      {task.progress < 0 ? (
        // no measure of how far: a moving bar
        <>
          {task.label}
          <i className="indeterminate" />
        </>
      ) : (
        <>
          {task.label}… {Math.round(task.progress * 100)}%
          <i style={{ width: `${Math.round(task.progress * 100)}%` }} />
        </>
      )}
    </div>
  )
}

function Tooltip() {
  const hovered = useStore(store, s => s.hovered)
  const node = useStore(store, s => (s.hovered ? findNode(s, s.hovered.id) : undefined))
  const described = useStore(store, s => describedOf(s, s.hovered?.id))
  if (!hovered || !node) return null
  const loc = node.metrics?.loc
  return (
    <div className="tooltip" style={{ transform: `translate(${hovered.x + 14}px, ${hovered.y + 14}px)` }} role="tooltip">
      <strong>{displayName(node.id, node)}</strong>
      <span className="dim">
        {' '}
        {node.subkind ?? node.kind}
        {loc !== undefined ? ` · ${loc.toLocaleString('en-US')} lines` : ''}
      </span>
      {node.path && <div className="dim">{node.path}</div>}
      {described && (
        <div className="tooltip-described">
          {described.ownFiles && <span className="dim">its own files: </span>}
          {described.name && <b>{described.name}: </b>}
          {described.summary.length > 160 ? `${described.summary.slice(0, 159)}…` : described.summary}
        </div>
      )}
    </div>
  )
}

/** The two ends of a heat legend. */
function heatLabels(colorBy: string, windowDays: number): [string, string] {
  switch (colorBy) {
    case 'fanIn':
      return ['fan-in: low', 'high']
    case 'tests':
      return ['tests reaching it: many', 'none']
    case 'churn':
      return [`lines changed in the last ${windowDays} days: few`, 'many']
    case 'hotspot':
      return ['hotspot (churn × complexity): low', 'high']
    case 'age':
      return ['last change: long ago', 'recent']
    default:
      return ['complexity: low', 'high']
  }
}
