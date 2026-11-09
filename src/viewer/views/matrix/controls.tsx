// The Matrix view's toolbar controls (the digital rain on or off) and its
// legend, which stands where the minimap does in other views.
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CYCLE_COLOR, UP_COLOR, VIOLATION_COLOR } from '../../colors.ts'
import { rain, setRain, summary } from './settings.ts'
import type { MatrixSummary } from './settings.ts'

const METRIC: Record<MatrixSummary['metric'], string> = {
  churn: 'lines changed recently (churn)',
  commits: 'commits',
  fanIn: 'fan-in (no git history)',
}

export function MatrixControls() {
  const on = useSyncExternalStore(rain.subscribe, rain.get)
  const found = useSyncExternalStore(summary.subscribe, summary.get)
  return (
    <>
      <div className="group matrix-controls">
        <button
          aria-pressed={on}
          onClick={() => setRain(!on)}
          title={`Digital rain down every column, faster and denser by ${found ? METRIC[found.metric] : 'recent change'}`}
        >
          rain
        </button>
      </div>
      {found && createPortal(<Legend found={found} />, document.body)}
    </>
  )
}

function Legend({ found }: { found: MatrixSummary }) {
  const n = (count: number) => count.toLocaleString('en-US')
  return (
    <aside className="panel matrix-legend" aria-label="Matrix legend">
      <h3>row uses column</h3>
      <span title="Brighter: more references">
        <i className="uses" />
        {n(found.cells)} dependencies
      </span>
      <span title="The column's layer is above the row's: it breaks the layering">
        <i style={{ background: UP_COLOR }} />
        points up: {n(found.up)}
      </span>
      <span title="Both files are in one import cycle (drawn as a ring)">
        <i style={{ background: CYCLE_COLOR }} />
        in a cycle: {n(found.cycle)}
      </span>
      <span title="A configured rule forbids it (drawn with a rim)">
        <i style={{ background: VIOLATION_COLOR }} />
        breaks a rule: {n(found.violation + found.warning)}
      </span>
      <span className="dim">
        {n(found.rows)} {found.depth === null ? 'files' : `folders (depth ${found.depth})`}; rain: {METRIC[found.metric]}
      </span>
    </aside>
  )
}
