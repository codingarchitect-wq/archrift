import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/analyzer/config.ts'
import { decodeGraph } from '../../src/core/serialize.ts'
import { FIXTURES } from '../helpers/fixtures.ts'

const CLI = path.resolve(import.meta.dirname, '../../src/cli/main.ts')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-cli-'))
  dirs.push(d)
  return d
}
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

describe('archrift analyze', () => {
  it('writes a decodable graph, its sites, a cache and a dump, and prints a summary', () => {
    const out = tmp()
    const r = cli('analyze', path.join(FIXTURES, 'suffix-targets'), '--out', path.join(out, 'graph.json'), '--dump', path.join(out, 'graph.txt'))
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/archrift analyze suffix-targets/)
    expect(r.stderr).toMatch(/0 unresolved imports/)
    const graph = decodeGraph(
      JSON.parse(fs.readFileSync(path.join(out, 'graph.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(out, 'graph.sites.json'), 'utf8')),
    )
    expect(graph.meta.targets).toEqual(['web', 'desktop'])
    expect(graph.sites.some(s => s.length > 0)).toBe(true)
    expect(fs.existsSync(path.join(out, 'cache', 'fragments.json'))).toBe(true)
    expect(fs.readFileSync(path.join(out, 'graph.txt'), 'utf8')).toMatch(/^# nodes/)
  })

  it('fails with a readable message on an invalid config', () => {
    const dir = tmp()
    const config = path.join(dir, 'config.json')
    fs.writeFileSync(config, JSON.stringify({ targets: { web: { moduleSufixes: [''] } } }))
    const r = cli('analyze', path.join(FIXTURES, 'plain-ts'), '--config', config, '--out', path.join(dir, 'g.json'), '--quiet')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/invalid config/)
    expect(r.stderr).toMatch(/moduleSufixes/)
  })

  it('prints usage for an unknown command', () => {
    const r = cli('frobnicate')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unknown command: frobnicate/)
  })
})

describe('archrift check', () => {
  it('lists broken and passing rules and fails on a broken error rule', () => {
    const out = tmp()
    const r = cli('check', path.join(FIXTURES, 'suffix-targets'), '--out', path.join(out, 'graph.json'))
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/1 errors · 1 warnings · 3 rules/)
    expect(r.stdout).toMatch(/✗ generated-behind-platform \(error\): 1/)
    expect(r.stdout).toMatch(/src\/main\.ts → src\/generated\/client\.ts/)
    expect(r.stdout).toMatch(/! main-reaches-desktop \(warn\): 1/)
    expect(r.stdout).toMatch(/src\/platform\/impl\.desktop\.ts {2}\[desktop\]\n {6}src\/main\.ts\n {4}→ src\/platform\/index\.ts\n {4}→ src\/platform\/impl\.desktop\.ts/)
    expect(r.stdout).toMatch(/✓ web-without-desktop-code/)
    expect(r.stderr).toBe('')
  })

  it('reports as JSON', () => {
    const out = tmp()
    const r = cli('check', path.join(FIXTURES, 'suffix-targets'), '--out', path.join(out, 'graph.json'), '--format', 'json')
    const report = JSON.parse(r.stdout)
    expect(report).toMatchObject({ project: 'suffix-targets', errors: 1, warnings: 1 })
    expect(report.rules.map((x: { name: string }) => x.name)).toEqual(['generated-behind-platform', 'web-without-desktop-code', 'main-reaches-desktop'])
    expect(report.violations[1]).toMatchObject({ rule: 'main-reaches-desktop', targets: ['desktop'], sources: ['f:src/main.ts'] })
  })

  it('passes when nothing is broken, or no rules are configured', () => {
    const dir = tmp()
    const config = path.join(dir, 'config.json')
    fs.writeFileSync(config, JSON.stringify({ rules: [{ name: 'acyclic', cycles: 'forbid' }] }))
    const clean = cli('check', path.join(FIXTURES, 'js-only'), '--config', config, '--out', path.join(dir, 'g.json'))
    expect(clean.stdout).toMatch(/0 errors · 0 warnings · 1 rules\n\n✓ acyclic/)
    expect(clean.status).toBe(0)
    const none = cli('check', path.join(FIXTURES, 'js-only'), '--out', path.join(dir, 'h.json'))
    expect(none.stdout).toMatch(/no rules configured/)
    expect(none.status).toBe(0)
  })

  it('fails a rule that matches nothing, and lists what breaks a limit', () => {
    const dir = tmp()
    const config = path.join(dir, 'config.json')
    const rules = [
      { name: 'acyclic-src', cycles: 'forbid', scope: 'src/**' },
      { name: 'small-lib', severity: 'warn', limit: { files: 'lib/**', max: { loc: 3 } } },
    ]
    fs.writeFileSync(config, JSON.stringify({ rules }))
    const r = cli('check', path.join(FIXTURES, 'js-only'), '--config', config, '--out', path.join(dir, 'g.json'))
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/1 errors · 1 warnings · 2 rules/)
    expect(r.stdout).toMatch(/✗ acyclic-src \(error\): matches nothing\n {2}\? scope src\/\*\* matches no file/)
    expect(r.stdout).toMatch(/! small-lib \(warn\): 1\n {2}lib\/math\.js: loc 4, more than 3/)
    // as a warning, it passes
    fs.writeFileSync(config, JSON.stringify({ rules: [{ ...rules[0], severity: 'warn' }] }))
    expect(cli('check', path.join(FIXTURES, 'js-only'), '--config', config, '--out', path.join(dir, 'g.json')).status).toBe(0)
  })

  it('rejects an unknown format', () => {
    const r = cli('check', path.join(FIXTURES, 'js-only'), '--format', 'xml')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unknown format: xml/)
  })
})

describe('archrift coherence', () => {
  // the Kotlin fixture's order service keeps time in java.time but stamps with a java.util.Date
  it('reports the jobs done several ways, with the migration and the files left', () => {
    const out = tmp()
    const r = cli('coherence', path.join(FIXTURES, 'kotlin-spring'), '--out', path.join(out, 'graph.json'), '--no-history')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^archrift coherence kotlin-spring: 7 concerns · 6 done one way · 0 one way per block · 1 mixed/)
    expect(r.stdout).toMatch(/Mixed: blocks doing one job several ways[^\n]*\n {2}JVM · Dates: date and time values\n {4}java\.time 1 · java\.util\.Date \/ Calendar \(legacy\) 1/)
    expect(r.stdout).toMatch(/migration java\.util\.Date \/ Calendar → java\.time: 50 % done, 1 file left/)
    expect(r.stdout).toMatch(/order-service\/src\/main\/kotlin\/com\/acme\/order\/LegacyStamp\.kt {2}java\.util\.Date \/ Calendar/)
    expect(r.stdout).toMatch(/One way\n(?: {2}.*\n)* {2}JVM · Test framework: JUnit 5, 1 file/)
    expect(r.stderr).toBe('')
  })

  it('reports as JSON', () => {
    const out = tmp()
    const r = cli('coherence', path.join(FIXTURES, 'kotlin-spring'), '--out', path.join(out, 'graph.json'), '--no-history', '--format', 'json')
    const report = JSON.parse(r.stdout)
    expect(report.totals).toMatchObject({ concerns: 7, decoherent: 1, strays: 1 })
    expect(report.concerns[0]).toMatchObject({ id: 'jvm.dates', kind: 'mixed', transitions: 1, migration: { done: 0.5, left: ['order-service/src/main/kotlin/com/acme/order/LegacyStamp.kt'] } })
  })
})

describe('archrift query', () => {
  const ask = (fixture: string, ...args: string[]) => cli('query', ...args, '--root', path.join(FIXTURES, fixture), '--out', path.join(tmp(), 'graph.json'), '--no-history')

  it('says how a folder does a job and which way to follow, naming the file that differs', () => {
    const r = ask('kotlin-spring', 'ways', 'order-service', '--job', 'dates')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^order-service\/ \(a folder: 9 files/)
    expect(r.stdout).toMatch(/JVM · Dates \(date and time values\): done several ways\n {2}order-service\/src\/main\/kotlin\/com\/acme\/order: java\.time 1 · java\.util\.Date \/ Calendar \(legacy\) 1 → use java\.time, as order-service\/src\/main\/kotlin\/com\/acme\/order\/OrderClock\.kt does/)
    expect(r.stdout).toMatch(/differs from its block: order-service\/src\/main\/kotlin\/com\/acme\/order\/LegacyStamp\.kt uses java\.util\.Date/)
  })

  it('answers for a file not written yet, as JSON', () => {
    const r = ask('kotlin-spring', 'ways', 'order-service/src/main/kotlin/com/acme/order/Invoice.kt', '--job', 'jvm.dates', '--format', 'json')
    const a = JSON.parse(r.stdout)
    expect(a.place).toEqual({ kind: 'new', path: 'order-service/src/main/kotlin/com/acme/order/Invoice.kt' })
    expect(a.jobs[0].blocks[0]).toMatchObject({ use: { label: 'java.time' }, examples: ['order-service/src/main/kotlin/com/acme/order/OrderClock.kt'] })
  })

  it('lists the rules for a place, and whether a new dependency would break them', () => {
    const rules = ask('fullstack', 'rules', 'src/client')
    expect(rules.stdout).toMatch(/must not depend on src\/server\/\*\* {2}\[client-apart-from-server, warn\]/)
    expect(rules.stdout).toMatch(/Broken now \(2\):\n {2}! client-apart-from-server: src\/client\/trpc\.ts → src\/server\/routers\/index\.ts/)
    const r = ask('fullstack', 'rules', 'src/app/page.tsx', '--to', 'src/server/routers/index.ts')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^src\/app\/page\.tsx → src\/server\/routers\/index\.ts: not allowed\n {2}✗ pages-use-services \(error\)/)
    expect(r.stdout).toMatch(/✗ no-server-in-pages \(error\): src\/server\/routers\/index\.ts is reachable/)
    expect(ask('fullstack', 'rules', 'src/app/page.tsx', '--to', 'src/ui/ThemeContext.tsx').stdout).toMatch(/: allowed: no rule breaks/)
  })

  it('traces how one file depends on another', () => {
    const r = ask('fullstack', 'path', 'src/app/(shop)/accounts/page.tsx', 'src/client/trpc.ts')
    expect(r.stdout).toMatch(/depends on src\/client\/trpc\.ts:\n1 shortest path, 2 steps\n\n {2}src\/app\/\(shop\)\/accounts\/page\.tsx\n {4}→ src\/client\/service\.ts {2}\([^)]*imports[^)]*\)\n {4}→ src\/client\/trpc\.ts/)
  })

  it('says what depends on a method: its users, the pages and the tests; --depth stops the walk', () => {
    const r = ask('fullstack', 'impact', 'src/client/service.ts#CloudService.getAccounts')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^src\/client\/service\.ts › CloudService\.getAccounts: 2 files depend on it \(2 directly\), in 1 feature, 1 entry point\n/)
    expect(r.stdout).toMatch(/Entry points reached \(1\):\n {2}page \/accounts {2}src\/app\/\(shop\)\/accounts\/page\.tsx\n/)
    expect(r.stdout).toMatch(/Tests that reach it \(run these, 1\):\n {2}tests\/service\.test\.ts\n/)
    expect(ask('fullstack', 'impact', 'src/client/trpc.ts', '--depth', '1').stdout).toMatch(/; walked 1 step, 2 files further \(--depth\)\n/)
    expect(ask('fullstack', 'impact', 'src/client/trpc.ts', '--depth', '0').status).toBe(2)
  })

  it('asks which file a name means (exit 3), says when nothing has it (exit 4), and wants a question (exit 2)', () => {
    const which = ask('fullstack', 'file', 'page.tsx')
    expect(which.status).toBe(3)
    expect(which.stdout).toMatch(/several files have that name, which one\?\n {2}src\/app\/\(shop\)\/accounts\/\[id\]\/page\.tsx/)
    expect(ask('fullstack', 'file', 'nothing-like-it').status).toBe(4)
    expect(ask('fullstack', 'why', 'src').status).toBe(2)
  })
})

describe('archrift diff', () => {
  // a shop whose pages must not use the server: the change adds a page that does, with another date library
  it('reports what a change does to rules, coherence and blocks, and fails on a new error', () => {
    const repo = tmp()
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
      fs.writeFileSync(path.join(repo, rel), text)
    }
    write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }))
    write('.archrift/config.json', JSON.stringify({ name: 'shop', rules: [{ name: 'pages-not-server', forbid: { from: 'src/app/**', to: 'src/server/**' } }] }))
    write('src/app/a.ts', "import { format } from 'date-fns'\nexport const a = (d: Date) => format(d, 'yyyy')\n")
    write('src/app/b.ts', "import { addDays } from 'date-fns'\nexport const b = (d: Date) => addDays(d, 1)\n")
    write('src/server/db.ts', 'export const db = { rows: [] as string[] }\n')
    const git = (...args: string[]) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: repo })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'start')
    write('src/app/c.ts', "import dayjs from 'dayjs'\nimport { db } from '../server/db'\nexport const c = () => dayjs().format() + db.rows.length\n")

    const out = path.join(tmp(), 'graph.json')
    const r = cli('diff', repo, '--out', out, '--quiet')
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/^archrift diff shop: HEAD \([0-9a-f]{8}\) → the working tree, 1 file touched \(1 new, 0 removed\)/)
    expect(r.stdout).toMatch(/Rules: 1 new violation\n {2}✗ pages-not-server \(error\): src\/app\/c\.ts → src\/server\/db\.ts/)
    expect(r.stdout).toMatch(/Coherence: 1 new way, 1 file that does a job differently from its block\n {2}JS · Dates: new way Day\.js\n {4}src\/app\/c\.ts uses Day\.js; src\/app uses date-fns \(e\.g\. src\/app\/a\.ts, src\/app\/b\.ts\)/)
    expect(r.stdout).toMatch(/Blocks: 1 new dependency between blocks\n {2}src\/app → src\/server, through src\/app\/c\.ts → src\/server\/db\.ts/)

    const md = cli('diff', repo, '--out', out, '--quiet', '--format', 'markdown')
    expect(md.stdout).toMatch(/^### archrift: what this change does to the architecture/)
    expect(md.stdout).toMatch(/- ✗ \*\*pages-not-server\*\* \(error\): `src\/app\/c\.ts` → `src\/server\/db\.ts`/)

    // the change committed, then compared commit to commit: the same findings
    git('add', '-A')
    git('commit', '-qm', 'c')
    const json = JSON.parse(cli('diff', repo, '--out', out, '--quiet', '--base', 'HEAD~1', '--head', 'HEAD', '--format', 'json').stdout)
    expect(json.rules.added).toHaveLength(1)
    expect(json.jobs[0]).toMatchObject({ id: 'js.dates', newWays: ['Day.js'], deviations: [{ path: 'src/app/c.ts', blockWay: 'date-fns' }] })

    // nothing changed since: nothing to say, exit 0
    const clean = cli('diff', repo, '--out', out, '--quiet')
    expect(clean.status).toBe(0)
    expect(clean.stdout).toMatch(/Nothing changes for the rules/)

    // the server folder renamed: the rule about it would check nothing, and that fails too
    fs.renameSync(path.join(repo, 'src/server'), path.join(repo, 'src/backend'))
    const renamed = cli('diff', repo, '--out', out, '--quiet')
    expect(renamed.status).toBe(1)
    expect(renamed.stdout).toMatch(/Rules: 1 fixed, 1 rule now matching nothing\n {2}✗ pages-not-server \(error\): to src\/server\/\*\* matches no file, so the rule checks nothing there/)
  })
})

describe('config', () => {
  it('defaults to one target and the standard test globs', () => {
    const c = loadConfig(path.join(FIXTURES, 'plain-ts'))
    expect(c.targets).toBeUndefined()
    expect(c.tests).toContain('tests/**')
    expect(c.maxSitesPerEdge).toBe(20)
  })
})
