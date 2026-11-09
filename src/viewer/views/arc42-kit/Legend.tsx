// arc42 kit: the legend every arc42 view shows. Its chapter and title, what
// the section answers, the view's own key, and what the code can't tell.
import type { ReactNode } from 'react'
import { SECTIONS } from './sections.ts'
import type { Arc42Section } from './sections.ts'
import './arc42.css'

export function Arc42Legend({ section, children, note }: { section: Arc42Section; children?: ReactNode; note?: ReactNode }) {
  const s = SECTIONS[section]
  return (
    <div className="a42-legend">
      <div className="a42-legend-head">
        <span className="a42-badge">arc42 §{s.number}</span>
        <b>{s.title}</b>
      </div>
      <div className="dim">{s.about}</div>
      {children && <div className="swatches">{children}</div>}
      {note && <div>{note}</div>}
      <div className="a42-limits">{s.limits}</div>
    </div>
  )
}

/** A swatch: a color (a box, a line, a dot or a ring) and what it stands for. */
export function Swatch({ color, shape = 'box', children }: { color: string; shape?: 'box' | 'line' | 'dot' | 'ring' | 'dashed'; children: ReactNode }) {
  const style =
    shape === 'line'
      ? { background: color, width: 16, height: 3, borderRadius: 2 }
      : shape === 'dashed'
        ? { background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`, width: 16, height: 3 }
        : shape === 'dot'
          ? { background: color, borderRadius: '50%' }
          : shape === 'ring'
            ? { background: 'transparent', boxShadow: `inset 0 0 0 2px ${color}`, borderRadius: '50%' }
            : { background: color }
  return (
    <span>
      <i style={style} />
      {children}
    </span>
  )
}
