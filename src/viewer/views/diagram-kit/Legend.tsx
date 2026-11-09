// Diagram kit: the legend both diagram views show, in the arc42 views' style:
// the diagram's name, what it answers, the view's key, a note about what is
// shown, and what the code can't tell.
import type { ReactNode } from 'react'
import { DIAGRAM_INFO } from './sections.ts'
import type { DiagramKind } from './sections.ts'
import '../arc42-kit/arc42.css'
import './diagrams.css'

export function DiagramLegend({ kind, children, note, extra }: { kind: DiagramKind; children?: ReactNode; note?: ReactNode; extra?: ReactNode }) {
  const d = DIAGRAM_INFO[kind]
  return (
    <div className="a42-legend dg-legend">
      <div className="a42-legend-head">
        <span className="a42-badge">diagram</span>
        <b>{d.title}</b>
      </div>
      <div className="dim">{d.about}</div>
      {children && <div className="swatches">{children}</div>}
      {note && <div>{note}</div>}
      {extra}
      <div className="a42-limits">{d.limits}</div>
    </div>
  )
}

/** A mark as the diagram draws it (a connector's end, a key), drawn small in SVG. */
export function Mark({ shape, children }: { shape: 'key' | 'crow' | 'bar' | 'bar-ring' | 'triangle' | 'dashed-triangle' | 'arrow' | 'arc'; children: ReactNode }) {
  return (
    <span>
      <svg className="dg-mark" width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
        {MARKS[shape]}
      </svg>
      {children}
    </span>
  )
}

const LINE = { stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }

const MARKS: Record<string, ReactNode> = {
  key: (
    <g {...LINE} stroke="var(--warn)">
      <circle cx="7" cy="6" r="3" />
      <path d="M10 6h10M17 6v3M20 6v2.4" />
    </g>
  ),
  crow: (
    <g {...LINE}>
      <path d="M0 6h26M18 6l8-5M18 6l8 5" />
      <circle cx="13" cy="6" r="2.4" fill="var(--panel-solid)" />
    </g>
  ),
  bar: (
    <g {...LINE}>
      <path d="M0 6h26M19 1v10M22.5 1v10" />
    </g>
  ),
  'bar-ring': (
    <g {...LINE}>
      <path d="M0 6h26M21 1v10" />
      <circle cx="15" cy="6" r="2.4" fill="var(--panel-solid)" />
    </g>
  ),
  triangle: (
    <g {...LINE}>
      <path d="M0 6h17M17 1l8 5-8 5z" fill="var(--panel-solid)" />
    </g>
  ),
  'dashed-triangle': (
    <g {...LINE}>
      <path d="M0 6h17" strokeDasharray="3 2" />
      <path d="M17 1l8 5-8 5z" fill="var(--panel-solid)" />
    </g>
  ),
  arrow: (
    <g {...LINE}>
      <path d="M0 6h25M19 2l6 4-6 4" />
    </g>
  ),
  arc: (
    <g {...LINE}>
      <path d="M1 11Q13 -5 25 11" />
    </g>
  ),
}
