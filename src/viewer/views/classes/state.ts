// Classes view, part 2: what is shown (a family, or a folder) and getting it.
// The viewer's overview holds no symbols, so the families, the folders with
// types and each diagram come from the server (/api/classes), once per graph
// shown, off the render: the layout waits for them and the view refreshes
// when they're there.
import { createStore } from 'zustand/vanilla'
import type { ClassDiagram } from '../../../core/classes.ts'
import { fileIdOf, parentDir } from '../../../core/ids.ts'
import { api } from '../../api.ts'
import type { ClassChoices } from '../../api.ts'
import { store } from '../../store.ts'
import type { World } from '../../world.ts'

export type Mode = 'family' | 'folder'

export interface ClassesState {
  mode: Mode
  /** The family picked (its id), or null for the one shown by default. */
  family: string | null
  /** The folder picked (a path), or null to follow the viewer's selection. */
  folder: string | null
  choices: ClassChoices | null
  /** What the legend says about the diagram shown. */
  shown: { title: string; types: number; extends: number; implements: number; associations: number; arcs: number; outside: number } | null
}

export const classes = createStore<ClassesState>()(() => ({ mode: 'family', family: null, folder: null, choices: null, shown: null }))

/** Run the viewer again (the plug-in hands over its ctx.refresh). */
let refresh = () => {}
export const setRefresh = (f: () => void) => (refresh = f)

export function setMode(mode: Mode) {
  classes.setState({ mode })
  refresh()
}

export function pickFamily(id: string) {
  classes.setState({ mode: 'family', family: id })
  refresh()
}

/** A folder by hand, or null to follow the selection again. */
export function pickFolder(path: string | null) {
  classes.setState({ mode: 'folder', folder: path })
  refresh()
}

export function publishShown(shown: ClassesState['shown']) {
  if (JSON.stringify(shown) !== JSON.stringify(classes.getState().shown)) classes.setState({ shown })
}

interface Fetch<T> {
  value?: T
  failed?: string
}

const choices = new WeakMap<World, Fetch<ClassChoices>>()
const diagrams = new WeakMap<World, Map<string, Fetch<ClassDiagram>>>()

/** The families and folders of a graph: there when fetched, undefined while they're coming (fetched on first ask). */
export function choicesFor(world: World): Fetch<ClassChoices> | undefined {
  const had = choices.get(world)
  if (had) return had.value || had.failed ? had : undefined
  const f: Fetch<ClassChoices> = {}
  choices.set(world, f)
  fetching('Finding the classes', api.classChoices(), f, value => classes.setState({ choices: value }))
  return undefined
}

/** A family's or a folder's diagram, the same way. */
export function diagramFor(world: World, q: { family: string } | { folder: string }): Fetch<ClassDiagram> | undefined {
  let byKey = diagrams.get(world)
  if (!byKey) diagrams.set(world, (byKey = new Map()))
  const key = 'family' in q ? `family:${q.family}` : `folder:${q.folder}`
  const had = byKey.get(key)
  if (had) return had.value || had.failed ? had : undefined
  const f: Fetch<ClassDiagram> = {}
  byKey.set(key, f)
  fetching('Drawing the class diagram', api.classDiagram(q), f)
  return undefined
}

function fetching<T>(label: string, p: Promise<T>, into: Fetch<T>, then?: (value: T) => void) {
  // say so when it takes a moment
  const slow = setTimeout(() => store.setState({ task: { label, progress: -1 } }), 250)
  const done = () => {
    clearTimeout(slow)
    if (store.getState().task?.label === label) store.setState({ task: null })
    refresh()
  }
  p.then(
    value => {
      into.value = value
      then?.(value)
      done()
    },
    (err: unknown) => {
      into.failed = err instanceof Error ? err.message : String(err)
      done()
    },
  )
}

/** The folder a selection stands for: a folder itself, a file's or a symbol's folder. */
export function folderOf(id: string | null): string | undefined {
  if (!id) return undefined
  if (id === 'd:.') return ''
  if (id.startsWith('d:')) return id.slice(2)
  const file = fileIdOf(id)
  return file ? parentDir(file.slice(2)) : undefined
}

/** The folder shown in folder mode: the one picked, else the selected folder or file's, else the last one followed, else the one with most types. */
let followed: string | undefined
export function currentFolder(s: ClassesState, selected: string | null): string | undefined {
  if (s.folder !== null) return s.folder
  // a type clicked in the diagram keeps its folder; picking a folder or a file elsewhere moves there
  if (selected && (selected.startsWith('d:') || selected.startsWith('f:'))) followed = folderOf(selected)
  return followed ?? folderOf(selected) ?? s.choices?.folders[0]?.path
}

/** The family shown: the one picked, else the first (classes first, then the biggest). */
export function currentFamily(s: ClassesState): string | undefined {
  const families = s.choices?.families ?? []
  return families.find(f => f.id === s.family)?.id ?? families[0]?.id
}

/** Opening the view with a type selected starts at its family; with a folder or file, at that folder. */
export function startAt(selected: string | null) {
  const s = classes.getState()
  const family = s.choices?.families.find(f => f.types.includes(selected ?? ''))
  if (family) return classes.setState({ mode: 'family', family: family.id })
  if (selected && (selected.startsWith('d:') || selected.startsWith('f:'))) {
    followed = folderOf(selected)
    classes.setState({ mode: 'folder', folder: null })
  }
}
