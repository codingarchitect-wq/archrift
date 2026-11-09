import { describe, expect, it } from 'vitest'
import { familyDiagram, folderDiagram, typeFamilies } from '../../src/core/classes.ts'
import type { ClassDiagram } from '../../src/core/classes.ts'
import type { EdgeKind, Graph, GraphNode } from '../../src/core/model.ts'
import { declKindOf, heritageOf, isCollection, isStatic, visibilityOf } from '../../src/core/type-signatures.ts'
import { analyzeFixture } from '../helpers/fixtures.ts'

// ── a made-up codebase: symbols by id (`s:<path>#Name`, members `#Type.member`), with their signatures ──

type Decl = [id: string, subkind: string, signature?: string, line?: number]
type Ref = [source: string, kind: EdgeKind, target: string]

function graphOf(decls: Decl[], refs: Ref[] = []): Graph {
  const nodes: GraphNode[] = decls.map(([id, subkind, signature, line = 1]) => {
    const [, path, name] = /^s:(.*)#(.*)$/.exec(id)!
    const member = name.includes('.')
    return {
      id,
      kind: member ? 'member' : 'symbol',
      name: name.split('.').pop()!,
      subkind,
      path,
      parent: member ? `s:${path}#${name.split('.')[0]}` : `f:${path}`,
      range: [line, 1, line, 2],
      ...(signature ? { signature } : {}),
    }
  })
  const edges = refs.map(([source, kind, target]) => ({ source, target, kind, count: 1, targets: ['default'], confidence: 'exact' as const }))
  return { meta: { name: 't', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } }, nodes, edges, sites: [] }
}

const names = (d: ClassDiagram) => d.types.map(t => `${t.name}${t.external ? ' (outside)' : ''}`)
const relations = (d: ClassDiagram) =>
  d.relations.map(r => {
    const name = (id: string) => d.types.find(t => t.id === id)?.name ?? id
    return `${name(r.from)} ${r.kind}${r.label ? ` ${r.label}` : ''}${r.many ? ' *' : ''} ${name(r.to)}`
  })

describe('reading type declarations', () => {
  it('tells what a signature declares, whatever the language', () => {
    expect(declKindOf('export abstract class Base implements Shape')).toBe('abstract')
    expect(declKindOf('export default class App extends React.Component<Props>')).toBe('class')
    expect(declKindOf('export interface DataService')).toBe('interface')
    expect(declKindOf('type Point = { x: number; y: number }')).toBe('type')
    expect(declKindOf('export const enum Unit')).toBe('enum')
    expect(declKindOf('@Entity data class Order(val id: Long) : Base()')).toBe('class')
    expect(declKindOf('enum class Kind')).toBe('enum')
    expect(declKindOf('fun interface Handler')).toBe('interface')
    expect(declKindOf('object Registry')).toBe('class')
    expect(declKindOf('typealias Orders = List<Order>')).toBe('type')
    expect(declKindOf('type Store struct')).toBe('class')
    expect(declKindOf('type Repo interface')).toBe('interface')
    // not types
    expect(declKindOf('export function makeCircle(center: Point): Circle')).toBeUndefined()
    expect(declKindOf("export const Color = { red: '#f00' } as const")).toBeUndefined()
    expect(declKindOf('annotation class Audited')).toBeUndefined()
    expect(declKindOf(undefined)).toBeUndefined()
  })

  it('finds the supertypes a declaration names, outside type parameters and arguments', () => {
    expect(heritageOf('export class LocalDataService extends LocalDataServiceProjections implements DataService')).toEqual([
      { name: 'LocalDataServiceProjections', relation: 'extends' },
      { name: 'DataService', relation: 'implements' },
    ])
    expect(heritageOf('class Box<T extends Item = Item> extends Base<T> implements Iterable<T>, Sized')).toEqual([
      { name: 'Base', relation: 'extends' },
      { name: 'Iterable', relation: 'implements' },
      { name: 'Sized', relation: 'implements' },
    ])
    expect(heritageOf('interface Props extends React.HTMLAttributes<HTMLDivElement>, Base')).toEqual([
      { name: 'React.HTMLAttributes', relation: 'extends' },
      { name: 'Base', relation: 'extends' },
    ])
    // a type operator wraps the base: the edge goes to what it wraps
    expect(heritageOf("interface ContentProps extends Omit<ViewProps, 'events'>")).toEqual([])
    // Kotlin: the called supertype is the superclass, the rest are interfaces; an interface's list extends
    expect(heritageOf('class Order(val id: Long, val size: Double) : Base(), Comparable<Order>, Serializable')).toEqual([
      { name: 'Base', relation: 'extends' },
      { name: 'Comparable', relation: 'implements' },
      { name: 'Serializable', relation: 'implements' },
    ])
    expect(heritageOf('interface OrderRepository : JpaRepository<Order, Long>')).toEqual([{ name: 'JpaRepository', relation: 'extends' }])
    expect(heritageOf('class Logged(inner: Store) : Store by inner')).toEqual([{ name: 'Store', relation: 'implements' }])
    expect(heritageOf('export type Pair = [number, number]')).toEqual([])
  })

  it('reads static, visibility and collections from what a member signature says', () => {
    expect(visibilityOf('protected db: LocalDb', 'db')).toBe('protected')
    expect(visibilityOf('private async dropRateOverrides(key: string): Promise<void>', 'dropRateOverrides')).toBe('private')
    expect(visibilityOf('private val clock: OrderClock', 'clock')).toBe('private')
    expect(visibilityOf('#secret = 1', '#secret')).toBe('private')
    expect(visibilityOf('radius: number', 'radius')).toBeUndefined()
    // a parameter's modifier is not the member's
    expect(visibilityOf('constructor(private db: Db)', 'constructor')).toBeUndefined()
    expect(isStatic('static readonly MAX = 3', 'MAX', undefined)).toBe(true)
    expect(isStatic('const val API', 'API', ['const', 'static'])).toBe(true)
    expect(isStatic('area(): number', 'area', undefined)).toBe(false)
    expect(isCollection('children?: CategoryWithStats[]', 'children')).toBe(true)
    expect(isCollection('val items: List<Item>', 'items')).toBe(true)
    expect(isCollection('owner: Account', 'owner')).toBe(false)
  })
})

describe('type families', () => {
  it('are the components of extends/implements, rooted at what the others build on', async () => {
    const graph = await analyzeFixture('plain-ts')
    const families = typeFamilies(graph)
    expect(families).toEqual([{ id: 's:src/types.ts#Shape', name: 'Shape', types: ['s:src/types.ts#Shape', 's:src/shapes.ts#Base', 's:src/shapes.ts#Circle'], classes: 2 }])
    const d = familyDiagram(graph, families[0].id)
    expect(d.title).toBe('Shape')
    expect(names(d)).toEqual(['Shape', 'Base', 'Circle'])
    expect(relations(d)).toEqual(['Base implements Shape', 'Circle extends Base'])
    expect(d.types.map(t => t.kind)).toEqual(['interface', 'abstract', 'class'])
    // properties and accessors first, then the constructor, then methods, each in source order
    expect(d.types[2].members.map(m => `${m.kind} ${m.name}`)).toEqual(['property radius', 'property color', 'accessor name', 'constructor constructor', 'method area'])
  })

  it('put families with classes first, then the biggest; classes sharing an outside base form one after the project’s own', () => {
    const graph = graphOf([
      ['s:a.ts#Shape', 'interface', 'interface Shape'],
      ['s:a.ts#Round', 'interface', 'interface Round extends Shape'],
      ['s:a.ts#Oval', 'interface', 'interface Oval extends Round'],
      ['s:b.ts#Repo', 'interface', 'interface Repo'],
      ['s:b.ts#SqlRepo', 'class', 'class SqlRepo implements Repo'],
      ['s:e.ts#NotFound', 'class', 'export class NotFound extends Error'],
      ['s:e.ts#Conflict', 'class', 'export class Conflict extends Error'],
      ['s:e.ts#Lonely', 'class', 'export class Lonely extends Dexie'],
      // extends Error, but already in a project family: not counted twice
      ['s:e.ts#Base', 'class', 'class Base extends Error'],
      ['s:e.ts#Sub', 'class', 'class Sub extends Base'],
    ], [
      ['s:a.ts#Round', 'extends', 's:a.ts#Shape'],
      ['s:a.ts#Oval', 'extends', 's:a.ts#Round'],
      ['s:b.ts#SqlRepo', 'implements', 's:b.ts#Repo'],
      ['s:e.ts#Sub', 'extends', 's:e.ts#Base'],
    ])
    expect(typeFamilies(graph).map(f => `${f.name}: ${f.types.length} types, ${f.classes} classes`)).toEqual([
      'Base: 2 types, 2 classes',
      'Repo: 2 types, 1 classes',
      'Error: 2 types, 2 classes',
      'Shape: 3 types, 0 classes',
    ])
    const errors = familyDiagram(graph, 'Error')
    expect(names(errors)).toEqual(['Conflict', 'NotFound', 'Error (outside)'])
    expect(relations(errors)).toEqual(['Conflict extends Error', 'NotFound extends Error'])
    // the project's family shows its outside base too
    expect(relations(familyDiagram(graph, 's:e.ts#Base'))).toEqual(['Sub extends Base', 'Base extends Error'])
    expect(familyDiagram(graph, 'nothing')).toEqual({ title: 'nothing', types: [], relations: [] })
  })

  it('reach across a system of services (Kotlin), with the outside supertypes from the signatures', async () => {
    const graph = await analyzeFixture('kotlin-spring')
    const [shapes] = typeFamilies(graph)
    expect(shapes.name).toBe('Shape')
    const d = familyDiagram(graph, shapes.id)
    expect(names(d)).toEqual(['Shape', 'Base', 'Order'])
    expect(relations(d)).toEqual(['Base implements Shape', 'Order extends Base'])
    expect(d.types[1].kind).toBe('abstract')
    // a companion's constants are static
    expect(d.types[1].members.filter(m => m.static).map(m => m.name)).toEqual(['API', 'UNIT'])
    const orders = folderDiagram(graph, 'd:order-service/src/main/kotlin/com/acme/order')
    expect(relations(orders)).toContain('OrderRepository extends JpaRepository')
    expect(orders.types.find(t => t.name === 'JpaRepository')).toMatchObject({ id: 'JpaRepository', external: true, kind: 'class', members: [] })
  })
})

describe('a folder’s class diagram', () => {
  const graph = graphOf([
    ['s:lib/model.ts#Account', 'interface', 'export interface Account', 1],
    ['s:lib/model.ts#Account.owner', 'property', 'owner: User', 2],
    ['s:lib/model.ts#Account.payments', 'property', 'payments: Payment[]', 3],
    ['s:lib/model.ts#Account.backup', 'property', 'backup?: Payment[]', 4],
    ['s:lib/model.ts#Account.find', 'method', 'find(id: string): Payment', 5],
    ['s:lib/model.ts#User', 'type', 'export type User = { id: string }', 10],
    ['s:lib/pay.ts#Payment', 'class', 'export class Payment extends Base', 1],
    ['s:lib/pay.ts#Payment.total', 'property', 'private static total: number', 2],
    ['s:lib/pay.ts#makePayment', 'function', 'export function makePayment(): Payment', 9],
    ['s:lib/deep/more.ts#Hidden', 'interface', 'interface Hidden', 1],
    ['s:base/base.ts#Base', 'class', 'export class Base', 1],
  ], [
    ['s:lib/model.ts#Account.owner', 'type-ref', 's:lib/model.ts#User'],
    ['s:lib/model.ts#Account.payments', 'type-ref', 's:lib/pay.ts#Payment'],
    ['s:lib/model.ts#Account.payments', 'type-ref', 's:lib/pay.ts#Payment'],
    ['s:lib/model.ts#Account.backup', 'type-ref', 's:lib/pay.ts#Payment'],
    // a method's types are no association
    ['s:lib/model.ts#Account.find', 'type-ref', 's:lib/pay.ts#Payment'],
    ['s:lib/pay.ts#Payment', 'extends', 's:base/base.ts#Base'],
  ])

  it('holds the types of the folder’s own files, a base declared elsewhere as a name, and the associations', () => {
    const d = folderDiagram(graph, 'd:lib')
    expect(d.title).toBe('lib')
    expect(names(d)).toEqual(['Account', 'User', 'Payment', 'Base (outside)'])
    expect(relations(d)).toEqual(['Payment extends Base', 'Account association owner User', 'Account association payments * Payment', 'Account association backup * Payment'])
    // a base from elsewhere keeps its id, so a click selects it
    expect(d.types[3]).toMatchObject({ id: 's:base/base.ts#Base', external: true, members: [] })
    expect(d.types[2].members).toEqual([{ id: 's:lib/pay.ts#Payment.total', name: 'total', kind: 'property', signature: 'private static total: number', static: true, visibility: 'private' }])
    expect(folderDiagram(graph, 'lib/')).toEqual(d)
    expect(names(folderDiagram(graph, 'd:lib/deep'))).toEqual(['Hidden'])
    expect(folderDiagram(graph, 'd:nowhere').types).toEqual([])
  })
})
