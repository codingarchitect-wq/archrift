// NgRx as an in-app message bus (docs/POLYGLOT.md, P2). An action's type is
// the topic: the constant or enum member an action class's `type` field
// holds (`type = REQUEST_PROJECTS`), or a `createAction` creator. Dispatching
// an action, or creating one inside an effect, `publishes` its type;
// `ofType(…)` `subscribes` the effect (or guard) using it, and a reducer's
// `case` label or `on(…)` subscribes the reducer. A type counts once an
// action class or creator declares it, it is dispatched or `ofType` names it;
// what an effect creates or a `case` names must be one of those. Enum members
// aren't graph nodes otherwise: those used as action types become members of
// their enum. Effects declared with `createEffect` get kind `effect`.
import ts from 'typescript'
import type { Range } from '../../core/model.ts'
import { declarationOf } from './evaluate.ts'
import type { AssembleApi, ExtractApi, Plugin } from './types.ts'
import { calleeName, unwrap } from './syntax.ts'

/** An action type: a constant, a creator, or an enum member (with what its node needs). */
interface Topic {
  id: string
  member?: { name: string; parent: string; path: string; range: Range }
}

type NgrxFact =
  | (Topic & { type: 'topic' })
  | {
      type: 'publish' | 'subscribe'
      owner: string
      topic: Topic
      /** publish: dispatch | effect; subscribe: ofType | reducer. */
      via: string
      site: [number, number]
    }

/** A class whose instances are actions: it implements or extends `Action` (or a `…Action` base). */
const isActionClass = (c: ts.Node) => ts.isClassLike(c) && !!c.heritageClauses?.some(h => h.types.some(t => /Action$/.test(t.expression.getText())))

const isCreator = (decl: ts.Node | undefined): decl is ts.VariableDeclaration =>
  !!decl && ts.isVariableDeclaration(decl) && !!decl.initializer && (() => {
    const init = unwrap(decl.initializer!)
    return ts.isCallExpression(init) && calleeName(init.expression) === 'createAction'
  })()

function rangeOf(decl: ts.Node): Range {
  const sf = decl.getSourceFile()
  const s = sf.getLineAndCharacterOfPosition(decl.getStart(sf))
  const e = sf.getLineAndCharacterOfPosition(decl.end)
  return [s.line + 1, s.character + 1, e.line + 1, e.character + 1]
}

/** The topic an action type expression names: a constant, an enum member or a creator. */
function topicOf(expr: ts.Expression, api: ExtractApi): Topic | undefined {
  const e = unwrap(expr)
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined
  const decl = declarationOf(e, api.checker)
  if (!decl) return undefined
  if (ts.isEnumMember(decl)) {
    const parent = api.idOf(decl.parent)
    if (!parent) return undefined
    // an enum inside a namespace has no node of its own: the namespace stands for it
    if (!parent.endsWith(`#${decl.parent.name.text}`)) return { id: parent }
    const name = ts.isIdentifier(decl.name) || ts.isStringLiteral(decl.name) ? decl.name.text : decl.name.getText()
    return { id: `${parent}.${name}`, member: { name, parent, path: parent.slice(2, parent.indexOf('#')), range: rangeOf(decl) } }
  }
  if (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) {
    const id = api.idOf(decl)
    return id ? { id } : undefined
  }
  return undefined
}

/**
 * The topic of a class's `type` field: its constant, or the field itself when
 * it holds a literal. Only an action class declares a topic; a dispatched
 * value is an action whatever its class says.
 */
function typeFieldTopic(field: ts.Node, api: ExtractApi, dispatched = false): Topic | undefined {
  if (!ts.isPropertyDeclaration(field) || !field.initializer || !(dispatched || isActionClass(field.parent))) return undefined
  const topic = topicOf(field.initializer, api)
  if (topic) return topic
  const id = ts.isStringLiteralLike(unwrap(field.initializer)) ? api.idOf(field) : undefined
  return id ? { id } : undefined
}

/** The topic of an action value: a creator call, or an instance of a class with a `type` field (`new X(…)`, a variable). */
function actionTopic(expr: ts.Expression, api: ExtractApi): Topic | undefined {
  const e = unwrap(expr)
  if (ts.isCallExpression(e)) {
    const decl = declarationOf(e.expression, api.checker)
    const id = isCreator(decl) ? api.idOf(decl) : undefined
    return id ? { id } : undefined
  }
  const field = api.checker.getTypeAtLocation(e).getProperty('type')?.valueDeclaration
  return field && typeFieldTopic(field, api, true)
}

function emitMessage(api: ExtractApi, type: 'publish' | 'subscribe', via: string, topic: Topic | undefined, at: ts.Node) {
  if (topic) api.emit({ type, owner: api.ownerOf(at), topic, via, site: api.site(at) } satisfies NgrxFact)
}

/** Inside an effect, every action it creates is published (`map(() => new X())`, `of(creator())`). */
function visitEffect(body: ts.Node, api: ExtractApi) {
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && calleeName(n.expression) === 'dispatch') return // counted as a dispatch
    if (ts.isNewExpression(n) || (ts.isCallExpression(n) && ts.isIdentifier(unwrap(n.expression)))) emitMessage(api, 'publish', 'effect', actionTopic(n, api), n)
    ts.forEachChild(n, walk)
  }
  walk(body)
}

const isEffectDecorated = (node: ts.PropertyDeclaration) =>
  !!ts.getDecorators(node)?.some(d => calleeName(ts.isCallExpression(d.expression) ? d.expression.expression : d.expression) === 'Effect')

export const ngrx: Plugin = {
  name: 'ngrx',
  version: 1,

  memberKind(member) {
    if (!ts.isPropertyDeclaration(member) || !member.initializer) return undefined
    const init = unwrap(member.initializer)
    return ts.isCallExpression(init) && calleeName(init.expression) === 'createEffect' ? { subkind: 'effect' } : undefined
  },

  visit(node, api) {
    if (ts.isPropertyDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && node.name.text === 'type') {
        const topic = typeFieldTopic(node, api)
        if (topic) api.emit({ type: 'topic', ...topic } satisfies NgrxFact)
      } else if (isEffectDecorated(node)) visitEffect(node.initializer, api) // NgRx before 8: @Effect() x$ = this.actions$.pipe(…)
    } else if (ts.isVariableDeclaration(node) && isCreator(node)) {
      const id = api.idOf(node)
      if (id) api.emit({ type: 'topic', id } satisfies NgrxFact)
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      if (name === 'dispatch' && node.arguments.length === 1) emitMessage(api, 'publish', 'dispatch', actionTopic(node.arguments[0], api), node)
      else if (name === 'createEffect' && node.arguments[0]) visitEffect(node.arguments[0], api)
      else if (name === 'ofType') for (const a of node.arguments) emitMessage(api, 'subscribe', 'ofType', topicOf(a, api), a)
      else if (name === 'on' && ts.isIdentifier(unwrap(node.expression)))
        for (const a of node.arguments) if (!ts.isArrowFunction(a) && !ts.isFunctionExpression(a)) emitMessage(api, 'subscribe', 'reducer', topicOf(a, api), a)
    } else if (ts.isSwitchStatement(node)) {
      const on = unwrap(node.expression)
      if (!ts.isPropertyAccessExpression(on) || on.name.text !== 'type') return
      for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) emitMessage(api, 'subscribe', 'reducer', topicOf(clause.expression, api), clause.expression)
    }
  },

  assemble(api: AssembleApi) {
    const facts = api.facts<NgrxFact>('ngrx').map(f => f.fact)
    // topics: what action classes and creators declare, what is dispatched and what ofType listens to;
    // what an effect creates or a reducer's `case` names only counts when it is one of those
    const topics = new Map<string, Topic>()
    for (const fact of facts) {
      const topic = fact.type === 'topic' ? fact : fact.via === 'dispatch' || fact.via === 'ofType' ? fact.topic : undefined
      if (topic && !topics.has(topic.id)) topics.set(topic.id, topic)
    }
    for (const t of [...topics.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const m = t.member
      if (m && !api.nodes.has(t.id) && api.nodes.has(m.parent))
        api.addNode({ id: t.id, kind: 'member', name: m.name, subkind: 'enum-member', parent: m.parent, path: m.path, range: m.range, metrics: { loc: m.range[2] - m.range[0] + 1 } })
      const n = api.nodes.get(t.id)
      if (n && !n.tags?.includes('ngrx-action')) n.tags = [...(n.tags ?? []), 'ngrx-action']
    }
    for (const fact of facts) {
      if (fact.type === 'topic' || !topics.has(fact.topic.id)) continue
      api.addEdge({ source: fact.owner, target: fact.topic.id, kind: fact.type === 'publish' ? 'publishes' : 'subscribes', subkind: fact.via, count: 1, targets: api.targets }, fact.site)
    }
  },
}
