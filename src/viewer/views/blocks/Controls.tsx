// §5 Building Block View: its legend (what the diagram's marks mean, and
// what it shows). Which dependencies are drawn is the toolbar's edges option.
import { useStore } from 'zustand'
import { UP_COLOR, VIOLATION_COLOR } from '../../colors.ts'
import { Arc42Legend, Swatch } from '../arc42-kit/Legend.tsx'
import { settings } from './settings.ts'
import './blocks.css'

/** What each edges option draws here, for the legend. */
const DRAWN: Record<string, string> = {
  main: 'the main ones (edges → all: every one)',
  all: 'every one',
  selection: 'the selected block’s',
  violations: 'those that break a rule',
  none: 'none (edges → none)',
}

export function Legend() {
  const summary = useStore(settings, s => s.summary)
  return (
    <Arc42Legend
      section="blocks"
      note={
        summary && (
          <span className="dim">
            {summary.title}: {summary.blocks} blocks, {summary.shown === summary.links ? `${summary.links}` : `${summary.shown} of ${summary.links}`} dependencies
            {summary.up ? `, ${summary.up} pointing up` : ''} · drawn: {DRAWN[summary.mode] ?? summary.mode}
            {summary.mode === 'selection' && !summary.focused ? ' · select a block to see its dependencies' : ''}
            {summary.levels === 1 ? ' · select a block to open its white box' : ''}
          </span>
        )
      }
    >
      <Swatch color="var(--muted)" shape="line">
        uses (thicker: more references)
      </Swatch>
      {summary?.mode === 'violations' ? (
        <Swatch color={VIOLATION_COLOR} shape="line">
          breaks a rule
        </Swatch>
      ) : (
        <Swatch color={UP_COLOR} shape="line">
          {summary?.upMeans ?? 'points up, against the layers'}
        </Swatch>
      )}
      <Swatch color="var(--text)" shape="ring">
        provided interface: files used outside
      </Swatch>
      <Swatch color="var(--muted)" shape="dashed">
        neighbor of a white box
      </Swatch>
    </Arc42Legend>
  )
}
