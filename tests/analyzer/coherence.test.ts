import { describe, expect, it } from 'vitest'
import { CATALOG } from '../../src/analyzer/coherence/catalog.ts'
import { concernsOf, importMatches, tagParadigms } from '../../src/analyzer/coherence/paradigms.ts'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import type { FileFragment } from '../../src/analyzer/fragment.ts'
import type { GraphNode } from '../../src/core/model.ts'

/** A file node and its fragment: what it imports (specifier → project file it resolves to, if any). */
function source(path: string, imports: Record<string, string | null>, tags: string[] = []) {
  const node: GraphNode = { id: `f:${path}`, kind: 'file', name: path.split('/').pop()!, path, tags: [...tags] }
  const fragment = {
    path,
    language: 'ts',
    imports: Object.entries(imports).map(([spec, file]) => ({
      spec,
      kind: 'imports',
      line: 1,
      col: 1,
      resolved: { default: file ? { kind: 'file', path: file } : { kind: 'external', id: `x:npm:${spec}` } },
    })),
  } as unknown as FileFragment
  return { node, fragment }
}

function run(files: ReturnType<typeof source>[], texts: Record<string, string> = {}, config: unknown = {}) {
  const read: string[] = []
  const concerns = tagParadigms({
    files: files.map(f => f.node),
    fragments: files.map(f => f.fragment),
    config: ConfigSchema.parse(config),
    readText: p => {
      read.push(p)
      return texts[p]
    },
  })
  const ways = (path: string) => (files.find(f => f.node.path === path)!.node.tags ?? []).filter(t => t.startsWith('paradigm:')).sort()
  return { concerns, ways, read }
}

describe('paradigms: which way each file does each job', () => {
  it('matches a package or prefix, the name followed by / or ., or a regular expression', () => {
    expect(importMatches('date-fns', 'date-fns')).toBe(true)
    expect(importMatches('date-fns', 'date-fns/locale')).toBe(true)
    expect(importMatches('date-fns', 'date-fns-tz')).toBe(false)
    expect(importMatches('org.junit.jupiter', 'org.junit.jupiter.api.Test')).toBe(true)
    expect(importMatches('java.time', 'java.time.*')).toBe(true)
    expect(importMatches('java.util.Date', 'java.util.DateFormatter')).toBe(false)
    expect(importMatches(/^log$/, 'log/slog')).toBe(false)
  })

  it('tags files by what they import, test concerns on test files only and the others on production code', () => {
    const { ways } = run([
      source('src/a.ts', { moment: null, rxjs: null }),
      source('src/b.ts', { 'date-fns/locale': null }),
      source('src/a.spec.ts', { 'ts-mockito': null, moment: null }, ['test']),
      source('src/c.kt', { 'org.junit.jupiter.api.Test': null }),
      source('src/CTest.kt', { 'org.junit.Test': null, 'org.junit.jupiter.api.Test': null }, ['test']),
    ])
    expect(ways('src/a.ts')).toEqual(['paradigm:js.async=rxjs', 'paradigm:js.dates=moment'])
    expect(ways('src/b.ts')).toEqual(['paradigm:js.dates=date-fns'])
    // a test's moment counts for no concern: dates are production code's
    expect(ways('src/a.spec.ts')).toEqual(['paradigm:js.mocks=ts-mockito'])
    // a production file importing JUnit isn't a test
    expect(ways('src/c.kt')).toEqual([])
    expect(ways('src/CTest.kt')).toEqual(['paradigm:jvm.test=junit4', 'paradigm:jvm.test=junit5'])
  })

  it('reads a file’s text only when a text pattern looks at files like it', () => {
    const { ways, read } = run(
      [source('src/Svc.kt', {}), source('src/Other.kt', {}), source('src/page.tsx', {}), source('README.md', {})],
      {
        'src/Svc.kt': '@Service\nclass Svc(private val repo: Repo) {\n  @Autowired\n  lateinit var clock: Clock\n}\n',
        'src/Other.kt': 'class Other',
        'src/page.tsx': "import React, { createContext } from 'react'\nexport const C = createContext(null)\nconsole.log('x')\n",
      },
    )
    expect(ways('src/Svc.kt')).toEqual(['paradigm:jvm.di=constructor', 'paradigm:jvm.di=field'])
    expect(ways('src/Other.kt')).toEqual([])
    expect(ways('src/page.tsx')).toEqual(['paradigm:js.logging=console', 'paradigm:js.state=react-context'])
    // once per file, and never one no pattern applies to
    expect(read.sort()).toEqual(['src/Other.kt', 'src/Svc.kt', 'src/page.tsx'])
  })

  it('takes a way spelled out in a comment, a label or a regular expression for no use of it', () => {
    const catalog = "// alert( is the browser's way\nconst ways = [{ label: 'alert()', text: /(?:^|[^.\\w$])alert\\(/ }, { label: 'forms (FormGroup, ngModel)', text: /\\bFormGroup\\b|ngModel/ }, { label: '$localize' }]\n"
    const { ways } = run([source('src/catalog.ts', {}), source('src/save.ts', {})], { 'src/catalog.ts': catalog, 'src/save.ts': "export const save = () => alert('saved') // and a FormGroup? no\n" })
    expect(ways('src/catalog.ts')).toEqual([])
    expect(ways('src/save.ts')).toEqual(['paradigm:js.notify=alert'])
  })

  it('reads strings for the ways that live in them: templates, class names, import lines', () => {
    const { ways } = run(
      [source('src/form.component.ts', { '@angular/core': null }), source('src/hello.ts', {}), source('src/page.tsx', {}), source('src/label.ts', {})],
      {
        'src/form.component.ts': "@Component({ template: '<input [(ngModel)]=\"name\"> {{ items$ | async }}' })\nexport class Form {}\n",
        'src/hello.ts': 'export const hello = $localize`Hello`\n',
        'src/page.tsx': 'export const Page = () => <div className="flex items-center gap-2" />\n',
        'src/label.ts': "export const labels = ['template-driven forms (ngModel)', 'i18n ($localize)', 'use | async in templates']\n",
      },
    )
    expect(ways('src/form.component.ts')).toEqual(['paradigm:js.forms=template-forms', 'paradigm:ng.subscriptions=async-pipe'])
    expect(ways('src/hello.ts')).toEqual(['paradigm:js.i18n=angular-i18n'])
    expect(ways('src/page.tsx')).toEqual(['paradigm:js.styling=tailwind'])
    expect(ways('src/label.ts')).toEqual([])
  })

  it('looks at Angular’s concerns in Angular code only', () => {
    const ctor = 'export class S {\n  constructor(private http: HttpClient) {}\n}\n'
    const { ways } = run([source('src/s.service.ts', { '@angular/core': null }), source('src/plain.ts', {})], { 'src/s.service.ts': ctor, 'src/plain.ts': ctor })
    expect(ways('src/s.service.ts')).toEqual(['paradigm:ng.di=constructor'])
    expect(ways('src/plain.ts')).toEqual([])
  })

  it('reports the concerns some file uses, with the ways used, in the catalog’s order', () => {
    const { concerns } = run([source('a.ts', { moment: null }), source('b.ts', { 'date-fns': null })], {}, { coherence: { accept: { 'js.dates': 'both on purpose' } } })
    expect(concerns).toEqual([
      {
        id: 'js.dates',
        label: 'Dates',
        stack: 'JS',
        about: 'date arithmetic, parsing and formatting',
        accepted: 'both on purpose',
        paradigms: [
          { id: 'moment', label: 'Moment.js', legacy: true },
          { id: 'date-fns', label: 'date-fns' },
        ],
      },
    ])
  })

  it('takes a project’s own concerns, and project files standing for a catalog way', () => {
    const config = {
      coherence: {
        concerns: [
          // the project's tRPC client wrapper is the tRPC way
          { id: 'js.http', paradigms: [{ id: 'trpc', imports: ['src/trpc/client.ts'] }] },
          { id: 'events', label: 'Events', paradigms: [{ id: 'bus', label: 'event bus', imports: ['/^@acme\\/bus/'] }, { id: 'emitter', text: 'new EventEmitter\\(' }] },
        ],
      },
    }
    const { ways, concerns } = run(
      [source('src/page.ts', { '@/trpc/client': 'src/trpc/client.ts' }), source('src/q.ts', { '@acme/bus/core': null }), source('src/e.ts', {})],
      { 'src/e.ts': 'const e = new EventEmitter()' },
      config,
    )
    expect(ways('src/page.ts')).toEqual(['paradigm:js.http=trpc'])
    expect(ways('src/q.ts')).toEqual(['paradigm:events=bus'])
    expect(ways('src/e.ts')).toEqual(['paradigm:events=emitter'])
    expect(concerns.find(c => c.id === 'events')).toMatchObject({ label: 'Events', stack: 'project', paradigms: [{ id: 'bus', label: 'event bus' }, { id: 'emitter', label: 'emitter' }] })
    // the catalog itself is left as it was
    expect(CATALOG.find(c => c.id === 'js.http')!.paradigms.find(p => p.id === 'trpc')!.imports).not.toContain('src/trpc/client.ts')
    expect(concernsOf(ConfigSchema.parse(config)).find(c => c.id === 'js.http')!.paradigms.find(p => p.id === 'trpc')!.imports).toContain('src/trpc/client.ts')
  })

  it('rejects a concern without ways or with a bad id', () => {
    expect(ConfigSchema.safeParse({ coherence: { concerns: [{ id: 'x', paradigms: [] }] } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ coherence: { concerns: [{ id: 'a b', paradigms: [{ id: 'p' }] }] } }).success).toBe(false)
  })

  it('has unique concern and paradigm ids in the catalog', () => {
    const ids = CATALOG.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of CATALOG) expect(new Set(c.paradigms.map(p => p.id)).size, c.id).toBe(c.paradigms.length)
  })
})
