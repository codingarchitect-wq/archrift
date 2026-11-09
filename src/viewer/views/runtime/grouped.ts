// Runtime view: a scenario at the level of the toolbar's groups (detected
// modules, layers, configured groups), the way arc42 draws runtime views
// between building blocks. The lifelines of files in one group become the
// group's lifeline, so a call between them is the group calling itself. Who
// starts it and the databases keep their own; the client side still comes
// before the server side, so the network pane stays between them. Messages,
// fragments and what they select are unchanged. Pure and deterministic.
import type { Participant, Scenario } from './scenario.ts'

export function groupScenario(s: Scenario, groupOf: (file: string) => string | undefined, nameOf: (group: string) => string): Scenario {
  // each lifeline's new one, keyed by the group (or the file, where it has none)
  const keyOf = s.participants.map(p => (p.kind === 'actor' || p.kind === 'database' || p.kind === 'topic' ? p.id : (groupOf(p.id) ?? p.id)))
  const merged = new Map<string, Participant>()
  const order: string[] = []
  s.participants.forEach((p, i) => {
    const key = keyOf[i]
    const had = merged.get(key)
    if (had) {
      had.members!.push(p.id)
      if (p.kind !== 'interface') had.kind = had.kind === 'interface' ? 'file' : had.kind
      return
    }
    const grouped = key !== p.id
    merged.set(key, { ...p, id: key, name: grouped ? nameOf(key) : p.name, members: [p.id] })
    order.push(key)
  })
  // the actor first, then the client side, then the server side, each in order of appearance
  const rank = (p: Participant) => (p.kind === 'actor' ? 0 : p.side === 'client' ? 1 : 2)
  const participants = order.map(k => merged.get(k)!).sort((a, b) => rank(a) - rank(b) || order.indexOf(a.id) - order.indexOf(b.id))
  const index = new Map(participants.map((p, i) => [p.id, i]))
  const to = keyOf.map(k => index.get(k)!)
  return {
    ...s,
    participants,
    messages: s.messages.map(m => ({ ...m, from: to[m.from], to: to[m.to], kind: m.kind === 'call' && to[m.from] === to[m.to] ? 'self' : m.kind })),
  }
}
