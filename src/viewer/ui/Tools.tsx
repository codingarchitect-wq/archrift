// The spaghetti toolkit's panels: filters, saved views, the
// path finder, focus controls, what a directory, a cycle or a module is made
// of, the architecture rules with their violations (§9), and git history:
// hotspots, co-change and the timeline (§7).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { GraphNode } from '../../core/model.ts'
import type { RuleSummary, Violation } from '../../core/rules.ts'
import { MAX_COMMITS, findingsByFile, modeOf, notesFor, rangeFor, worstTone } from '../../core/changes.ts'
import type { ChangedFile, CommitInfo, Finding, RangeMode } from '../../core/changes.ts'
import { docsOfNode, nodeLabel } from '../../core/docs.ts'
import { graphOf, groupingOf, pathEnd, visibilityOf } from '../controller.ts'
import { api } from '../api.ts'
import type { ProjectList } from '../api.ts'
import { featureGroupId, groupKind, groupName } from '../groups.ts'
import { CHANGES_ID, actions, findNode, fixAt, store, timelinePoints, violationNodes } from '../store.ts'
import type { FocusDir } from '../store.ts'
import { DEFAULT_OPTIONS } from '../url-state.ts'
import { modules, pathsBetween, reachFrom } from '../world.ts'
import { Described, displayName } from './Inspector.tsx'
import { runtime } from './runtime.ts'

/** Close a popover on Escape (without the Escape also clearing the selection) or a click outside it. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, close])
  return ref
}

const EDGE = 8

/**
 * A popover opens under its button, right-aligned; when the toolbar wraps and
 * that would run past the window's edge, it slides back into view.
 */
function useInView(open = true) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    const fit = () => {
      const el = ref.current
      if (!el) return
      el.style.transform = ''
      const r = el.getBoundingClientRect()
      const dx = r.left < EDGE ? EDGE - r.left : r.right > innerWidth - EDGE ? innerWidth - EDGE - r.right : 0
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`
    }
    fit()
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [open])
  return ref
}

// ── filters ────────────────────────────────────────────────────────────────

export function FiltersButton() {
  const [open, setOpen] = useState(false)
  const o = useStore(store, s => s.options)
  const active = (o.kinds.length ? 1 : 0) + (o.hide.length ? 1 : 0) + (o.minLoc ? 1 : 0) + (o.onlyCycles ? 1 : 0)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Filters{active ? ` (${active})` : ''} ▾
      </button>
      {open && <FiltersPanel onClose={() => setOpen(false)} />}
    </div>
  )
}

function FiltersPanel({ onClose }: { onClose: () => void }) {
  const inView = useInView()
  const o = useStore(store, s => s.options)
  const counts = useStore(store, s => s.world?.graph.meta.counts)
  const kinds = Object.keys(counts ?? {})
    .filter(k => k.startsWith('edges.'))
    .map(k => k.slice(6))
    .sort()
  const [hide, setHide] = useState(o.hide.join(', '))
  const toggleKind = (k: string) => {
    const current = o.kinds.length ? o.kinds : kinds.filter(x => x !== 'mocks')
    const next = current.includes(k) ? current.filter(x => x !== k) : [...current, k]
    actions.setOption('kinds', next.length === kinds.filter(x => x !== 'mocks').length && !next.includes('mocks') ? [] : next)
  }
  const applyHide = () => actions.setOption('hide', hide.split(/[,\s]+/).map(x => x.trim()).filter(Boolean))
  return (
    <div ref={inView} className="panel popover filters" role="dialog" aria-label="Filters">
      <fieldset>
        <legend>Dependencies that count</legend>
        <div className="checks">
          {kinds.map(k => (
            <label key={k}>
              <input type="checkbox" checked={o.kinds.length ? o.kinds.includes(k) : k !== 'mocks'} onChange={() => toggleKind(k)} /> {k}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        Hide files matching (globs)
        <input
          type="text"
          value={hide}
          placeholder="src/components/ui/**, **/*.stories.tsx"
          onChange={e => setHide(e.target.value)}
          onBlur={applyHide}
          onKeyDown={e => e.key === 'Enter' && applyHide()}
        />
      </label>
      <label className="block">
        Hide files under
        <input type="number" min={0} step={10} value={o.minLoc} onChange={e => actions.setOption('minLoc', Math.max(0, Number(e.target.value) || 0))} /> lines
      </label>
      <label>
        <input type="checkbox" checked={o.onlyCycles} onChange={e => actions.setOption('onlyCycles', e.target.checked)} /> only files in import cycles
      </label>
      <label>
        <input type="checkbox" checked={o.bundle} onChange={e => actions.setOption('bundle', e.target.checked)} /> bundle arcs along folders
      </label>
      <div className="actions">
        <button
          onClick={() => {
            setHide('')
            actions.setOptions({ kinds: [], hide: [], minLoc: 0, onlyCycles: false, bundle: DEFAULT_OPTIONS.bundle })
          }}
        >
          Reset filters
        </button>
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

// ── saved views ────────────────────────────────────────────────────────────

export function ViewsMenu() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const views = useStore(store, s => s.views)
  const canSave = api.capabilities.saveViews
  const ref = useDismiss(open, () => setOpen(false))
  const inView = useInView(open)
  const save = async () => {
    if (!name.trim()) return
    try {
      await actions.saveView(name.trim(), runtime.engine?.cameraState())
      setName('')
      setError('')
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Saved views ▾
      </button>
      {open && (
        <div ref={inView} className="panel popover views-menu" role="dialog" aria-label="Saved views">
          {views.length === 0 && <p className="dim">{canSave ? 'No saved views yet.' : 'No saved views in this export.'}</p>}
          <ul className="rows">
            {views.map(v => (
              <li key={v.name} className="view-row">
                <button
                  className="row"
                  onClick={async () => {
                    await actions.applyView(v)
                    const cam = v.state.camera
                    if (cam) setTimeout(() => runtime.engine?.moveCamera(cam.position, cam.target), 60)
                    // a view kept without a camera (written by hand) frames what it shows
                    else if (!v.state.selected) setTimeout(() => runtime.engine?.home(), 60)
                    setOpen(false)
                  }}
                >
                  <span className="name">{v.name}</span>
                  <span className="dim">{v.state.options.view ?? 'city'}</span>
                </button>
                {canSave && (
                  <button className="icon" aria-label={`Delete view ${v.name}`} onClick={() => actions.deleteView(v.name)}>
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canSave ? (
            <div className="save-row">
              <input aria-label="View name" placeholder="Name this view" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
              <button onClick={save} disabled={!name.trim()}>
                Save
              </button>
            </div>
          ) : (
            <p className="dim">This page is an export: its views open here, and are saved with <code>archrift serve</code>.</p>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  )
}

// ── path finder ────────────────────────────────────────────────────────────

export function PathPanel() {
  const path = useStore(store, s => s.path)
  useStore(store, s => s.options)
  if (!path) return null
  const s = store.getState()
  const from = findNode(s, path.from)
  const name = (id: string) => displayName(id, findNode(s, id))
  if (!path.to)
    return (
      <div className="panel path-panel" role="status">
        <span>
          Path from <strong>{from?.name ?? path.from}</strong>: pick where to (click it or search)
        </span>
        <button onClick={() => actions.clearPath()}>Cancel</button>
      </div>
    )
  const a = pathEnd(s, path.from)
  const b = pathEnd(s, path.to)
  const result = a && b ? pathsBetween(graphOf(s), a, b) : { paths: [], reversed: false }
  return (
    <div className="panel path-panel" role="region" aria-label="Path">
      <header>
        <span>
          {result.paths.length === 0 ? (
            <>
              No dependency path between <strong>{name(path.from)}</strong> and <strong>{name(path.to)}</strong>
            </>
          ) : result.reversed ? (
            <>
              <strong>{name(path.from)}</strong> doesn’t reach <strong>{name(path.to)}</strong>, but it depends on it the other way round:
            </>
          ) : (
            <>
              <strong>{name(path.from)}</strong> reaches <strong>{name(path.to)}</strong> in {result.paths[0].length - 1} step
              {result.paths[0].length > 2 ? 's' : ''}:
            </>
          )}
        </span>
        <button onClick={() => actions.swapPath()} title="Swap ends">
          ⇄
        </button>
        <button onClick={() => actions.clearPath()} aria-label="Close path">
          ✕
        </button>
      </header>
      {result.paths.map(p => (
        <ol key={p.join('>')} className="path">
          {p.map(id => (
            <li key={id}>
              <button className="link" onClick={() => actions.select(id)}>
                {findNode(s, id)?.name ?? id}
              </button>
            </li>
          ))}
        </ol>
      ))}
    </div>
  )
}

// ── focus ──────────────────────────────────────────────────────────────────

const DIRS: [FocusDir, string][] = [
  ['both', 'both'],
  ['out', 'uses'],
  ['in', 'used by'],
]

export function FocusBar({ node }: { node: GraphNode }) {
  const o = useStore(store, s => s.options)
  const s = store.getState()
  const visible = visibilityOf(s).ids
  const start = node.kind === 'directory' ? s.world!.index.descendants(node.id).filter(d => visible.has(d.id)).map(d => d.id) : [node.id]
  const r = reachFrom(graphOf(s), start, o.focusDir, o.focusDepth)
  const inStart = new Set(start)
  const count = (m: Map<string, unknown>) => [...m.keys()].filter(k => !inStart.has(k)).length
  const depthText = o.focusDepth ? `within ${o.focusDepth} step${o.focusDepth > 1 ? 's' : ''}` : 'directly or not'
  return (
    <section className="focus" aria-label="Focus">
      <div className="focus-controls">
        <div className="seg" role="group" aria-label="Focus direction">
          {DIRS.map(([dir, label]) => (
            <button key={dir} aria-pressed={o.focusDir === dir} onClick={() => actions.setOption('focusDir', dir)}>
              {label}
            </button>
          ))}
        </div>
        <label>
          depth
          <select aria-label="Focus depth" value={o.focusDepth} onChange={e => actions.setOption('focusDepth', Number(e.target.value))}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={0}>all</option>
          </select>
        </label>
      </div>
      <p className="dim reach">
        {o.focusDir !== 'in' && <span>uses {count(r.out).toLocaleString('en-US')} files</span>}
        {o.focusDir === 'both' && ' · '}
        {o.focusDir !== 'out' && <span>used by {count(r.in).toLocaleString('en-US')}</span>} {depthText}
      </p>
      <div className="actions">
        <button onClick={() => actions.setOptions({ focusDir: 'in', focusDepth: 0 })} title="Everything that depends on this, directly or not">
          Impact
        </button>
        <button onClick={() => actions.setOptions({ focusDir: 'out', focusDepth: 0 })} title="Everything this depends on, directly or not">
          Dependencies
        </button>
        <button onClick={() => actions.startPath(node.id)}>Find path…</button>
      </div>
    </section>
  )
}

// ── what a directory, a cycle, a module is made of ────────────────────────

export function DirectoryInsights({ node }: { node: GraphNode }) {
  useStore(store, s => s.options)
  const s = store.getState()
  const world = s.world!
  const prefix = node.path ? `f:${node.path}/` : 'f:'
  const cycles = world.graph.meta.cycles.map((c, i) => ({ i, c })).filter(({ c }) => c.some(f => f.startsWith(prefix)))
  const visible = [...visibilityOf(s).ids].filter(id => id.startsWith('f:'))
  const mine = visible.filter(f => f.startsWith(prefix))
  const m = mine.length > 1 ? modules(world, graphOf(s), visible) : undefined
  const counts = new Map<number, number>()
  if (m) for (const f of mine) counts.set(m.of.get(f)!, (counts.get(m.of.get(f)!) ?? 0) + 1)
  const spread = [...counts].sort((a, b) => b[1] - a[1])
  return (
    <>
      <section className="cycles">
        <h3>Import cycles ({cycles.length})</h3>
        {cycles.length === 0 && <p className="dim">None among its files.</p>}
        <ul className="rows">
          {cycles.map(({ i, c }) => (
            <li key={i}>
              <button className="row stacked" onClick={() => actions.select(`cycle:${i}`)}>
                <span className="name">{c.length} files in a cycle</span>
                <span className="dim">{c.map(f => f.slice(f.lastIndexOf('/') + 1)).join(' → ')}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {m && (
        <section className="modules">
          <h3>Detected modules ({spread.length})</h3>
          <p className="dim">
            Its {mine.length} files fall into {spread.length} module{spread.length === 1 ? '' : 's'} found from the dependencies:
          </p>
          <ul className="rows">
            {spread.slice(0, 12).map(([index, n]) => (
              <li key={index}>
                <button
                  className="row stacked"
                  onClick={() => {
                    actions.setOption('groupBy', 'community')
                    void actions.select(`module:${index}`)
                  }}
                >
                  <span className="name">
                    module {index + 1} <span className="dim">· {n} of its files</span>
                  </span>
                  <span className="dim">{m.list[index].label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

export function CycleView({ id }: { id: string }) {
  const world = useStore(store, s => s.world!)
  const members = world.graph.meta.cycles[Number(id.slice(6))] ?? []
  return (
    <>
      <header>
        <div className="kind-line">
          <span className="badge tag-in-cycle">import cycle</span>
        </div>
        <h2>{members.length} files that import each other</h2>
        <p className="path">Runtime imports only; type-only imports don’t count.</p>
      </header>
      <section>
        <h3>Files</h3>
        <ul className="rows">
          {members.map(f => (
            <li key={f}>
              <button className="row" onClick={() => actions.select(f)}>
                <span className="name">{world.node(f)?.name}</span>
                <span className="dim">{world.node(f)?.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

export function GroupView({ id }: { id: string }) {
  useStore(store, s => s.options)
  const s = store.getState()
  const world = s.world!
  const grouping = groupingOf(s)
  const label = grouping?.groups.find(g => g.id === id)?.label ?? id
  // a feature: the routes it was found from
  const routes = id.startsWith('feature:') ? world.graph.meta.features?.find(f => featureGroupId(f.name) === id)?.routes : undefined
  const files = [...visibilityOf(s).ids].filter(f => f.startsWith('f:') && grouping?.groupOf(f) === id)
  const dirs = new Map<string, number>()
  for (const f of files) dirs.set(world.node(f)?.parent ?? '', (dirs.get(world.node(f)?.parent ?? '') ?? 0) + 1)
  return (
    <>
      <header>
        <div className="kind-line">
          <span className="badge">{groupKind(id)}</span>
        </div>
        <h2>{id.startsWith('module:') ? `Module ${Number(id.slice(7)) + 1}` : groupName({ id, label })}</h2>
        {routes ? <p className="path">{routes.join(' · ')}</p> : id.startsWith('module:') && <p className="path">{label}</p>}
        <Described id={id} />
      </header>
      <section>
        <h3>Folders it spans ({dirs.size})</h3>
        <ul className="rows">
          {[...dirs]
            .sort((a, b) => b[1] - a[1])
            .map(([d, n]) => (
              <li key={d}>
                <button className="row" onClick={() => actions.select(d)}>
                  <span className="name">{world.node(d)?.path || world.node(d)?.name}</span>
                  <span className="dim">{n} files</span>
                </button>
              </li>
            ))}
        </ul>
      </section>
      <section>
        <h3>Files ({files.length})</h3>
        <ul className="rows">
          {files.slice(0, 60).map(f => (
            <li key={f}>
              <button className="row" onClick={() => actions.select(f)}>
                <span className="name">{world.node(f)?.name}</span>
                <span className="dim">{world.node(f)?.parent?.slice(2)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

// ── architecture rules ───────────────────────────────────────────

const NO_RULES: RuleSummary[] = []
const NO_VIOLATIONS: Violation[] = []
const ROUTE_FILE = /^(page|layout|template|loading|error|default|not-found|route|index)\.[a-z]+$/
const VIOLATION_ROWS = 50

/** A file's name, with its folder when the name alone says little (page.tsx, index.ts). */
function shortName(id: string) {
  const n = store.getState().world?.node(id)
  if (!n || n.kind !== 'file' || !n.path) return displayName(id, n)
  return ROUTE_FILE.test(n.name) ? n.path.split('/').slice(-2).join('/') : n.name
}

/** A limit's or requireReach's violation's subject: its file, or the function in it (by its id: the overview has no symbols). */
function measuredName(v: Violation) {
  const fn = v.measure?.symbol ?? v.expects?.symbol
  return fn ? `${displayName(fn, undefined)} in ${shortName(v.from)}` : shortName(v.from)
}

const measureText = (m: NonNullable<Violation['measure']>) => `${m.metric} ${m.value} (${m.bound} ${m.limit})`

const folderOf = (id: string) => {
  const p = store.getState().world?.node(id)?.path
  return p ? p.slice(0, p.lastIndexOf('/')) : ''
}

export function RulesButton() {
  const [open, setOpen] = useState(false)
  const rules = useStore(store, s => s.world?.graph.meta.rules ?? NO_RULES)
  const violations = useStore(store, s => s.world?.graph.meta.violations ?? NO_VIOLATIONS)
  const ref = useDismiss(open, () => setOpen(false))
  if (!rules.length) return null
  // a rule that matches nothing counts once, by its severity
  const unmatched = (severity: string) => rules.filter(r => r.unmatched && r.severity === severity).length
  const errors = violations.filter(v => v.severity === 'error').length + unmatched('error')
  const warnings = violations.filter(v => v.severity === 'warn').length + unmatched('warn')
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} onClick={() => setOpen(!open)} title={`${errors} broken rules · ${warnings} warnings`}>
        Rules
        {errors > 0 && <span className="count error">{errors}</span>}
        {warnings > 0 && <span className="count warn">{warnings}</span>}
        {errors + warnings === 0 && <span className="count ok">✓</span>} ▾
      </button>
      {open && <RulesPanel rules={rules} violations={violations} onPick={() => setOpen(false)} />}
    </div>
  )
}

function RulesPanel({ rules, violations, onPick }: { rules: RuleSummary[]; violations: Violation[]; onPick: () => void }) {
  const inView = useInView()
  const selected = useStore(store, s => s.selected)
  const colorBy = useStore(store, s => s.options.colorBy)
  const all = useStore(store, s => s.world?.graph.meta.targets.length ?? 1)
  const indexed = violations.map((v, i) => ({ v, i }))
  const broken = (r: RuleSummary) => indexed.filter(x => x.v.rule === r.name)
  const rank = (r: RuleSummary) => (broken(r).length || r.unmatched ? (r.severity === 'error' ? 0 : 1) : 2)
  return (
    <div ref={inView} className="panel popover rules-panel" role="dialog" aria-label="Architecture rules">
      <div className="actions">
        <button aria-pressed={colorBy === 'violations'} onClick={() => actions.setOption('colorBy', colorBy === 'violations' ? 'area' : 'violations')}>
          Color by violations
        </button>
      </div>
      {[...rules]
        .sort((a, b) => rank(a) - rank(b))
        .map(r => {
          const vs = broken(r)
          const state = !vs.length && !r.unmatched ? 'ok' : r.severity === 'error' ? 'error' : 'warn'
          return (
            <section key={r.name} className={`rule ${state}`} aria-label={`Rule ${r.name}`}>
              <h3>
                <span className="mark">{state === 'ok' ? '✓' : state === 'error' ? '✗' : '!'}</span>
                <span className="rule-name">{r.name}</span>
                {vs.length > 0 && <span className={`count ${state}`}>{vs.length}</span>}
              </h3>
              <p className="dim">
                {r.kind}
                {r.target ? ` in ${r.target}` : ''}
                {r.description ? ` · ${r.description}` : ''}
              </p>
              {r.unmatched && (
                <ul className="unmatched" aria-label="Matches nothing">
                  {r.unmatched.map(u => (
                    <li key={u}>{u}: the rule checks nothing there</li>
                  ))}
                </ul>
              )}
              {vs.length > 0 && (
                <ul className="rows">
                  {vs.slice(0, VIOLATION_ROWS).map(({ v, i }) => (
                    <li key={i}>
                      <button
                        className={`row stacked${selected === `violation:${i}` ? ' current' : ''}`}
                        onClick={() => {
                          void actions.select(`violation:${i}`)
                          onPick()
                        }}
                      >
                        <span className="name">{v.measure || v.expects ? measuredName(v) : `${shortName(v.from)} → ${shortName(v.to)}`}</span>
                        <span className="dim">
                          {[
                            v.measure ? `${measureText(v.measure)} · ${folderOf(v.from) || '.'}` : v.expects ? `never reaches ${v.expects.to}` : v.path && v.path.length > 2 ? `${v.path.length - 1} steps` : `${folderOf(v.from) || '.'} → ${folderOf(v.to) || v.to.replace(/^x:(npm|node):/, '')}`,
                            v.sources && v.sources.length > 1 ? `from ${v.sources.length} places` : '',
                            v.targets.length < all ? v.targets.join(', ') : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {vs.length > VIOLATION_ROWS && <p className="dim">… and {vs.length - VIOLATION_ROWS} more (archrift check lists them all)</p>}
            </section>
          )
        })}
    </div>
  )
}

/** How a file or package takes part in a violation, from its own point of view. */
function roleIn(v: Violation, id: string, kind: RuleSummary['kind'] | undefined): string {
  if (v.measure) return `${v.measure.symbol ? `${displayName(v.measure.symbol, undefined)}: ` : ''}${measureText(v.measure)}`
  if (v.expects) return `${v.expects.symbol ? `${displayName(v.expects.symbol, undefined)} ` : ''}never reaches ${v.expects.to}`
  if (kind === 'cycles') return `in a cycle of ${violationNodes(v).length - 1} files`
  const fix = fixAt(v)
  if (id === fix) return `imports ${shortName(v.to)}`
  if (id === v.to) return `${shortName(fix)} imports it`
  if (v.path?.includes(id)) return `on the way from ${shortName(v.path[0])} to ${shortName(v.to)}`
  return `reaches ${shortName(v.to)}`
}

/** The rules a file (or package) breaks, or takes part in breaking: each links to the violation. */
export function FileRules({ node }: { node: GraphNode }) {
  const violations = useStore(store, s => s.world?.graph.meta.violations ?? NO_VIOLATIONS)
  const rules = useStore(store, s => s.world?.graph.meta.rules ?? NO_RULES)
  const mine = violations
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => violationNodes(v).includes(node.id) || !!v.sources?.includes(node.id))
    // errors first, then the ones this file can fix itself
    .sort((a, b) => (a.v.severity === b.v.severity ? 0 : a.v.severity === 'error' ? -1 : 1) || Number(fixAt(b.v) === node.id) - Number(fixAt(a.v) === node.id))
  if (!mine.length) return null
  const errors = mine.filter(({ v }) => v.severity === 'error').length
  return (
    <section className="file-rules">
      <h3>
        Breaks rules ({mine.length}){errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}
      </h3>
      <ul className="rows">
        {mine.slice(0, VIOLATION_ROWS).map(({ v, i }) => {
          const rule = rules.find(r => r.name === v.rule)
          return (
            <li key={i}>
              <button className="row stacked" onClick={() => actions.select(`violation:${i}`)} title={rule?.description}>
                <span className="name">
                  <span className={`mark ${v.severity}`}>{v.severity === 'error' ? '✗' : '!'}</span> {v.rule}
                </span>
                <span className="dim">
                  {roleIn(v, node.id, rule?.kind)}
                  {v.targets.length < (store.getState().world?.graph.meta.targets.length ?? 1) ? ` · ${v.targets.join(', ')}` : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {mine.length > VIOLATION_ROWS && <p className="dim">… and {mine.length - VIOLATION_ROWS} more (Rules in the toolbar lists them all)</p>}
    </section>
  )
}

export function ViolationView({ id }: { id: string }) {
  const world = useStore(store, s => s.world!)
  const all = world.graph.meta.violations ?? NO_VIOLATIONS
  const index = Number(id.slice(10))
  const v = all[index]
  if (!v) return <p className="dim">No such violation in this graph.</p>
  const rule = world.graph.meta.rules?.find(r => r.name === v.rule)
  const same = all.map((x, i) => ({ x, i })).filter(({ x }) => x.rule === v.rule)
  const k = same.findIndex(({ i }) => i === index)
  const step = (d: number) => actions.select(`violation:${same[(k + d + same.length) % same.length].i}`)
  const steps = violationNodes(v)
  const fix = fixAt(v)
  const cycle = rule?.kind === 'cycles'
  const what = v.measure
    ? `${measuredName(v)}: ${v.measure.metric} is ${v.measure.value}, the rule allows ${v.measure.bound === 'max' ? 'at most' : 'no less than'} ${v.measure.limit}.`
    : v.expects
      ? `${measuredName(v)} never reaches ${v.expects.to}: nothing it calls, renders, creates or queries gets there, directly or through other code${v.targets.length < world.graph.meta.targets.length ? ` (in ${v.targets.join(', ')})` : ''}.`
      : rule?.kind === 'forbidReach'
      ? `${shortName(v.to)} ends up in the ${v.targets[0]} build: ${v.sources && v.sources.length > 1 ? `${v.sources.length} files` : shortName(v.from)} reach it through runtime imports.`
      : rule?.kind === 'cycles'
        ? `${steps.length - 1} files import each other.`
        : rule?.kind === 'layers'
          ? v.message.slice(0, v.message.indexOf(':'))
          : rule?.kind === 'allow'
            ? `${shortName(v.to)} is outside what ${shortName(v.from)} may depend on.`
            : rule?.kind === 'apart'
            ? `${shortName(v.from)} depends on ${shortName(v.to)}, in another of the folders the rule keeps apart.`
            : `${shortName(v.from)} depends on ${shortName(v.to)}, which the rule forbids.`
  return (
    <>
      <header>
        <div className="kind-line">
          <span className={`badge ${v.severity === 'error' ? 'tag-violation' : 'tag-warning'}`}>{v.severity === 'error' ? 'broken rule' : 'rule warning'}</span>
          {rule && <span className="badge">{rule.kind}</span>}
          {v.targets.length < world.graph.meta.targets.length && v.targets.map(t => <span key={t} className="badge">{t} only</span>)}
        </div>
        <h2>{v.rule}</h2>
        {rule?.description && <p className="path">{rule.description}</p>}
      </header>
      <section>
        <p>{what}</p>
      </section>
      {v.measure || v.expects ? (
        <section>
          <h3>Where</h3>
          <ul className="rows">
            {[v.from, ...((v.measure?.symbol ?? v.expects?.symbol) ? [(v.measure?.symbol ?? v.expects?.symbol)!] : [])].map(n => (
              <li key={n}>
                <button className="row" onClick={() => actions.select(n)} title={world.node(n)?.path ?? n}>
                  <span className="name">{shortName(n)}</span>
                  <span className="dim">{n === v.from ? folderOf(n) : 'the function'}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section>
          <h3>{cycle ? 'The cycle' : steps.length > 2 ? 'How it gets there' : 'The dependency'}</h3>
          <ol className="rows violation-steps">
            {steps.map((n, j) => (
              <li key={`${j}${n}`}>
                <button className={`row${n === fix && !cycle ? ' fix' : ''}`} onClick={() => actions.select(n)} title={world.node(n)?.path ?? n}>
                  <span className="name">
                    {j > 0 ? '→ ' : ''}
                    {shortName(n)}
                  </span>
                  <span className="dim">{n === fix && !cycle ? 'imports it' : folderOf(n)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {v.sources && v.sources.length > 1 && (
        <section>
          <h3>Reached from ({v.sources.length})</h3>
          <ul className="rows">
            {v.sources.slice(0, ROW_SOURCES).map(src => (
              <li key={src}>
                <button className="row" onClick={() => actions.select(src)}>
                  <span className="name">{shortName(src)}</span>
                  <span className="dim">{folderOf(src)}</span>
                </button>
              </li>
            ))}
          </ul>
          {v.sources.length > ROW_SOURCES && <p className="dim">… and {v.sources.length - ROW_SOURCES} more</p>}
        </section>
      )}
      {same.length > 1 && (
        <div className="actions stepper">
          <button onClick={() => step(-1)} aria-label="Previous violation">
            ←
          </button>
          <span className="dim">
            {k + 1} of {same.length}
          </span>
          <button onClick={() => step(1)} aria-label="Next violation">
            →
          </button>
        </div>
      )}
    </>
  )
}

const ROW_SOURCES = 40

// ── git history ──────────────────────────────────────────────────

const HOTSPOTS = 10
const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)
const lines = (n: number) => n.toLocaleString('en-US')

export function HistoryButton() {
  const [open, setOpen] = useState(false)
  const history = useStore(store, s => s.now?.graph.meta.history)
  const snapshots = useStore(store, s => s.snapshots.length)
  const ref = useDismiss(open, () => setOpen(false))
  if (!history && !snapshots) return null
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        History ▾
      </button>
      {open && <HistoryPanel onPick={() => setOpen(false)} />}
    </div>
  )
}

function HistoryPanel({ onPick }: { onPick: () => void }) {
  const inView = useInView()
  const now = useStore(store, s => s.now!)
  const colorBy = useStore(store, s => s.options.colorBy)
  const timeline = useStore(store, s => s.options.timeline)
  const snapshots = useStore(store, s => s.snapshots)
  const h = now.graph.meta.history
  const hotspots = now.graph.nodes
    .filter(n => n.kind === 'file' && !n.tags?.includes('test') && (n.metrics?.hotspot ?? 0) > 0)
    .sort((a, b) => b.metrics!.hotspot - a.metrics!.hotspot || (a.id < b.id ? -1 : 1))
    .slice(0, HOTSPOTS)
  const colorButton = (value: typeof colorBy, label: string) => (
    <button aria-pressed={colorBy === value} onClick={() => actions.setOption('colorBy', colorBy === value ? 'area' : value)}>
      {label}
    </button>
  )
  return (
    <div ref={inView} className="panel popover history-panel" role="dialog" aria-label="Git history">
      {h && (
        <>
          <p className="dim">
            {lines(h.commits)} commits by {h.authors} author{h.authors === 1 ? '' : 's'}, {day(h.since)} to {day(h.until)}
          </p>
          <div className="actions">
            {colorButton('churn', 'Churn')}
            {colorButton('hotspot', 'Hotspots')}
            {colorButton('age', 'Last change')}
          </div>
          <section aria-label="Hotspots">
            <h3>Hotspots: last {h.windowDays} days</h3>
            <p className="dim">Lines changed × complexity: complicated code that keeps changing.</p>
            <ol className="rows">
              {hotspots.map((n, i) => (
                <li key={n.id}>
                  <button
                    className="row stacked"
                    onClick={() => {
                      void actions.select(n.id, { travel: true })
                      onPick()
                    }}
                  >
                    <span className="name">
                      {i + 1}. {n.name}
                    </span>
                    <span className="dim">
                      {lines(n.metrics!.churn)} lines changed × complexity {n.metrics!.complexity} · {n.path!.slice(0, n.path!.lastIndexOf('/'))}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
      {api.capabilities.snapshots && (
        <section aria-label="Timeline">
          <h3>Timeline</h3>
          {snapshots.length ? (
            <button
              onClick={() => {
                actions.setOptions(timeline ? { timeline: false, at: '' } : { timeline: true })
                onPick()
              }}
            >
              {timeline ? 'Close the timeline' : `Open the timeline (${snapshots.length} snapshots)`}
            </button>
          ) : (
            <p className="dim">
              No snapshots yet: <code>archrift snapshot &lt;root&gt;</code> analyzes 10 commits from the history for it.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

const PLAY_MS = 1800

/** The timeline: snapshots, oldest first, then now; the city changes as it moves. */
export function Timeline() {
  const open = useStore(store, s => s.options.timeline)
  const at = useStore(store, s => s.options.at)
  const snapshots = useStore(store, s => s.snapshots)
  const ready = useStore(store, s => !!s.union)
  const [playing, setPlaying] = useState(false)
  const points = timelinePoints(store.getState())
  const found = points.findIndex(p => p.sha === at)
  const index = found >= 0 ? found : points.length - 1 // an unknown sha shows now
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      const s = store.getState()
      const all = timelinePoints(s)
      const i = all.findIndex(p => p.sha === s.options.at)
      if (i >= all.length - 1) setPlaying(false)
      else actions.setOption('at', all[i + 1].sha)
    }, PLAY_MS)
    return () => clearInterval(t)
  }, [playing])
  if (!open || !snapshots.length) return null
  const point = points[index]
  const go = (i: number) => actions.setOption('at', points[Math.min(points.length - 1, Math.max(0, i))].sha)
  return (
    <div className="panel timeline" role="group" aria-label="Timeline">
      <button
        className="play"
        disabled={!ready}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => {
          if (!playing && index === points.length - 1) go(0)
          setPlaying(!playing)
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="track">
        <input
          type="range"
          min={0}
          max={points.length - 1}
          step={1}
          value={index}
          disabled={!ready}
          aria-label="Point in time"
          aria-valuetext={point.label}
          onChange={e => go(Number(e.target.value))}
        />
        <div className="ticks" aria-hidden="true">
          {points.map((p, i) => (
            <span key={p.sha || 'now'} className={i === index ? 'on' : ''} />
          ))}
        </div>
      </div>
      <div className="when">
        <strong>{point.label}</strong>
        <span className="dim">{point.sha ? `${point.sha.slice(0, 8)} · ${point.subject}` : 'the working tree, as analyzed'}</span>
      </div>
      <button className="icon" aria-label="Close timeline" onClick={() => actions.setOptions({ timeline: false, at: '' })}>
        ✕
      </button>
    </div>
  )
}

/** A file's git history: how often, how much and how lately it changed. */
export function GitHistory({ node }: { node: GraphNode }) {
  const history = useStore(store, s => s.now?.graph.meta.history)
  const m = node.metrics ?? {}
  if (!history || m.commits === undefined) return null
  return (
    <dl className="metrics git">
      <div>
        <dt>commits</dt>
        <dd>{lines(m.commits)}</dd>
      </div>
      <div>
        <dt>changed ({history.windowDays} d)</dt>
        <dd>{lines(m.churn ?? 0)}</dd>
      </div>
      <div>
        <dt>authors</dt>
        <dd>{m.authors ?? 0}</dd>
      </div>
      <div>
        <dt>last change</dt>
        <dd>{m.lastCommit ? day(m.lastCommit) : 'never committed'}</dd>
      </div>
    </dl>
  )
}

const DOC_ROWS = 6

/** The documents naming a file, folder or function (kept current first), and the decision ids a file cites (config `docs`). */
export function DocsSection({ node }: { node: GraphNode }) {
  const meta = useStore(store, s => s.world?.graph.meta.docs)
  const [all, setAll] = useState(false)
  const found = useMemo(() => docsOfNode(meta, node), [meta, node])
  if (!found.named.length && !found.cites.length) return null
  const shown = all ? found.named : found.named.slice(0, DOC_ROWS)
  return (
    <section className="docs" aria-label="Docs">
      <h3>
        Docs ({found.named.length}){found.cites.length ? ` · cites ${found.cites.length}` : ''}
      </h3>
      {found.cites.length > 0 && (
        <ul className="rows">
          {found.cites.map(c => (
            <li key={c.id}>
              <div className="row stacked" title={[...c.meant, ...c.also].map(d => `${d.doc}:${d.line}  ${d.label}`).join('\n')}>
                <span className="name">
                  <span className="badge">{c.id}</span> {c.meant[0]?.label}
                </span>
                <span className="dim">
                  {c.meant.map(d => `${d.doc}:${d.line}`).join(', ')}
                  {c.also.length ? ` · also defined in ${c.also.length} more` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ul className="rows">
        {shown.map(r => (
          <li key={r.doc}>
            <div className="row stacked" title={r.places.map(p => `line ${p.line}${p.section ? ` § ${p.section}` : ''}: ${nodeLabel(p.node)}`).join('\n')}>
              <span className="name">
                {r.title}
                {r.current && <span className="badge">kept current</span>}
              </span>
              <span className="dim">
                {r.doc} · {r.places[0].section ? `§ ${r.places[0].section} · ` : ''}line {r.places[0].line}
                {r.places.length > 1 ? ` (+${r.places.length - 1})` : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {found.named.length > shown.length && (
        <button className="more" onClick={() => setAll(true)}>
          Show all {found.named.length}
        </button>
      )}
    </section>
  )
}

const CO_CHANGE_ROWS = 20

/** Files that change in the same commits; the ones it has no dependency with are hidden coupling. */
export function CoChanges({ node }: { node: GraphNode }) {
  const world = useStore(store, s => s.world!)
  const arcs = useStore(store, s => s.options.coChange)
  const [hiddenOnly, setHiddenOnly] = useState(false)
  const [all, setAll] = useState(false)
  const partners = world.coChanges(node.id)
  if (!partners.length) return null
  const listed = hiddenOnly ? partners.filter(p => !p.depends) : partners
  const shown = all ? listed : listed.slice(0, CO_CHANGE_ROWS)
  return (
    <section className="co-changes">
      <h3>Changes together with ({partners.length})</h3>
      <div className="checks">
        <label>
          <input type="checkbox" checked={hiddenOnly} onChange={e => setHiddenOnly(e.target.checked)} /> only without a dependency
        </label>
        <label>
          <input type="checkbox" checked={arcs} onChange={e => actions.setOption('coChange', e.target.checked)} /> show as arcs
        </label>
      </div>
      <ul className="rows">
        {shown.map(p => {
          const other = world.node(p.other)
          return (
            <li key={p.other}>
              <button className="row stacked" onClick={() => actions.select(p.other, { from: node.id })} title={other?.path}>
                <span className="name">
                  {other?.name ?? p.other}
                  {!p.depends && <span className="badge tag-hidden-coupling">no dependency</span>}
                </span>
                <span className="dim">
                  {p.commits} commits together · {Math.round(p.confidence * 100)}% · {other?.path?.slice(0, other.path.lastIndexOf('/'))}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {listed.length > shown.length && (
        <button className="more" onClick={() => setAll(true)}>
          Show all {listed.length}
        </button>
      )}
    </section>
  )
}

// ── projects ───────────────────────────────────────────────────────────────

/** The project switcher: the open project's name, and a list to open another, add or remove. */
export function ProjectMenu() {
  const project = useStore(store, s => s.info?.project)
  const status = useStore(store, s => s.projectStatus)
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  if (project === undefined || !api.capabilities.projects) return null
  const opening = status?.state === 'opening' ? status.name : undefined
  return (
    <div className="popover-anchor" ref={ref}>
      <button className="project-button" aria-expanded={open} aria-label={`Project: ${project}`} title="Switch project" onClick={() => setOpen(!open)}>
        {opening ? `Opening ${opening}…` : project} ▾
      </button>
      {open && <ProjectsPanel onClose={() => setOpen(false)} />}
    </div>
  )
}

function ProjectsPanel({ onClose }: { onClose: () => void }) {
  const inView = useInView()
  const status = useStore(store, s => s.projectStatus)
  const [list, setList] = useState<ProjectList | null>(null)
  const [root, setRoot] = useState('')
  const [error, setError] = useState('')
  const failed = (err: unknown) => setError(err instanceof Error ? err.message : String(err))
  const refresh = () => api.projects().then(setList, failed)
  useEffect(() => void refresh(), [])
  const openProject = async (name: string) => {
    try {
      await api.openProject(name)
      onClose()
    } catch (err) {
      failed(err)
    }
  }
  const add = async () => {
    if (!root.trim()) return
    try {
      await api.addProject({ root: root.trim() })
      setRoot('')
      setError('')
      await refresh()
    } catch (err) {
      failed(err)
    }
  }
  const remove = async (name: string) => {
    try {
      setList(await api.removeProject(name))
    } catch (err) {
      failed(err)
    }
  }
  return (
    <div ref={inView} className="panel popover projects-panel" role="dialog" aria-label="Projects">
      {!list && !error && <p className="dim">Loading…</p>}
      <ul className="rows">
        {list?.projects.map(p => (
          <li key={p.name} className="view-row">
            <button
              className={`row stacked${p.active ? ' current' : ''}`}
              aria-current={p.active ? 'true' : undefined}
              disabled={!!list.opening}
              onClick={() => (p.active ? onClose() : openProject(p.name))}
            >
              <span className="name">
                {p.name}
                {p.active ? <span className="dim"> · open</span> : list.opening === p.name ? <span className="dim"> · opening…</span> : null}
              </span>
              <span className="dim">
                {p.root}
                {p.analyzedAt ? ` · analyzed ${new Date(p.analyzedAt).toLocaleString()}` : ' · not analyzed yet'}
              </span>
            </button>
            {!p.active && (
              <button className="icon" aria-label={`Remove ${p.name}`} title="Remove from the list (its files stay)" onClick={() => remove(p.name)}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="save-row">
        <input
          aria-label="Project folder"
          placeholder="Add a folder: /path/to/app or ~/src/app"
          value={root}
          onChange={e => setRoot(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
        />
        <button onClick={add} disabled={!root.trim()}>
          Add
        </button>
      </div>
      <p className="dim">
        Paste the folder's path: browsers can't hand a page the path of a folder you pick. Its graph, cache and saved views go to <code>~/.config/archrift/projects/&lt;name&gt;/</code>.
      </p>
      {status?.state === 'failed' && (
        <p className="error">
          {status.name} didn't open: {status.message}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// ── the change in progress (archrift diff, in the viewer) ───────────────────

const NO_FILES: ChangedFile[] = []
const STATUS_WORD: Record<ChangedFile['status'], string> = { added: 'new', modified: 'changed', renamed: 'renamed', removed: 'removed' }
const TONE_MARK: Record<Finding['tone'], string> = { error: '✗', warn: '!', good: '✓' }
const CHANGE_ROWS = 80

/** The violation of the graph shown that a finding's violation is (the diff's head is this graph). */
function violationIndex(v: Violation | undefined): number {
  if (!v) return -1
  const all = store.getState().world?.graph.meta.violations ?? NO_VIOLATIONS
  const sym = (x: Violation) => x.measure?.symbol ?? x.expects?.symbol ?? ''
  return all.findIndex(x => x.rule === v.rule && x.from === v.from && x.to === v.to && sym(x) === sym(v) && x.measure?.metric === v.measure?.metric)
}

function FindingRow({ path, f }: { path?: string; f: Finding }) {
  const i = violationIndex(f.violation)
  const go = () => (i >= 0 ? actions.select(`violation:${i}`) : path ? actions.select(`f:${path}`) : undefined)
  return (
    <li>
      <button className="row stacked" onClick={() => void go()} title={f.text}>
        <span className="name">
          <span className={`finding-mark ${f.tone}`}>{TONE_MARK[f.tone]}</span> {path ? shortName(`f:${path}`) : f.text}
        </span>
        {path && <span className="dim">{f.text}</span>}
      </button>
    </li>
  )
}

/** The Changes button: the files the working tree changes since its base, lit on the map with what the diff finds. */
export function ChangesButton() {
  const changes = useStore(store, s => s.changes)
  const selected = useStore(store, s => s.selected === CHANGES_ID)
  if (!api.capabilities.changes) return null
  const files = changes.report?.files.length
  return (
    <button
      aria-pressed={selected}
      onClick={() => void actions.showChanges()}
      title={changes.report ? `${files} files changed since ${changes.report.base.label}${changes.report.errors ? `; ${changes.report.errors} new errors` : ''}` : 'The change in progress against its base (where the branch left main; on main, HEAD), as archrift diff sees it'}
    >
      Changes
      {changes.state === 'loading' && <span className="count">…</span>}
      {files !== undefined && changes.state !== 'loading' && <span className="count">{files}</span>}
      {!!changes.report?.errors && <span className="count error">{changes.report.errors}</span>}
    </button>
  )
}

/** The inspector on the Changes selection: what was asked, what the diff found, every changed file. */
export function ChangesView() {
  const changes = useStore(store, s => s.changes)
  const r = changes.report
  if (!r)
    return (
      <>
        <RangePicker />
        <p className="dim">{changes.state === 'error' ? `Could not compare: ${changes.error}` : 'Comparing… (each commit compared is analyzed once: some seconds)'}</p>
      </>
    )
  // the report's own head: while another range loads, the last answer still says what it compared
  const committed = !!r.headSha
  const findings = findingsByFile(r.diff)
  const flat = [...findings].flatMap(([path, fs]) => fs.map(f => ({ path, f })))
  const order = { error: 0, warn: 1, good: 2 }
  flat.sort((a, b) => order[a.f.tone] - order[b.f.tone] || (a.path < b.path ? -1 : 1))
  const groups = (['added', 'modified', 'renamed', 'removed'] as const).map(st => ({ st, files: r.files.filter(f => f.status === st) })).filter(g => g.files.length)
  return (
    <>
      <header>
        <div className="kind-line">
          <span className="badge">{committed ? 'commits' : r.commits.length ? `${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} and the change in progress` : 'change in progress'}</span>
          {r.errors > 0 && <span className="badge tag-violation">{r.errors} new error{r.errors === 1 ? '' : 's'}</span>}
        </div>
        <h2>Changes</h2>
        <RangePicker />
        <p className="path">
          {r.files.length} file{r.files.length === 1 ? '' : 's'} {committed ? `from ${r.base.label} to ${r.head}` : `since ${r.base.label}`}
          {changes.state === 'loading' ? ' · comparing…' : ''}
        </p>
        {committed && <p className="dim">The map shows the working tree: a file changed since shows as it is now.</p>}
        <ChangeEdgesSwitch />
        {changes.state === 'error' && <p className="dim">The last comparison failed: {changes.error}</p>}
        <div className="actions">
          <button onClick={() => void actions.showChanges({ fresh: true })} title="Compare again (after a commit, or when the agent's notes changed)">
            Compare again
          </button>
        </div>
      </header>
      {r.tasks.map((t, k) => (
        <section key={k} className="change-task">
          <h3>{t.title ?? 'What was done'}</h3>
          {t.request && (
            <p>
              <span className="dim">Asked: </span>
              {t.request}
            </p>
          )}
          {t.summary && <p>{t.summary}</p>}
        </section>
      ))}
      <Commits commits={r.commits} />
      {flat.length > 0 && (
        <section>
          <h3>What archrift diff finds ({flat.length})</h3>
          <ul className="rows">
            {flat.slice(0, CHANGE_ROWS).map(({ path, f }, k) => (
              <FindingRow key={k} path={path} f={f} />
            ))}
          </ul>
        </section>
      )}
      {!flat.length && (
        <section>
          <p className="dim">Nothing changes for the rules, the import cycles, coherence, the dependencies between blocks or what entry points load.</p>
        </section>
      )}
      {groups.map(({ st, files }) => (
        <section key={st}>
          <h3>
            {STATUS_WORD[st][0].toUpperCase() + STATUS_WORD[st].slice(1)} ({files.length})
          </h3>
          <ul className="rows">
            {files.slice(0, CHANGE_ROWS).map(f => {
              const note = r.tasks.map(t => t.notes[f.path]).find(Boolean)
              const tone = worstTone(findings.get(f.path))
              const exists = st !== 'removed' && !!store.getState().world?.node(`f:${f.path}`)
              return (
                <li key={f.path}>
                  <button className="row stacked" disabled={!exists} onClick={() => void actions.select(`f:${f.path}`, { from: CHANGES_ID })} title={note ?? f.path}>
                    <span className="name">
                      {tone && <span className={`finding-mark ${tone}`}>{TONE_MARK[tone]} </span>}
                      {f.path.slice(f.path.lastIndexOf('/') + 1)}
                    </span>
                    <span className="dim">
                      {f.added !== undefined ? `+${f.added} −${f.removed} · ` : ''}
                      {f.from ? `from ${f.from} · ` : ''}
                      {f.path.slice(0, f.path.lastIndexOf('/') + 1) || './'}
                    </span>
                    {note && <span className="change-note">{note}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {files.length > CHANGE_ROWS && <p className="dim">… and {files.length - CHANGE_ROWS} more (archrift diff lists them all)</p>}
        </section>
      ))}
    </>
  )
}

/** What Changes compares: the change in progress, the last commit, one commit, or everything since one. */
function RangePicker() {
  const range = useStore(store, s => s.changes.range)
  const [commits, setCommits] = useState<CommitInfo[]>([])
  useEffect(() => {
    let live = true
    api.commits().then(
      c => live && setCommits(c),
      () => live && setCommits([]),
    )
    return () => {
      live = false
    }
  }, [])
  const { mode, sha } = modeOf(range)
  // one commit is compared with its parent: the first commit has none
  const pickable = mode === 'commit' ? commits.filter(c => !c.root) : commits
  const choose = (next: RangeMode, at?: string) => {
    const first = next === 'commit' ? commits.find(c => !c.root)?.sha : (commits[1] ?? commits[0])?.sha
    void actions.compareChanges(rangeFor(next, at ?? first))
  }
  return (
    <div className="changes-range">
      <label>
        Compare{' '}
        <select aria-label="Compare" value={mode} onChange={e => choose(e.target.value as RangeMode)}>
          <option value="progress">the change in progress</option>
          <option value="last" disabled={!commits.length || !!commits[0].root}>
            the last commit
          </option>
          <option value="commit" disabled={!commits.some(c => !c.root)}>
            one commit…
          </option>
          <option value="since" disabled={!commits.length}>
            everything since a commit…
          </option>
        </select>
      </label>
      {(mode === 'commit' || mode === 'since') && (
        <select aria-label="Commit" value={sha} onChange={e => choose(mode, e.target.value)}>
          {sha && !pickable.some(c => c.sha === sha) && <option value={sha}>{sha.slice(0, 8)}</option>}
          {pickable.map(c => (
            <option key={c.sha} value={c.sha}>
              {c.sha.slice(0, 7)} · {c.subject.length > 60 ? `${c.subject.slice(0, 59)}…` : c.subject} · {day(c.date)}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** Which arcs the changed files get: the dependencies among them, or every one they have (one step, both ways). */
function ChangeEdgesSwitch() {
  const value = useStore(store, s => s.options.changeEdges)
  const choices = [
    ['between', 'only between the changed files'],
    ['all', 'to every file they use or are used by'],
  ] as const
  return (
    <fieldset className="change-edges">
      <legend>Edges</legend>
      {choices.map(([v, label]) => (
        <label key={v}>
          <input type="radio" name="change-edges" value={v} checked={value === v} onChange={() => actions.setOption('changeEdges', v)} /> {label}
        </label>
      ))}
    </fieldset>
  )
}

/** The commits a range spans, newest first: what each says it does (its message's body, opened). */
function Commits({ commits }: { commits: CommitInfo[] }) {
  if (!commits.length) return null
  return (
    <section className="change-commits">
      <h3>
        Commits ({commits.length}
        {commits.length === MAX_COMMITS ? '+' : ''})
      </h3>
      <ul className="rows">
        {commits.map(c => (
          <li key={c.sha}>
            <details>
              <summary>
                <span className="name">{c.subject}</span>
                <span className="dim">
                  {' '}
                  {c.sha.slice(0, 7)} · {c.author} · {day(c.date)}
                </span>
              </summary>
              {c.body ? <p className="commit-body">{c.body}</p> : <p className="dim">No message below the subject.</p>}
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A file's part in the change in progress: how it changed, why (the agent's note), what the diff finds in it. */
export function ChangedSection({ node }: { node: GraphNode }) {
  const files = useStore(store, s => s.changes.report?.files ?? NO_FILES)
  const report = useStore(store, s => s.changes.report)
  const f = files.find(x => `f:${x.path}` === node.id)
  if (!f || !report) return null
  const findings = findingsByFile(report.diff).get(f.path) ?? []
  const notes = notesFor(report.tasks, f.path)
  return (
    <section className="changed">
      <h3>
        {STATUS_WORD[f.status]} since {report.base.label}
        {f.added !== undefined && (
          <span className="dim">
            {' '}
            · +{f.added} −{f.removed}
          </span>
        )}
      </h3>
      {notes.map(({ task, note }, k) => (
        <p key={k} className="change-note">
          {task.title && <b>{task.title}: </b>}
          {note}
        </p>
      ))}
      {findings.length > 0 && (
        <ul className="rows">
          {findings.map((x, k) => (
            <FindingRow key={k} f={x} />
          ))}
        </ul>
      )}
      <div className="actions">
        <button onClick={() => void actions.showChanges()}>All changes</button>
      </div>
    </section>
  )
}
