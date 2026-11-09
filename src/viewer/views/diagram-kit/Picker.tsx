// Diagram kit: a toolbar button opening a list to pick from (a database, a
// type family, a folder), closed by a pick, Escape or a click elsewhere.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './diagrams.css'

export function Picker({ label, title, ariaLabel, width = 340, children }: { label: string; title: string; ariaLabel: string; width?: number; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // the Escape closes this, and doesn't also clear the selection
      setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} title={title}>
        {label} ▾
      </button>
      {open && (
        <div className="panel popover dg-picker" role="menu" aria-label={ariaLabel} style={{ left: 0, right: 'auto', width }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
