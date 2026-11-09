import { describe, expect, it } from 'vitest'
import type { ClassDiagram, TypeBox, TypeMember } from '../../../src/core/classes.ts'
import { focusOn } from '../../../src/viewer/views/diagram-kit/scene.ts'
import { cardFor, declaredIn } from '../../../src/viewer/views/classes/decoration.ts'
import { classScene, memberRow, typeCard } from '../../../src/viewer/views/classes/model.ts'
import type { ClassScene } from '../../../src/viewer/views/classes/model.ts'
import { currentFamily, currentFolder, folderOf } from '../../../src/viewer/views/classes/state.ts'
import type { ClassesState } from '../../../src/viewer/views/classes/state.ts'

// ── a made-up family: an interface, an abstract class implementing it, two classes extending that, an outside base ──

const member = (owner: string, name: string, kind: TypeMember['kind'], signature: string, extra: Partial<TypeMember> = {}): TypeMember => ({ id: `${owner}.${name}`, name, kind, signature, ...extra })
const box = (id: string, kind: TypeBox['kind'], members: TypeMember[] = [], extra: Partial<TypeBox> = {}): TypeBox => ({ id, name: id.split('#')[1] ?? id, kind, path: 'src/shapes.ts', members, ...extra })

const SHAPE = 's:src/types.ts#Shape'
const BASE = 's:src/shapes.ts#Base'
const CIRCLE = 's:src/shapes.ts#Circle'
const SQUARE = 's:src/shapes.ts#Square'
const PALETTE = 's:src/shapes.ts#Palette'

const diagram: ClassDiagram = {
  title: 'Shape',
  types: [
    box(SHAPE, 'interface', [member(SHAPE, 'name', 'property', 'readonly name: string'), member(SHAPE, 'area', 'method', 'area(): number')]),
    box(BASE, 'abstract', [member(BASE, 'name', 'accessor', 'get name(): string'), member(BASE, 'area', 'method', 'abstract area(): number'), member(BASE, 'count', 'property', 'static count = 0', { static: true })]),
    box(CIRCLE, 'class', [member(CIRCLE, 'radius', 'property', 'private radius: number', { visibility: 'private' }), member(CIRCLE, 'constructor', 'constructor', 'constructor(radius: number)'), member(CIRCLE, 'area', 'method', 'area(): number')]),
    box(SQUARE, 'class', [member(SQUARE, 'side', 'property', 'protected side: number', { visibility: 'protected' })]),
    box(PALETTE, 'class', [member(PALETTE, 'shapes', 'property', 'shapes: Shape[]')]),
    box('Serializable', 'interface', [], { external: true, path: undefined }),
  ],
  relations: [
    { from: BASE, to: SHAPE, kind: 'implements' },
    { from: CIRCLE, to: BASE, kind: 'extends' },
    { from: SQUARE, to: BASE, kind: 'extends' },
    { from: CIRCLE, to: 'Serializable', kind: 'implements' },
    { from: PALETTE, to: SHAPE, kind: 'association', label: 'shapes', many: true },
  ],
}

const scene = classScene(diagram, { aspect: 1.6, caption: 'Class diagram · a family of types' })
const card = (s: ClassScene, id: string) => s.cards[s.cardOf.get(id)!]

describe('a class diagram’s cards', () => {
  it('carry the stereotype over the name, an abstract one in italics, the kind’s color on the band', () => {
    expect(scene.cards.map(c => [c.content.over ?? '', c.content.title, c.content.italic ? 'italic' : '', c.band])).toEqual([
      ['«interface»', 'Shape', '', 'cat:4'],
      ['«abstract»', 'Base', 'italic', 'cat:0'],
      ['', 'Circle', '', 'cat:0'],
      ['', 'Square', '', 'cat:0'],
      ['', 'Palette', '', 'cat:0'],
      ['', 'Serializable', '', 'cat:4'],
    ])
    // outside the project: a name in a dashed outline, which selects nothing
    expect(card(scene, 'Serializable').content).toMatchObject({ ghost: true, id: '', sections: [] })
    expect(scene.boards[0].heading).toBe('Shape · 5 types')
  })

  it('list properties, then the constructor and methods, as UML writes them', () => {
    const rows = (id: string) => card(scene, id).content.sections.map(s => s.map(r => `${r.sign} ${r.name}${r.detail ?? ''}${r.italic ? ' (italic)' : ''}${r.underline ? ' (underlined)' : ''}`))
    expect(rows(CIRCLE)).toEqual([['− radius: number'], ['+ constructor(radius: number)', '+ area(): number']])
    // an accessor reads like a property; abstract in italics, static underlined
    expect(rows(BASE)).toEqual([['+ name: string', '+ count = 0 (underlined)'], ['+ area(): number (italic)']])
    expect(rows(SQUARE)[0]).toEqual(['# side: number'])
    // a member's row selects the member
    expect(card(scene, CIRCLE).content.sections[1][1].id).toBe(`${CIRCLE}.area`)
  })

  it('show what a type alias stands for, and long ones their first rows and "+N more"', () => {
    const alias = typeCard(box('s:src/types.ts#Point', 'type', [], { signature: 'export type Point = { x: number;  y: number }' }))
    expect(alias.sections).toEqual([[{ name: '=', detail: '{ x: number; y: number }' }]])
    const many = Array.from({ length: 30 }, (_, i) => member('s:a.ts#Big', `m${i}`, 'method', `m${i}(): void`))
    const big = classScene({ title: 'a', types: [box('s:a.ts#Big', 'interface', many)], relations: [] }, { aspect: 1.6, caption: '' })
    expect(big.cards[0].shape.sections[1].rows).toHaveLength(14)
    expect(big.cards[0].shape.sections[1].rows[13].more).toBe(17)
    expect(big.cards[0].full?.sections[1].rows).toHaveLength(30)
    expect(memberRow(member('s:a.ts#K', 'API', 'property', 'const val API', { static: true }))).toMatchObject({ sign: '+', name: 'API', underline: true })
  })
})

describe('a class diagram’s connectors and layout', () => {
  const name = (i: number) => scene.cards[i].content.title
  it('end in hollow triangles for generalizations (dashed for implements), arrows named after the property for associations', () => {
    expect(scene.links.map(l => `${name(l.from)} ${l.dash ? '- -' : '—'}${l.end === 'triangle' ? '▷' : '>'} ${name(l.to)}${l.label ? ` (${l.label})` : ''}`)).toEqual([
      'Base - -▷ Shape',
      'Circle —▷ Base',
      'Square —▷ Base',
      'Circle - -▷ Serializable',
      'Palette —> Shape (shapes *)',
    ])
  })

  it('puts bases above their subtypes and an association’s owner above what it holds, nothing overlapping', () => {
    const top = (id: string) => card(scene, id).v
    const bottom = (id: string) => card(scene, id).v + card(scene, id).shape.h
    expect(bottom(SHAPE)).toBeLessThan(top(BASE))
    expect(bottom(BASE)).toBeLessThan(top(CIRCLE))
    expect(top(CIRCLE)).toBe(top(SQUARE)) // tops aligned in a rank
    expect(bottom(PALETTE)).toBeLessThan(top(SHAPE))
    const boxes = scene.cards.map(c => ({ u: c.u, v: c.v, w: c.shape.w, h: c.shape.h }))
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(a.u + a.w <= b.u || b.u + b.w <= a.u || a.v + a.h <= b.v || b.v + b.h <= a.v).toBe(true)
    expect(classScene(diagram, { aspect: 1.6, caption: 'Class diagram · a family of types' })).toEqual(scene)
  })

  it('makes associations to a type most others hold arcs, shown while one end is selected', () => {
    const holders = Array.from({ length: 8 }, (_, i) => box(`s:a.ts#H${i}`, 'class', [member(`s:a.ts#H${i}`, 'money', 'property', 'money: Money')]))
    const d: ClassDiagram = { title: 'a', types: [box('s:a.ts#Money', 'class'), ...holders], relations: holders.map(h => ({ from: h.id, to: 's:a.ts#Money', kind: 'association' as const, label: 'money' })) }
    const s = classScene(d, { aspect: 1.6, caption: '' })
    expect([s.links.length, s.arcs.length]).toEqual([0, 8])
    expect(focusOn(s, 0)!.arcs.size).toBe(8)
  })

  it('selects a type’s card for the type or one of its members; a file lights the types it declares', () => {
    expect(cardFor(scene, CIRCLE)).toBe(2)
    expect(cardFor(scene, `${CIRCLE}.area`)).toBe(2)
    expect(cardFor(scene, 'f:src/shapes.ts')).toBeUndefined()
    expect([...declaredIn(scene, 'f:src/shapes.ts')!.cards].map(name)).toEqual(['Base', 'Circle', 'Square', 'Palette'])
    const focus = focusOn(scene, 1)!
    expect([...focus.cards].map(name).sort()).toEqual(['Base', 'Circle', 'Shape', 'Square'])
  })
})

describe('what the Classes view shows', () => {
  const state = (patch: Partial<ClassesState>): ClassesState => ({
    mode: 'folder',
    family: null,
    folder: null,
    shown: null,
    choices: { families: [{ id: SHAPE, name: 'Shape', types: [SHAPE, BASE], classes: 1 }, { id: 'Error', name: 'Error', types: ['s:e.ts#A', 's:e.ts#B'], classes: 2 }], folders: [{ path: 'src/lib', types: 40 }, { path: 'src', types: 3 }] },
    ...patch,
  })

  it('a folder: the one picked, else the folder or file selected, kept while a type in it is clicked', () => {
    expect(folderOf('d:src/ui')).toBe('src/ui')
    expect(folderOf('d:.')).toBe('')
    expect(folderOf('s:src/ui/Button.tsx#Button.render')).toBe('src/ui')
    expect(currentFolder(state({ folder: 'src' }), 'd:src/ui')).toBe('src')
    expect(currentFolder(state({}), 'f:src/ui/Button.tsx')).toBe('src/ui')
    // a type clicked elsewhere (a base drawn from another folder) doesn't move the diagram
    expect(currentFolder(state({}), 's:src/lib/x.ts#X')).toBe('src/ui')
    expect(currentFolder(state({}), 'd:src/lib')).toBe('src/lib')
  })

  it('a family: the one picked, else the first', () => {
    expect(currentFamily(state({ family: 'Error' }))).toBe('Error')
    expect(currentFamily(state({ family: 'gone' }))).toBe(SHAPE)
    expect(currentFamily(state({ choices: { families: [], folders: [] } }))).toBeUndefined()
  })
})
