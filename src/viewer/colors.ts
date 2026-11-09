// Color encodings: area (the file's district), a metric heatmap,
// and symbol kinds for floors. Scene colors are hex strings turned into
// THREE.Color by the controller.

export const AREA_PALETTE = [
  '#4e79a7',
  '#59a14f',
  '#f28e2b',
  '#b07aa1',
  '#76b7b2',
  '#edc948',
  '#e15759',
  '#ff9da7',
  '#9c755f',
  '#86bcb6',
  '#d4a6c8',
  '#a0cbe8',
]

export const SUBKIND_COLORS: Record<string, string> = {
  component: '#6ea8fe',
  hook: '#3dd5c1',
  function: '#8fd16a',
  class: '#f0a35e',
  interface: '#c49bf5',
  type: '#a8a0f0',
  enum: '#e8c547',
  variable: '#9fb0c2',
  namespace: '#e889b5',
  'default-export': '#f2dc7c',
  // from plugins
  model: '#4fc3a1',
  context: '#f78fb3',
  directive: '#9ec5fe',
  pipe: '#c3e88d',
  service: '#ffb86b',
  module: '#d08770',
}

export const OUT_COLOR = '#35c8ff'
export const IN_COLOR = '#ff9b3d'
/** Layers view: a dependency pointing up, against the layering. */
export const UP_COLOR = '#ff3b5c'
/** Path finder arcs. */
export const PATH_COLOR = '#b26bff'
/** Arcs inside an import cycle. */
export const CYCLE_COLOR = '#ff5a36'
export const NEUTRAL = '#8b95a5'
/** Files that change together (git co-change). */
export const CO_CHANGE_COLOR = '#e05cf5'
/** Timeline: new since the previous point, grown, shrunk. */
export const ADDED_COLOR = '#3fb950'
export const GROWN_COLOR = '#35a4ff'
export const SHRUNK_COLOR = '#ff9b3d'
/** A broken architecture rule, an error or a warning alike (the words and marks tell them apart). */
export const VIOLATION_COLOR = '#ff2d55'
/** Amber: caution, the middle of a calm-to-hot scale (the arc42 ink's warn tone); never a broken rule. */
export const WARNING_COLOR = '#ffb020'

/** 0 → cool blue, 0.5 → yellow, 1 → red. */
export function heat(t: number): string {
  const stops = [
    [0.26, 0.44, 0.78],
    [0.93, 0.79, 0.28],
    [0.88, 0.25, 0.25],
  ]
  const x = Math.min(Math.max(t, 0), 1) * 2
  const i = Math.min(Math.floor(x), 1)
  const f = x - i
  const c = stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f)
  return `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
}
