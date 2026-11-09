// Runtime view: its key, in the arc42 legend.
import { useStore } from 'zustand'
import { Arc42Legend, Swatch } from '../arc42-kit/Legend.tsx'
import { runtime } from './choice.ts'

export function Legend() {
  const shown = useStore(runtime, s => s.shown)
  return (
    <Arc42Legend
      section="runtime"
      note={
        shown && (
          <span className="dim">
            {shown.name}: {shown.participants} lifelines, {shown.messages} messages{shown.fragments ? `, ${shown.fragments} alt` : ''}
            {shown.data.length ? `, reaches ${shown.data.join(' and ')}` : ''}
            {shown.left ? ` (${shown.left} more calls left out; ⋯ goes on like a call above)` : ''}. Bars stand out by call depth.
          </span>
        )
      }
    >
      <Swatch color="var(--muted)" shape="line">
        call, render, new
      </Swatch>
      <Swatch color="var(--accent)" shape="line">
        over the network (tRPC)
      </Swatch>
      <Swatch color="var(--warn)" shape="line">
        query a database
      </Swatch>
      <Swatch color="var(--text)" shape="ring">
        alt: one of the classes behind an interface
      </Swatch>
    </Arc42Legend>
  )
}
