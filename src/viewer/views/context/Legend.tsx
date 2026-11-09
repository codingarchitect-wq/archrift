// The §3 Context view's key: what the tubes' colors and dots mean, and how
// many packages are libraries rather than neighbors.
import { useSyncExternalStore } from 'react'
import { Arc42Legend, Swatch } from '../arc42-kit/Legend.tsx'
import { legendSummary } from './state.ts'

/** The outbound color in both schemes (sideColor in decoration.ts). */
const OUTBOUND = 'light-dark(#8250df, #a371f7)'
const SHOWN_LIBRARIES = 4

export function Legend() {
  const summary = useSyncExternalStore(legendSummary.subscribe, legendSummary.get)
  const libraries = summary?.libraries ?? []
  return (
    <Arc42Legend
      section="context"
      note={
        libraries.length ? (
          <span className="dim" title={libraries.join(', ')}>
            {libraries.length} {libraries.length === 1 ? 'library' : 'libraries'} (not neighbors): {libraries.slice(0, SHOWN_LIBRARIES).join(', ')}
            {libraries.length > SHOWN_LIBRARIES ? ' …' : ''}
          </span>
        ) : null
      }
    >
      <Swatch color="var(--accent)" shape="line">
        calls into the system
      </Swatch>
      <Swatch color={OUTBOUND} shape="line">
        services it calls
      </Swatch>
      <Swatch color="var(--ok)" shape="line">
        data it keeps
      </Swatch>
      <Swatch color="var(--muted)" shape="dot">
        dots: which way requests go
      </Swatch>
      <span className="dim">a tie enters the tower at the layer whose code uses it</span>
    </Arc42Legend>
  )
}
