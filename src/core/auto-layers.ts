// Layers without a config: each area (a top directory) goes to a
// level by longest dependency path in the area graph with its cycles
// condensed, so foundations sit at the bottom and whatever depends on
// everything sits at the top. Areas in one cycle share a level.
import { cycles } from './algorithms.ts'

export interface AutoLayers {
  /** Layer names, top to bottom. */
  order: string[]
  /** Area id → layer name. */
  layerOfArea: Map<string, string>
  /** Layer name → plane label listing its areas. */
  labels: Map<string, string>
}

export function autoLayers(areas: string[], edges: { source: string; target: string }[], areaName: (id: string) => string): AutoLayers {
  const adjacency = new Map<string, Set<string>>(areas.map(a => [a, new Set()]))
  for (const e of edges) if (e.source !== e.target && adjacency.has(e.source) && adjacency.has(e.target)) adjacency.get(e.source)!.add(e.target)

  // condense cycles
  const comp = new Map(areas.map(a => [a, a]))
  const asLists = new Map([...adjacency].map(([k, v]) => [k, [...v]]))
  for (const c of cycles(areas, asLists)) for (const a of c) comp.set(a, c[0])
  const succ = new Map<string, Set<string>>()
  for (const [a, targets] of adjacency) {
    const s = succ.get(comp.get(a)!) ?? new Set<string>()
    for (const t of targets) if (comp.get(t) !== comp.get(a)) s.add(comp.get(t)!)
    succ.set(comp.get(a)!, s)
  }

  // longest path to a sink, over the (acyclic) condensation
  const level = new Map<string, number>()
  const levelOf = (c: string): number => {
    const known = level.get(c)
    if (known !== undefined) return known
    level.set(c, 0) // guards against a malformed cycle
    let l = 0
    for (const t of succ.get(c) ?? []) l = Math.max(l, levelOf(t) + 1)
    level.set(c, l)
    return l
  }
  for (const a of areas) levelOf(comp.get(a)!)
  const top = Math.max(0, ...level.values())

  const nameOf = (l: number) => `level ${top - l + 1}`
  const layerOfArea = new Map(areas.map(a => [a, nameOf(level.get(comp.get(a)!)!)]))
  const members = new Map<string, string[]>()
  for (const [a, l] of layerOfArea) members.set(l, [...(members.get(l) ?? []), areaName(a)])
  const order = [...new Set([...level.values()])].sort((a, b) => b - a).map(nameOf)
  const labels = new Map(
    order.map(l => {
      const names = members.get(l)!.sort()
      const list = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '')
      return [l, `${l}: ${list}`]
    }),
  )
  return { order, layerOfArea, labels }
}
