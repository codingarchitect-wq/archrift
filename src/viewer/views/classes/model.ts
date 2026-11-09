// Classes view, part 1: a class diagram (core/classes.ts) as cards on a
// board. UML-like cards: the stereotype («interface», «abstract», «enum»,
// «type») over the name, an abstract one in italics; properties, then the
// constructor and methods, each with its visibility sign and what its
// signature says after its name (static ones underlined, abstract ones in
// italics); a type alias shows what it stands for. Generalizations end in a
// hollow triangle, solid for extends and dashed for implements; associations
// are arrows named after their property. Bases sit above their subtypes and
// an association's owner above what it holds; a type nearly every other
// holds would draw a fan over the board, so those associations are arcs
// shown while one end is selected. Pure and deterministic.
import type { ClassDiagram, TypeBox, TypeMember, TypeRelation } from '../../../core/classes.ts'
import { arrange } from '../diagram-kit/arrange.ts'
import { shapeCard } from '../diagram-kit/card.ts'
import type { CardContent, CardRow } from '../diagram-kit/card.ts'
import { BOARD_HEAD } from '../diagram-kit/scene.ts'
import type { DiagramScene, EndMark, PlacedCard, SceneArc, SceneLink } from '../diagram-kit/scene.ts'
import { DIAGRAM_INFO } from '../diagram-kit/sections.ts'

export interface ClassScene extends DiagramScene {
  /** A type's id → its card. */
  cardOf: Map<string, number>
  /** A member's id → its card. */
  memberCard: Map<string, number>
}

const LIMITS = { rows: 14, minW: 15, maxW: 38 }
const LAYERS = { gap: 7, spacing: 4, track: 0.9, align: 'start' as const }
const PAD = 4
/** A type is a hub when at least this many others hold it, and this share of the diagram. */
const HUB_MIN = 6
const HUB_SHARE = 0.25

/** Each kind's band, a categorical color (the stereotype on the card names it too). */
export const KIND_TONE: Record<TypeBox['kind'], string> = { class: 'cat:0', abstract: 'cat:0', interface: 'cat:4', type: 'cat:3', enum: 'cat:2' }

const STEREOTYPE: Partial<Record<TypeBox['kind'], string>> = { interface: '«interface»', abstract: '«abstract»', enum: '«enumeration»', type: '«type»' }

const SIGN: Record<NonNullable<TypeMember['visibility']>, string> = { public: '+', protected: '#', private: '−' }

export function classScene(d: ClassDiagram, o: { aspect: number; caption: string }): ClassScene {
  const contents = d.types.map(typeCard)
  const shapes = contents.map(c => shapeCard(c, LIMITS))
  const at = new Map(d.types.map((t, i) => [t.id, i]))
  const relations = d.relations.filter(r => at.has(r.from) && at.has(r.to))
  const hubs = hubsOf(relations, at, d.types.length)
  const drawn = relations.filter(r => r.kind !== 'association' || !hubs.has(at.get(r.to)!) || r.from === r.to)
  const layout = arrange({
    cards: shapes.map(s => ({ w: s.w, h: s.h })),
    edges: drawn.map(r => ({ from: at.get(r.from)!, to: at.get(r.to)! })),
    before: drawn.filter(r => r.from !== r.to).map(r => (r.kind === 'association' ? [at.get(r.from)!, at.get(r.to)!] : [at.get(r.to)!, at.get(r.from)!]) as [number, number]),
    axis: 'v',
    layers: LAYERS,
    aspect: o.aspect,
    gap: 10,
  })
  const cards = d.types.map((t, i): PlacedCard => {
    const truncated = shapes[i].sections.some(s => s.rows.some(r => r.more !== undefined))
    return { content: contents[i], shape: shapes[i], ...(truncated ? { full: shapeCard(contents[i], LIMITS, true) } : {}), u: PAD + layout.cards[i].u, v: BOARD_HEAD + layout.cards[i].v, band: KIND_TONE[t.kind], board: 0 }
  })
  const links = drawn.map((r, k): SceneLink => ({ from: at.get(r.from)!, to: at.get(r.to)!, points: layout.edges[k].map(([u, v]) => [u + PAD, v + BOARD_HEAD]), ...ends(r) }))
  const arcs = relations
    .filter(r => !drawn.includes(r))
    .map((r): SceneArc => ({ from: at.get(r.from)!, to: at.get(r.to)!, fromAt: shapes[at.get(r.from)!].band / 2, toAt: shapes[at.get(r.to)!].band / 2, ...ends(r) }))
  const count = d.types.filter(t => !t.external).length
  return {
    boards: [{ u: 0, v: 0, w: Math.max(layout.w, 40) + 2 * PAD, h: layout.h + BOARD_HEAD + PAD, caption: o.caption, heading: `${d.title} · ${count} ${count === 1 ? 'type' : 'types'}` }],
    cards,
    links,
    arcs,
    cardOf: at,
    memberCard: new Map(d.types.flatMap((t, i) => t.members.map(m => [m.id, i] as const))),
  }
}

/** The marks of a relation: a hollow triangle at the base (dashed for implements), an arrow at what an association holds. */
function ends(r: TypeRelation): { start: EndMark; end: EndMark; dash?: boolean; label?: string } {
  if (r.kind === 'association') return { start: 'none', end: 'arrow', label: r.many ? `${r.label} *` : r.label }
  return { start: 'none', end: 'triangle', ...(r.kind === 'implements' ? { dash: true } : {}) }
}

/** Types so many others hold that their associations would cover the board. */
function hubsOf(relations: readonly TypeRelation[], at: Map<string, number>, types: number): Set<number> {
  const by = new Map<number, Set<string>>()
  for (const r of relations) if (r.kind === 'association' && r.from !== r.to) (by.get(at.get(r.to)!) ?? by.set(at.get(r.to)!, new Set()).get(at.get(r.to)!)!).add(r.from)
  const min = Math.max(HUB_MIN, Math.ceil(types * HUB_SHARE))
  return new Set([...by].filter(([, from]) => from.size >= min).map(([to]) => to))
}

// ── cards ───────────────────────────────────────────────────────────────────

/** A type's card: stereotype and name, properties, then the constructor and methods. */
export function typeCard(t: TypeBox): CardContent {
  const base = { id: t.id.includes(':') ? t.id : '', title: t.name, align: 'center' as const, detail: 'after' as const }
  if (t.external) return { ...base, sections: [], ghost: true }
  const fields = t.members.filter(m => m.kind === 'property' || m.kind === 'accessor').map(memberRow)
  const operations = t.members.filter(m => m.kind === 'constructor' || m.kind === 'method').map(memberRow)
  const alias = t.kind === 'type' ? aliasRow(t) : undefined
  const stereotype = STEREOTYPE[t.kind]
  return {
    ...base,
    ...(stereotype ? { over: stereotype } : {}),
    ...(t.kind === 'abstract' ? { italic: true } : {}),
    sections: alias ? [[alias]] : [fields, operations],
  }
}

/** A member as UML writes it: its visibility, its name, and what follows the name in its signature. */
export function memberRow(m: TypeMember): CardRow {
  const abstract = /(?:^|\s)abstract\s/.test(m.signature ?? '')
  return {
    id: m.id,
    sign: SIGN[m.visibility ?? 'public'],
    name: m.name,
    ...(m.signature ? { detail: afterName(m) } : {}),
    ...(abstract ? { italic: true } : {}),
    ...(m.static ? { underline: true } : {}),
  }
}

/** What a member's signature says after its name: parameters and type, or a property's type or value. */
function afterName(m: TypeMember): string {
  const sig = (m.signature ?? '').replace(/\s+/g, ' ').trim()
  const at = sig.search(new RegExp(`(?:^|[\\s.*])${m.name.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}(?![\\w$])`))
  if (at < 0) return ''
  const rest = sig.slice(sig.indexOf(m.name, at) + m.name.length).trim()
  // an accessor reads like a property; a value set where it's declared keeps its space (`count = 0`)
  const shown = m.kind === 'accessor' ? rest.replace(/^\(\)\s*/, '') : rest
  return shown.startsWith('=') ? ` ${shown}` : shown
}

/** A type alias's one row: what it stands for. */
function aliasRow(t: TypeBox): CardRow | undefined {
  const eq = t.signature?.indexOf('=') ?? -1
  return eq < 0 ? undefined : { name: '=', detail: t.signature!.slice(eq + 1).replace(/\s+/g, ' ').trim() }
}

export const captionOf = (mode: 'family' | 'folder') => `${DIAGRAM_INFO.classes.title} · ${mode === 'family' ? 'a family of types' : 'a folder'}`
