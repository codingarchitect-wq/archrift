// Asking the map (the viewer's Ask bar): a question in plain words, answered
// by the coding agent on this machine (Claude Code's `claude -p`, read-only:
// it reads and searches the code and asks `archrift query`), as a few
// sentences plus the nodes the answer is about and, for a sequence, a
// walkthrough. The viewer lights those nodes up on the map. This is the pure
// part: the answer's shape and schema, the prompts, resolving what the agent
// names to nodes of the graph, and the progress it reports. cli/ask.ts runs it.
import { GraphIndex } from './graph-index.ts'
import type { Graph } from './model.ts'

/** What the agent returns (its structured output), before its references are checked against the graph. */
export interface RawAnswer {
  title?: unknown
  answer?: unknown
  nodes?: unknown
  steps?: unknown
  followUps?: unknown
}

export interface AnswerNode {
  /** A node of the graph: `f:…`, `s:…`, `d:…`, `x:…`. */
  id: string
  /** Its part in the answer. */
  note: string
}

export interface Answer {
  question: string
  title: string
  /** A few sentences, light markdown; `[[ref]]` cites a node (`refs` says which). */
  answer: string
  nodes: AnswerNode[]
  /** When the answer is a sequence: the walkthrough, in order. */
  steps: AnswerNode[]
  followUps: string[]
  /** Each `[[ref]]` of the answer that names a node, and that node's id. */
  refs: Record<string, string>
  /** What the agent named that the graph doesn't have (left off the map). */
  unknown: string[]
}

/** The JSON schema the agent's answer follows (`claude -p --json-schema`). */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The answer as a heading, at most 8 words' },
    answer: { type: 'string', description: 'The answer in a few sentences or a short list, plain words; cite files and functions as [[path]] or [[s:path#name]]' },
    nodes: {
      type: 'array',
      description: 'The 2 to 15 files, functions, folders or packages the answer is about, most important first',
      items: { type: 'object', properties: { ref: { type: 'string', description: 'A repo-relative file or folder path (src/lib/db.ts), a symbol id (s:src/lib/db.ts#query) or a package (x:npm:stripe)' }, note: { type: 'string', description: 'Its part in the answer, in one short sentence' } }, required: ['ref', 'note'] },
    },
    steps: {
      type: 'array',
      description: 'Only when the answer is a sequence (a request travelling through the code): the walkthrough in order, 2 to 10 steps',
      items: { type: 'object', properties: { ref: { type: 'string' }, note: { type: 'string', description: 'What happens at this step' } }, required: ['ref', 'note'] },
    },
    followUps: { type: 'array', description: '2 or 3 short questions the reader might ask next', items: { type: 'string' } },
  },
  required: ['title', 'answer', 'nodes'],
} as const

/** What the asker is looking at, and the conversation so far (the agent keeps no session: follow-ups bring it along). */
export interface AskContext {
  /** The selection in the viewer: a node id, with its name and path. */
  selected?: { id: string; name?: string; path?: string }
  /** The view the asker is in (city, blocks …). */
  view?: string
  /** Earlier questions and answers, oldest first (the last few). */
  history?: { question: string; answer: string; nodes: string[] }[]
}

/** The instructions appended to the agent's system prompt: how to use the map, and what to answer. */
export function askInstructions(query: string): string {
  return [
    'You answer questions about the codebase in the current folder for someone looking at its architecture map (archrift).',
    'You can read and search the code (Read, Grep, Glob) and ask the map; you cannot change anything. The map answers fast, so start there:',
    `  ${query} overview                  the project: what was written about it, its blocks, features, layers, rules`,
    `  ${query} find <words>               files, folders, functions and routes by name, path, route or description`,
    `  ${query} file <path>                one file: what it uses, who uses it, its jobs, rules, riskiest functions, description`,
    `  ${query} path <from> <to>           how one depends on the other, hop by hop`,
    `  ${query} rules <path>               what it may depend on and who may depend on it`,
    `  ${query} ways <path> --job "<job>"  how a folder does a job (calling the server, dates, state …)`,
    'Then read the code you need to be sure: an answer that cites the code beats one that guesses from names.',
    'Answer in plain words, in the language of the question, in a few sentences or a short list; name what to watch out for when you see it (a missing check, a step that can fail half way).',
    'Cite files and functions as [[src/lib/db.ts]] or [[s:src/lib/db.ts#query]] (the symbol id: the file path, #, the name; Class.method for a method).',
    'In nodes, list the 2 to 15 files, functions, folders or packages (x:npm:stripe) the answer is about, each with its part in one sentence. Add steps only when the answer is a sequence. Suggest 2 or 3 follow-up questions.',
  ].join('\n')
}

/** The question as the agent gets it: with what the asker has selected and the conversation so far. */
export function askPrompt(question: string, context: AskContext = {}): string {
  const lines: string[] = []
  for (const h of (context.history ?? []).slice(-3)) lines.push(`Earlier question: ${h.question}`, `Your answer: ${h.answer.length > 800 ? `${h.answer.slice(0, 799)}…` : h.answer}`, `About: ${h.nodes.slice(0, 10).join(', ')}`, '')
  const s = context.selected
  if (s) lines.push(`Selected on the map: ${s.path ?? s.id}${s.name && s.path && !s.path.endsWith(s.name) ? ` (${s.name})` : ''}${s.id.startsWith('s:') ? ` [${s.id}]` : ''}. "This" or "it" in the question means it.`)
  if (context.view) lines.push(`The map shows the ${context.view} view.`)
  lines.push(`Question: ${question}`)
  return lines.join('\n')
}

/** The node a reference names: an id, a file or folder path (with or without `./`), a package name, a `METHOD /path` route. */
export function nodeFor(graph: Graph, index: GraphIndex, ref: string): string | undefined {
  const r = ref.trim().replace(/^\.\//, '').replace(/\/+$/, '').replace(/:(\d+)(-\d+)?$/, '')
  if (!r) return undefined
  if (/^[fdsx]:/.test(r)) {
    if (index.byId.has(r)) return r
    // a member written Class.method as Class#method, or a symbol given by its file and a member path
    if (r.startsWith('s:')) return index.byId.has(r.replace(/#(\w+)#/, '#$1.')) ? r.replace(/#(\w+)#/, '#$1.') : undefined
    return undefined
  }
  if (index.byId.has(`f:${r}`)) return `f:${r}`
  if (index.byId.has(`d:${r}`)) return `d:${r}`
  // path#name without the s:
  if (r.includes('#') && index.byId.has(`s:${r}`)) return `s:${r}`
  for (const pkg of [`x:npm:${r}`, `x:node:${r.replace(/^node:/, '')}`]) if (index.byId.has(pkg)) return pkg
  // a route: `POST /api/orders` or `/accounts`
  const route = /^(?:[A-Z]+\s+)?(\/\S*)$/.exec(r)?.[1]
  if (route) {
    const hit = graph.nodes.find(n => n.kind === 'file' && n.tags?.some(t => t === `api:${route}` || t === `route:${route}`))
    if (hit) return hit.id
  }
  return undefined
}

/** The agent's answer checked against the graph: references resolved, what it named but the graph lacks set apart, lengths bounded. */
export function resolveAnswer(graph: Graph, question: string, raw: RawAnswer, index = new GraphIndex(graph)): Answer {
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const unknown: string[] = []
  const list = (v: unknown, max: number): AnswerNode[] => {
    const out: AnswerNode[] = []
    for (const item of Array.isArray(v) ? v : []) {
      const x = item as { ref?: unknown; id?: unknown; note?: unknown } | null
      const ref = text(x?.ref ?? x?.id, 300)
      if (!ref) continue
      const id = nodeFor(graph, index, ref)
      if (!id) {
        if (!unknown.includes(ref)) unknown.push(ref)
        continue
      }
      if (out.some(n => n.id === id)) continue
      out.push({ id, note: text(x?.note, 300) })
      if (out.length >= max) break
    }
    return out
  }
  const answer = text(raw.answer, 6000) || '(no answer)'
  const refs: Record<string, string> = {}
  for (const m of answer.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const id = nodeFor(graph, index, m[1])
    if (id) refs[m[1]] = id
  }
  const steps = list(raw.steps, 12)
  // every step is on the map, listed or not
  const nodes = list(raw.nodes, 20)
  for (const s of steps) if (!nodes.some(n => n.id === s.id)) nodes.push(s)
  for (const id of Object.values(refs)) if (!nodes.some(n => n.id === id)) nodes.push({ id, note: '' })
  return {
    question,
    title: text(raw.title, 120) || question.slice(0, 80),
    answer,
    nodes,
    steps,
    followUps: (Array.isArray(raw.followUps) ? raw.followUps : []).map(f => text(f, 200)).filter(Boolean).slice(0, 4),
    refs,
    unknown,
  }
}

/** What the agent is doing, in a few words, from one of its tool calls (the Ask bar shows it while it works). */
export function progressOf(tool: string, input: Record<string, unknown>, root: string): string | undefined {
  const rel = (p: unknown) => (typeof p === 'string' ? (p === root ? 'the project' : p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p) : '')
  switch (tool) {
    case 'Read':
      return `Reading ${rel(input.file_path)}`
    case 'Grep':
      return `Searching the code for ${JSON.stringify(input.pattern ?? '')}${input.path ? ` in ${rel(input.path)}` : ''}`
    case 'Glob':
      return `Looking for files ${input.pattern ?? ''}`
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      const q = / query (\w+)(.*)$/.exec(cmd)
      return q ? `Asking the map: ${q[1]}${q[2].replace(/--graph\s+\S+/, '').replace(/\s+/g, ' ').trimEnd()}` : undefined
    }
    case 'StructuredOutput':
      return 'Writing the answer'
    default:
      return undefined
  }
}
