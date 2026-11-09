import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { locate, rootRelative } from '../../src/cli/query.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A project list with an app and, inside it, a package of its own. */
function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-locate-')))
  dirs.push(base)
  const app = path.join(base, 'app')
  const pkg = path.join(app, 'packages', 'ui')
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
  const projects = path.join(base, 'projects.json')
  fs.writeFileSync(
    projects,
    JSON.stringify({
      projects: [
        { name: 'app', root: app, config: path.join(base, 'app.json'), out: path.join(base, 'out', 'app', 'graph.json') },
        { name: 'ui', root: pkg },
      ],
    }),
  )
  return { base, app, pkg, projects }
}

describe('which project a query is about', () => {
  it('the listed project the current folder is in, the innermost one, with its config and output', () => {
    const { base, app, pkg, projects } = setup()
    expect(locate({ cwd: path.join(app, 'src'), projects })).toEqual({
      root: app,
      config: path.join(base, 'app.json'),
      out: path.join(base, 'out', 'app', 'graph.json'),
      views: path.join(base, 'out', 'app', 'views'),
    })
    expect(locate({ cwd: path.join(pkg, 'src'), projects }).root).toBe(pkg)
  })

  it('a project named, or a root given (with its own config), else the current folder', () => {
    const { base, app, projects } = setup()
    expect(locate({ cwd: base, project: 'app', projects }).root).toBe(app)
    expect(() => locate({ cwd: base, project: 'nope', projects })).toThrow(/no project named nope/)
    expect(locate({ cwd: base, root: 'elsewhere', config: 'c.json', projects })).toEqual({ root: path.join(base, 'elsewhere'), config: 'c.json', out: undefined })
    expect(locate({ cwd: base, projects })).toEqual({ root: base, config: undefined, out: undefined })
  })

  it('outside the list, the nearest folder up with its own .archrift/config.json: a worktree of a project set up by init', () => {
    const { base, projects } = setup()
    const worktree = path.join(base, 'worktrees', 'fix', 'app')
    fs.mkdirSync(path.join(worktree, '.archrift'), { recursive: true })
    fs.mkdirSync(path.join(worktree, 'src', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(worktree, '.archrift', 'config.json'), '{}')
    expect(locate({ cwd: path.join(worktree, 'src', 'lib'), projects })).toEqual({ root: worktree, config: undefined, out: undefined })
  })
})

describe('paths on the command line', () => {
  const root = '/repo'
  const known = new Set(['src/app/page.tsx', 'src/app'])
  const exists = (p: string) => known.has(p)

  it('are read from the current folder when they name something from there, else from the root', () => {
    expect(rootRelative('page.tsx', root, '/repo/src/app', exists)).toBe('src/app/page.tsx')
    expect(rootRelative('src/app', root, '/repo/src', exists)).toBe('src/app')
    expect(rootRelative('./src/app', root, root, exists)).toBe('src/app')
    expect(rootRelative('s:src/a.ts#x', root, '/repo/src', exists)).toBe('s:src/a.ts#x')
  })
})
