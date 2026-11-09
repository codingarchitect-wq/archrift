// Tables (ERD), a view plug-in in the toolbar's Diagrams menu: the database
// schemas the code declares (graph.meta.databases: Prisma, Dexie, SQL
// migrations, JPA and Mongo entities) as entity–relationship diagrams, one
// board per database, boards grouped by module. Tables are cards with a row
// per column; foreign keys join the referencing row to the referenced one,
// crow's-foot marks at their ends. Selecting a table opens it with every
// column, lights the tables it's joined to, and lists who reads and writes
// it in the legend; selecting a file lights the tables it queries.
import type { DatabaseMeta } from '../../../core/model.ts'
import type { World } from '../../world.ts'
import { DiagramDecoration } from '../diagram-kit/decoration.ts'
import { boardLabels, cardLabels, diagramLayout, noteLabels, noteLayout } from '../diagram-kit/layout.ts'
import { diagramScenes } from '../diagram-kit/decoration.ts'
import { focusOn } from '../diagram-kit/scene.ts'
import { DIAGRAMS, DIAGRAM_INFO } from '../diagram-kit/sections.ts'
import type { ViewPlugin } from '../types.ts'
import { Controls } from './Controls.tsx'
import { ErdDecoration, cardFor, queriedBy } from './decoration.ts'
import { Legend } from './Legend.tsx'
import { erdScene } from './model.ts'
import type { ErdScene } from './model.ts'
import { erd, publishDatabases, publishShown, setRefresh } from './state.ts'

/** The window's shape, which the boards are packed toward (in steps, so a small resize keeps the layout). */
const aspect = () => (typeof innerWidth === 'number' && innerWidth > 200 && innerHeight > 200 ? Math.round((innerWidth / innerHeight) * 5) / 5 : 1.6)

let cached: { world: World; key: string; scene: ErdScene } | undefined

function sceneOf(world: World, databases: readonly DatabaseMeta[]): ErdScene {
  const s = erd.getState()
  const key = `${s.database}|${s.relations}|${aspect()}`
  if (cached?.world === world && cached.key === key) return cached.scene
  // a database the option names that this graph doesn't have: all of them
  const database = databases.some(d => d.id === s.database) ? s.database : null
  const scene = erdScene(databases, { database, relations: s.relations, aspect: aspect() })
  cached = { world, key, scene }
  return scene
}

const view: ViewPlugin = {
  id: 'erd',
  label: DIAGRAM_INFO.erd.label,
  description: 'The database schemas the code declares, as entity–relationship diagrams: tables with their columns and keys, foreign keys between them',
  order: DIAGRAM_INFO.erd.order,
  group: DIAGRAMS,
  groupBy: false,
  edges: false,

  layoutKey: () => {
    const s = erd.getState()
    return `${s.database}|${s.relations}|${aspect()}`
  },

  layout(ctx) {
    setRefresh(ctx.refresh)
    const databases = ctx.world.graph.meta.databases ?? []
    publishDatabases(databases)
    if (!databases.length) {
      publishShown(null)
      return noteLayout('erd', ['No database schema found', 'The graph was analyzed before schemas were read, or the code declares none (Prisma, Dexie, SQL migrations, JPA or Mongo entities).'])
    }
    const scene = sceneOf(ctx.world, databases)
    const hubs = [...new Set(scene.arcs.map(a => scene.cards[a.to].content.title))]
    publishShown({ boards: scene.boards.length, tables: scene.cards.length, links: scene.links.length, arcs: scene.arcs.length, hubs })
    return diagramLayout('erd', scene, !!ctx.s.selected)
  },

  decoration: (_ctx, engine): DiagramDecoration => new ErdDecoration(engine),

  labels(ctx, layout) {
    const scene = diagramScenes.get(layout) as ErdScene | undefined
    if (!scene) return noteLabels('erd', layout)
    const selected = ctx.s.selected
    const focus = focusOn(scene, cardFor(scene, selected)) ?? (selected ? queriedBy(scene, selected) : null)
    return [...boardLabels('erd', scene), ...cardLabels('erd', scene, focus)]
  },

  Controls,
  Legend,
}

export default view
