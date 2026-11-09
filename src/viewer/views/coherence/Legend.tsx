// The Coherence view's key: with all jobs, what the colors (city) or the
// clouds mean; with a job picked, its ways, what magenta, grey and the arcs
// or lines mean, and a way to show the tests when the job is theirs. Over the
// clouds, first how to read one, after the essay's legend: what a dot, its
// size, its color and a line stand for (the lines the edges option lets through).
import { useStore } from 'zustand'
import { VIOLATION_COLOR } from '../../colors.ts'
import { actions, store } from '../../store.ts'
import type { EdgeMode } from '../../store.ts'
import { choice } from './choice.ts'
import { MIXED_COLOR, WAY_COLORS, groupColor, strayHeat } from './model.ts'

/** Groups the key names by color; the rest are counted. */
const GROUPS = 10

/** The edges option draws the job's lines (all, or the selection's), not only the rule breakers or none. */
const jobLines = (edges: EdgeMode) => edges !== 'none' && edges !== 'violations'

/** What a line in the clouds is, as the edges option has it. */
function lineMeaning(edges: EdgeMode, selected: boolean) {
  if (edges === 'none') return 'none drawn (edges: none)'
  if (edges === 'violations') return 'a dependency that breaks a rule'
  if (edges === 'selection') return selected ? 'a dependency around the selection' : 'none until a file is selected (edges: selection)'
  return 'one file depends on the other'
}

export function Legend() {
  const mode = useStore(choice, s => s.mode)
  if (mode !== 'clouds') return <Key />
  return (
    <>
      <Reading />
      <Key />
    </>
  )
}

/** How to read a cloud: the essay's legend, said for files. */
function Reading() {
  const { picked, paint, report } = useStore(choice)
  const edges = useStore(store, s => s.options.edges)
  const selected = useStore(store, s => !!s.selected)
  const where = report?.blockKind === 'group' ? 'group' : 'folder'
  return (
    <div className="swatches coh-reading">
      <span>
        <i className="coh-dot" />
        <b>Dot</b> a file doing some job
      </span>
      <span>
        <i className="coh-dot small" />
        <i className="coh-dot" />
        <b>Size</b> its lines of code
      </span>
      <span>
        <i className="coh-dot" style={{ background: paint === 'groups' ? groupColor(0) : WAY_COLORS[0] }} />
        <b>Color</b> {paint === 'groups' ? `its ${where}` : picked ? 'the way it does the job' : 'the way it does its cloud’s job'}
      </span>
      <span>
        <i className="coh-edge" style={edges === 'violations' ? { background: VIOLATION_COLOR } : undefined} />
        <b>Line</b> {lineMeaning(edges, selected)}
      </span>
      <span>
        <b>Place</b> close: they depend on each other; a lobe: a {where}
      </span>
    </div>
  )
}

function Key() {
  const { picked, mode, paint, report, groups } = useStore(choice)
  const tests = useStore(store, s => s.options.tests)
  const lines = jobLines(useStore(store, s => s.options.edges))
  const row = report?.concerns.find(c => c.id === picked)
  const where = report?.blockKind === 'group' ? 'group' : 'folder'
  if (mode === 'clouds' && paint === 'groups')
    return (
      <div className="swatches">
        {groups.slice(0, GROUPS).map(g => (
          <span key={g.name}>
            <i style={{ background: g.color }} />
            {g.name}
          </span>
        ))}
        {groups.length > GROUPS && <span className="dim">+{groups.length - GROUPS} more</span>}
        <span>
          <i className="coh-ring" />
          {row ? 'does it' : 'does the job'} differently from its {where}
        </span>
        <span className="dim">faint: {row ? 'doesn’t do it' : 'doesn’t do the job'}{row && row.transitions > 0 && lines ? ' · light lines: transitions between two ways' : ''}</span>
      </div>
    )
  if (!row && mode === 'clouds')
    return (
      <div className="swatches">
        <span className="dim">one cloud per job done several ways:</span>
        <span>
          <i style={{ background: WAY_COLORS[0] }} />
          <i style={{ background: WAY_COLORS[1] }} />
          its ways (blue: the most common)
        </span>
        <span>
          <i style={{ background: MIXED_COLOR }} />
          several ways in one file
        </span>
        <span>
          <i className="coh-quiet" />
          doesn’t do the job
        </span>
        <span className="dim">colors gathered: coherent · speckled: mixed · click a cloud to open it</span>
      </div>
    )
  if (!row)
    return (
      <div className="swatches">
        <span>
          <i style={{ background: strayHeat(0) }} />
          does every job the way its {where} does
        </span>
        {['1 job', '2 jobs', '3 or more'].map((label, i) => (
          <span key={label}>
            <i style={{ background: strayHeat(i + 1) }} />
            {label} differently
          </span>
        ))}
        <span>
          <i className="coh-quiet" />
          does none of the jobs
        </span>
        <span className="dim">pick a job in the toolbar to see its ways</span>
      </div>
    )
  return (
    <div className="swatches">
      {row.ways.map(w => (
        <span key={w.id}>
          <i style={{ background: w.color }} />
          {w.label}
          {w.legacy ? ' (legacy)' : ''} · {w.files.toLocaleString('en-US')}
        </span>
      ))}
      {row.mixed > 0 && (
        <span>
          <i style={{ background: MIXED_COLOR }} />
          several ways in one file · {row.mixed}
        </span>
      )}
      <span>
        <i className="coh-quiet" />
        doesn’t do it
      </span>
      {row.transitions > 0 && lines && (
        <span>
          <i className="coh-arc" />
          transition: a dependency between two ways
        </span>
      )}
      {mode === 'clouds' && lines && <span className="dim">grey lines: dependencies within one way</span>}
      {row.tests && !tests && (
        <span>
          <span className="dim">a job of the tests, which are hidden:</span>
          <button className="coh-show-tests" onClick={() => actions.setOption('tests', true)}>
            show tests
          </button>
        </span>
      )}
    </div>
  )
}
