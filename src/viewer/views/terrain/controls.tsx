// Terrain view: the toolbar's "height" select, what raises the ground.
// Churn and hotspots are offered only when the graph has a git history.
import { useSyncExternalStore } from 'react'
import { METRICS, chooseMetric, chosenMetric, historyAvailable, onMetricChange } from './metric.ts'
import type { Metric } from './metric.ts'

export function TerrainControls() {
  const metric = useSyncExternalStore(onMetricChange, chosenMetric)
  const history = useSyncExternalStore(onMetricChange, historyAvailable)
  const offered = METRICS.filter(m => history || !m.history)
  return (
    <label className="group" title="What raises the ground: hard code becomes mountains, calm code plains">
      height
      <select value={offered.some(m => m.id === metric) ? metric : 'complexity'} onChange={e => chooseMetric(e.target.value as Metric)}>
        {offered.map(m => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  )
}
