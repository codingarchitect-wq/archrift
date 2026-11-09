// Coherence (a view plug-in; docs/COHERENCE.md): how many ways the code does
// each job, after "Decoherence" (maevyn.codes/decoherence): a system
// decoheres as locally valid but redundant models of one job pile up. Two
// modes, chosen in the toolbar:
//   City: the city painted by the way each file does the job picked (dates,
//   HTTP calls, test doubles …), the main way blue, files on several ways
//   magenta, arcs where two ways meet. With no job picked, files glow by how
//   many jobs they do differently from the rest of their folder (or group).
//   Clouds: the essay's pictures. Files are dots pulled together by their
//   dependencies, each service or folder a lobe; one small cloud per job
//   done several ways, side by side, colored by way. A clean job is a cloud
//   whose colors gather; a mixed one is speckled. Click one to open it.
// The toolbar's report ranks the jobs.
import type * as THREE from 'three'
import { Color } from 'three'
import { dirId } from '../../../core/ids.ts'
import { cityLayout } from '../../layouts/city.ts'
import { groupedLayout } from '../../layouts/grouped.ts'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { labelOf } from '../../store.ts'
import { anchor } from '../arc42-kit/anchors.ts'
import type { ViewPlugin } from '../types.ts'
import { choice, publish, setRefresh, shownConcern } from './choice.ts'
import { cloudScenes, cloudsLayout } from './clouds.ts'
import './coherence.css'
import { Controls } from './Controls.tsx'
import { CoherenceDecoration } from './decoration.ts'
import { Legend } from './Legend.tsx'
import { coherenceFor, fileColor, pct, relatedOf, titleOf } from './model.ts'

/** Each city layout's label places: the heading, and one per block (the middle of its files). */
const places = new WeakMap<Layout, { heading: boolean; blocks: Map<string, string> }>()

const coherence: ViewPlugin = {
  id: 'coherence',
  label: 'Coherence',
  description: 'How many ways the code does each job (dates, HTTP calls, test doubles …): the city or clouds of dots, colored by the way each file takes',
  // after the arc42 menu, which keeps its key (9)
  order: 200,

  // the clouds lay out differently for one job than for all of them; the city doesn't
  layoutKey: () => {
    const { mode, picked } = choice.getState()
    return mode === 'clouds' ? `clouds|${picked ?? ''}` : 'city'
  },

  layout(ctx) {
    setRefresh(ctx.refresh)
    const c = coherenceFor(ctx.world, ctx.grouping)
    publish(c)
    // a concern the graph doesn't have (another project's) shows all of them
    if (choice.getState().picked && !shownConcern(c)) choice.setState({ picked: null })
    if (choice.getState().mode === 'clouds') return cloudsLayout(ctx, c, shownConcern(c))

    // the city as the toolbar groups it; on the timeline everything that ever existed keeps its place
    const s = ctx.s
    const nodes = (s.options.timeline && s.union ? s.union : s.liveBase) ?? ctx.world.graph.nodes
    const input = { nodes, rootId: ctx.world.rootId, isVisible: ctx.visibility.isVisible }
    const city = ctx.grouping ? groupedLayout({ ...input, groups: ctx.grouping.groups, groupOf: f => ctx.grouping!.groupOf(f.id) }) : cityLayout(input)
    const layout: Layout = { ...city, view: 'coherence' }
    // the present only: a file the timeline's union holds but this point in time doesn't stays out
    for (const id of [...layout.boxes.keys()])
      if (layout.placement.get(id) === 'building' && !ctx.world.node(id)) {
        layout.boxes.delete(id)
        layout.placement.delete(id)
      }
    // labels: the heading over the north-west corner, a block's note over the middle of its files
    let minX = Infinity
    let minZ = Infinity
    const sums = new Map<string, { x: number; z: number; y: number; n: number }>()
    for (const [id, b] of layout.boxes) {
      minX = Math.min(minX, b.x - b.w / 2)
      minZ = Math.min(minZ, b.z - b.d / 2)
      if (layout.placement.get(id) !== 'building') continue
      const n = ctx.world.node(id)
      const block = n && c.model.ways.has(id) ? c.blocks.of(n) : undefined
      if (block === undefined) continue
      const sum = sums.get(block) ?? { x: 0, z: 0, y: 0, n: 0 }
      sum.x += b.x
      sum.z += b.z
      sum.y = Math.max(sum.y, b.y + b.h)
      sum.n++
      sums.set(block, sum)
    }
    const heading = Number.isFinite(minX)
    if (heading) anchor(layout, 'coh:heading', [minX, 0, minZ - Math.max(4, layout.size * 0.02)], layout.size)
    const blocks = new Map<string, string>()
    ;[...sums].forEach(([block, sum], i) => {
      const id = `coh:block:${i}`
      anchor(layout, id, [sum.x / sum.n, sum.y + 2, sum.z / sum.n], 8)
      blocks.set(block, id)
    })
    places.set(layout, { heading, blocks })
    return layout
  },

  decoration: (_ctx, engine) => new CoherenceDecoration(engine),

  // the automatic background arcs (every dependency) say nothing about coherence: they step aside here.
  // A selection's own arcs, and edges the toolbar asks for by name, stay.
  routeArc(ctx, _layout, arc) {
    return arc.width !== undefined && ctx.s.options.edges === 'auto' ? null : arc
  },

  colors(ctx, layout, colors) {
    if (cloudScenes.has(layout)) return // the clouds paint their own dots
    const c = coherenceFor(ctx.world, ctx.grouping)
    const concern = shownConcern(c)
    const related = relatedOf(ctx)
    const ghost = new Color(ctx.theme.background)
    const quiet = new Color(ctx.theme.district).lerp(ghost, 0.2)
    for (const [id, placement] of layout.placement) {
      if (placement !== 'building') continue
      const hex = fileColor(c, concern, id)
      const color: THREE.Color = hex ? new Color(hex) : quiet.clone()
      if (related && !related.has(id)) color.lerp(ghost, 0.8)
      if (id === ctx.s.selected) color.lerp(new Color('#ffffff'), 0.45)
      colors.set(id, color)
    }
  },

  labels(ctx, layout): LabelSpec[] {
    const c = coherenceFor(ctx.world, ctx.grouping)
    const concern = shownConcern(c)
    const t = c.model.totals
    const where = c.blocks.kind === 'group' ? 'group' : 'folder'
    const summary = !c.measured
      ? 'Coherence: not measured in this graph (analyzed before archrift measured it): restart archrift serve'
      : !t.concerns
        ? 'Coherence: no file does a job of the catalog'
        : `Coherence: ${t.decoherent} of ${t.concerns} jobs are done more than one way inside a ${where} · ${t.strays.toLocaleString('en-US')} files differ from their ${where}`
    const detail = (x: NonNullable<typeof concern>) =>
      `${titleOf(x)}: ${x.paradigms.map(w => `${w.label} ${w.files.length}`).join(' · ')}${x.ways > 1 ? ` · ${pct(x.local)} the same way as their ${where}` : ''}`
    const scene = cloudScenes.get(layout)
    if (scene) {
      const text = concern ? detail(concern) : `${summary} · one dot per file, one cloud per job: speckled means mixed · click a cloud to open it`
      const specs: LabelSpec[] = [{ id: 'coh:heading', text, priority: 995, className: 'a42-heading a42-left coh-heading' }]
      if (scene.kind === 'clouds')
        scene.clouds.forEach((cloud, k) => {
          const x = cloud.concern
          const note = x.ways === 1 ? 'one way' : x.concern.accepted ? 'accepted' : x.kind === 'per-block' ? `one way per ${where}` : `${pct(x.local)} same way`
          specs.push({ id: `coh:cloud:${k}`, text: `${titleOf(x)} · ${note}`, priority: 900 - k, className: 'a42-left coh-caption', minScreenWidth: 12 })
        })
      return specs
    }
    const p = places.get(layout)
    if (!p) return []
    const specs: LabelSpec[] = []
    if (p.heading) specs.push({ id: 'coh:heading', text: concern ? detail(concern) : summary, priority: 995, className: 'a42-heading a42-left coh-heading' })
    // blocks: how many ways they mix the job shown in, or how many extra ways they make a reader learn
    const notes = new Map<string, string>()
    if (concern) for (const b of concern.blocks) if (b.paradigms.length > 1) notes.set(b.block, `${b.paradigms.length} ways`)
    if (!concern) for (const b of c.model.blocks) if (b.load > 0) notes.set(b.block, `+${b.load} way${b.load === 1 ? '' : 's'} to learn`)
    for (const [block, note] of notes) {
      const id = p.blocks.get(block)
      if (id) specs.push({ id, text: `${c.blocks.kind === 'folder' ? labelOf(ctx.s, dirId(block), block) : c.blocks.name(block)} · ${note}`, priority: 650, className: 'coh-block' })
    }
    return specs
  },

  Controls,
  Legend,
}

export default coherence
