// Classes, a view plug-in in the toolbar's Diagrams menu: a class diagram of
// a family of types joined by extends and implements (the biggest first, the
// ones with classes before the rest), or of the types declared in one folder
// (the one selected in the viewer, or picked) with the associations between
// them. UML-like cards with their members; bases above their subtypes.
// Selecting a type opens it with all its members and lights the types it's
// related to; a member's row selects the member. The diagrams come from the
// server, which has the symbols the viewer's overview leaves out.
import type { ClassDiagram } from '../../../core/classes.ts'
import { store } from '../../store.ts'
import { diagramScenes } from '../diagram-kit/decoration.ts'
import type { DiagramDecoration } from '../diagram-kit/decoration.ts'
import { boardLabels, cardLabels, diagramLayout, noteLabels, noteLayout } from '../diagram-kit/layout.ts'
import { focusOn } from '../diagram-kit/scene.ts'
import { DIAGRAMS, DIAGRAM_INFO } from '../diagram-kit/sections.ts'
import type { ViewPlugin } from '../types.ts'
import { Controls } from './Controls.tsx'
import { ClassesDecoration, cardFor, declaredIn } from './decoration.ts'
import { Legend } from './Legend.tsx'
import { captionOf, classScene } from './model.ts'
import type { ClassScene } from './model.ts'
import { choicesFor, classes, currentFamily, currentFolder, diagramFor, publishShown, setRefresh, startAt } from './state.ts'
import type { Mode } from './state.ts'

/** The window's shape, which the diagram is laid out toward (in steps, so a small resize keeps it). */
const aspect = () => (typeof innerWidth === 'number' && innerWidth > 200 && innerHeight > 200 ? Math.round((innerWidth / innerHeight) * 5) / 5 : 1.6)

// opening the view with something selected starts there, once the families are known
let lastView = ''
let pendingStart: string | null = null
store.subscribe(s => {
  const view = s.options.view
  if (view === 'classes' && lastView !== 'classes' && lastView && s.selected) pendingStart = s.selected
  lastView = view
})

/** What a diagram looks like, per diagram and window shape, so a refresh keeps the drawing. */
const scenes = new WeakMap<ClassDiagram, { key: string; scene: ClassScene }>()

function sceneOf(d: ClassDiagram, mode: Mode): ClassScene {
  const key = `${mode}|${aspect()}`
  const had = scenes.get(d)
  if (had?.key === key) return had.scene
  const scene = classScene(d, { aspect: aspect(), caption: captionOf(mode) })
  scenes.set(d, { key, scene })
  return scene
}

/** What the diagram shows: a family's id, or a folder's path. */
function shownKey(selected: string | null): { family: string } | { folder: string } | undefined {
  const s = classes.getState()
  if (s.mode === 'family') {
    const family = currentFamily(s)
    return family === undefined ? undefined : { family }
  }
  const folder = currentFolder(s, selected)
  return folder === undefined ? undefined : { folder }
}

const view: ViewPlugin = {
  id: 'classes',
  label: DIAGRAM_INFO.classes.label,
  description: 'A class diagram: a family of types joined by extends and implements, or the types of one folder, with their members and associations',
  order: DIAGRAM_INFO.classes.order,
  group: DIAGRAMS,
  groupBy: false,
  edges: false,

  layoutKey: ctx => `${classes.getState().mode}|${JSON.stringify(shownKey(ctx.s.selected) ?? null)}|${aspect()}|${classes.getState().choices ? 1 : 0}`,

  layout(ctx) {
    setRefresh(ctx.refresh)
    const got = choicesFor(ctx.world)
    if (!got) return undefined // being fetched: the view refreshes when it's there
    if (got.failed) return noteLayout('classes', ['Couldn’t read the classes', got.failed])
    if (!got.value!.folders.length) return noteLayout('classes', ['No classes, interfaces or types found', 'The code declares none, or the graph holds no symbols.'])
    if (pendingStart) {
      startAt(pendingStart)
      pendingStart = null
    }
    const q = shownKey(ctx.s.selected)
    if (!q) return noteLayout('classes', ['No families of types', 'No type extends or implements another: pick a folder in the toolbar.'])
    const d = diagramFor(ctx.world, q)
    if (!d) return undefined
    if (d.failed) return noteLayout('classes', ['Couldn’t draw the class diagram', d.failed])
    const diagram = d.value!
    const mode = classes.getState().mode
    if (!diagram.types.length) return noteLayout('classes', [`No types in ${diagram.title}`, 'Pick another folder in the toolbar, or select one.'])
    const scene = sceneOf(diagram, mode)
    const count = (k: string) => diagram.relations.filter(r => r.kind === k).length
    publishShown({ title: diagram.title, types: diagram.types.filter(t => !t.external).length, extends: count('extends'), implements: count('implements'), associations: scene.links.filter(l => l.end === 'arrow').length, arcs: scene.arcs.length, outside: diagram.types.filter(t => t.external).length })
    return diagramLayout('classes', scene, !!ctx.s.selected)
  },

  decoration: (_ctx, engine): DiagramDecoration => new ClassesDecoration(engine),

  labels(ctx, layout) {
    const scene = diagramScenes.get(layout) as ClassScene | undefined
    if (!scene) return noteLabels('classes', layout)
    const selected = ctx.s.selected
    const focus = focusOn(scene, cardFor(scene, selected)) ?? (selected ? declaredIn(scene, selected) : null)
    return [...boardLabels('classes', scene), ...cardLabels('classes', scene, focus)]
  },

  Controls,
  Legend,
}

export default view
