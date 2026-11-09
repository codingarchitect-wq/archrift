// Classes view: its key and what's shown.
import { useStore } from 'zustand'
import { AREA_PALETTE } from '../../colors.ts'
import { Swatch } from '../arc42-kit/Legend.tsx'
import { DiagramLegend, Mark } from '../diagram-kit/Legend.tsx'
import { KIND_TONE } from './model.ts'
import { classes } from './state.ts'

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

/** A kind's band color (the categorical color the cards tint their band with). */
const kindColor = (kind: keyof typeof KIND_TONE) => AREA_PALETTE[Number(KIND_TONE[kind].slice(4))]

export function Legend() {
  const shown = useStore(classes, s => s.shown)
  const mode = useStore(classes, s => s.mode)
  const none = useStore(classes, s => !!s.choices && !s.choices.folders.length)
  return (
    <DiagramLegend
      kind="classes"
      note={
        none ? (
          <span className="dim">No classes, interfaces or types in this graph.</span>
        ) : (
          shown && (
            <span className="dim">
              {shown.title}: {count(shown.types, 'type')}, {shown.extends} extends, {shown.implements} implements, {count(shown.associations + shown.arcs, 'association')}
              {shown.arcs ? ` (${shown.arcs} to a type most others hold: arcs, shown for the selected type)` : ''}
              {shown.outside ? ` · ${shown.outside} named from ${mode === 'folder' ? 'elsewhere' : 'outside the project'} (dashed)` : ''}
              {' · select a type to open all its members'}
            </span>
          )
        )
      }
    >
      <Swatch color={kindColor('class')}>class</Swatch>
      <Swatch color={kindColor('interface')}>interface</Swatch>
      <Swatch color={kindColor('type')}>type alias</Swatch>
      <Swatch color={kindColor('enum')}>enum</Swatch>
      <Mark shape="triangle">extends</Mark>
      <Mark shape="dashed-triangle">implements</Mark>
      <Mark shape="arrow">holds (a property; * many)</Mark>
    </DiagramLegend>
  )
}
