// The Ask bar: the agent's answer resolved against the graph (src/core/ask.ts),
// and `claude -p` run read-only with the map in reach (src/cli/ask.ts), here a
// stand-in that prints what the real one prints (tests/fixtures/fake-claude.mjs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { SECRETS, askArgs, findClaude, queryCommand, runAsk } from '../../src/cli/ask.ts'
import { askPrompt, nodeFor, progressOf, resolveAnswer } from '../../src/core/ask.ts'
import { GraphIndex } from '../../src/core/graph-index.ts'
import type { Graph } from '../../src/core/model.ts'
import { FIXTURES, analyzeFixture } from '../helpers/fixtures.ts'

const FAKE = path.resolve(import.meta.dirname, '../fixtures/fake-claude.mjs')
const root = path.join(FIXTURES, 'plain-ts')
let graph: Graph

beforeAll(async () => {
  graph = await analyzeFixture('plain-ts')
})

describe("the agent's answer", () => {
  it('names nodes by id, path, folder, package, route, or Class#method', () => {
    const index = new GraphIndex(graph)
    expect(nodeFor(graph, index, 'src/app.ts')).toBe('f:src/app.ts')
    expect(nodeFor(graph, index, './src/app.ts:12')).toBe('f:src/app.ts')
    expect(nodeFor(graph, index, 'src/')).toBe('d:src')
    expect(nodeFor(graph, index, 's:src/shapes.ts#makeCircle')).toBe('s:src/shapes.ts#makeCircle')
    expect(nodeFor(graph, index, 'src/shapes.ts#makeCircle')).toBe('s:src/shapes.ts#makeCircle')
    expect(nodeFor(graph, index, 's:src/shapes.ts#Circle#area')).toBe('s:src/shapes.ts#Circle.area')
    expect(nodeFor(graph, index, 'src/nowhere.ts')).toBeUndefined()
    expect(nodeFor(graph, index, '')).toBeUndefined()
  })

  it('keeps what the graph has, sets the rest apart, and puts every step and citation on the map', () => {
    const a = resolveAnswer(graph, 'How does it start?', {
      title: 'Start',
      answer: 'See [[src/app.ts]] and [[src/util.ts]] and [[src/gone.ts]].',
      nodes: [{ ref: 'src/app.ts', note: 'The start.' }, { ref: 'src/app.ts', note: 'twice' }, { ref: 'src/gone.ts', note: 'x' }, 'junk'],
      steps: [{ ref: 's:src/shapes.ts#makeCircle', note: 'makes one' }],
      followUps: ['Next?', 3],
    })
    expect(a.nodes.map(n => n.id)).toEqual(['f:src/app.ts', 's:src/shapes.ts#makeCircle', 'f:src/util.ts'])
    expect(a.steps).toEqual([{ id: 's:src/shapes.ts#makeCircle', note: 'makes one' }])
    expect(a.refs).toEqual({ 'src/app.ts': 'f:src/app.ts', 'src/util.ts': 'f:src/util.ts' })
    expect(a.unknown).toEqual(['src/gone.ts'])
    expect(a.followUps).toEqual(['Next?'])
    expect(resolveAnswer(graph, 'Why?', {}).title).toBe('Why?')
  })

  it('carries the selection and the last few questions into the prompt', () => {
    const p = askPrompt('What uses it?', {
      selected: { id: 's:src/shapes.ts#makeCircle', name: 'makeCircle', path: 'src/shapes.ts' },
      view: 'city',
      history: [1, 2, 3, 4].map(i => ({ question: `q${i}`, answer: `a${i}`, nodes: ['f:src/app.ts'] })),
    })
    expect(p).not.toContain('q1')
    expect(p).toContain('Earlier question: q4')
    expect(p).toContain('Selected on the map: src/shapes.ts (makeCircle) [s:src/shapes.ts#makeCircle]')
    expect(p.endsWith('Question: What uses it?')).toBe(true)
  })

  it('says what the agent is doing in a few words', () => {
    expect(progressOf('Read', { file_path: '/p/src/a.ts' }, '/p')).toBe('Reading src/a.ts')
    expect(progressOf('Bash', { command: 'node /x/main.ts query file src/a.ts --graph /g.json' }, '/p')).toBe('Asking the map: file src/a.ts')
    expect(progressOf('Bash', { command: 'ls' }, '/p')).toBeUndefined()
    expect(progressOf('Grep', { pattern: 'circle', path: '/p' }, '/p')).toBe('Searching the code for "circle" in the project')
  })
})

describe('asking claude', () => {
  const graphFile = path.join(os.tmpdir(), 'archrift-ask-graph.json')

  it('runs it read-only, with only the map besides reading, and no session kept', () => {
    const args = askArgs({ question: 'Q' })
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
    expect(allowed).toEqual(['Read', 'Grep', 'Glob', `Bash(${queryCommand()}:*)`])
    // never secrets, whatever it is asked (a deny rule wins over the allowed Read)
    expect(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--permission-mode'))).toEqual(SECRETS)
    expect(SECRETS).toContain('Read(**/.env*)')
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--strict-mcp-config')
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]).required).toEqual(['title', 'answer', 'nodes'])
    // Claude Code's default model, unless serve --ask-model names one
    expect(args).not.toContain('--model')
    const sonnet = askArgs({ question: 'Q', model: 'sonnet' })
    expect(sonnet.slice(sonnet.indexOf('--model'), sonnet.indexOf('--model') + 2)).toEqual(['--model', 'sonnet'])
  })

  it('reports its steps as it works and returns the answer checked against the graph', async () => {
    const progress: string[] = []
    const a = await runAsk({ program: FAKE, root, graphFile, graph, question: 'How does it start?', onProgress: t => progress.push(t) })
    expect(progress).toEqual(['Reading src/app.ts', 'Asking the map: file src/util.ts', 'Writing the answer'])
    expect(a.title).toBe('How the app starts')
    expect(a.answer).toContain('no session')
    expect(a.answer).toContain('graph: given')
    expect(a.nodes.map(n => n.id)).toEqual(['f:src/app.ts', 's:src/shapes.ts#makeCircle'])
    expect(a.unknown).toEqual(['src/nowhere.ts'])
  })

  it("passes on the CLI's own failure, an answer outside the schema, and stops when told or when it takes too long", async () => {
    const run = (mode: string, more: Partial<Parameters<typeof runAsk>[0]> = {}) => {
      process.env.FAKE_CLAUDE = mode
      try {
        return runAsk({ program: FAKE, root, graphFile, graph, question: 'Q', ...more })
      } finally {
        delete process.env.FAKE_CLAUDE
      }
    }
    await expect(run('error')).rejects.toThrow('Not logged in')
    await expect(run('prose')).rejects.toThrow(/gave no answer/)
    const stop = new AbortController()
    const hanging = run('hang', { signal: stop.signal })
    setTimeout(() => stop.abort(), 100)
    await expect(hanging).rejects.toThrow('stopped')
    await expect(run('hang', { timeoutMs: 150 })).rejects.toThrow(/no answer within/)
  })

  it('finds claude where it was put, and says why when it is not there', () => {
    expect(findClaude(FAKE)).toEqual({ available: true, engine: 'Claude Code', program: FAKE })
    const missing = findClaude(path.join(os.tmpdir(), 'no-such-claude'))
    expect(missing.available).toBe(false)
    expect(missing.why).toMatch(/no claude program/)
    expect(fs.existsSync(FAKE)).toBe(true)
  })
})
