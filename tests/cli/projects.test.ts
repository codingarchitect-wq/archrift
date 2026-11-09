import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOME_DIR, ProjectList, defaultOut, expandPath, homeDir } from '../../src/cli/projects.ts'
import { FIXTURES } from '../helpers/fixtures.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const listIn = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-projects-'))
  dirs.push(d)
  return new ProjectList(path.join(d, 'projects.json'))
}

describe("archrift's home folder", () => {
  it('is ~/.config/archrift, or under $XDG_CONFIG_HOME, or ARCHRIFT_HOME', () => {
    expect(homeDir({}, '/home/ada')).toBe('/home/ada/.config/archrift')
    expect(homeDir({ XDG_CONFIG_HOME: '/cfg' }, '/home/ada')).toBe('/cfg/archrift')
    expect(homeDir({ XDG_CONFIG_HOME: '/cfg', ARCHRIFT_HOME: '/elsewhere/ar' }, '/home/ada')).toBe('/elsewhere/ar')
  })

  it('holds the project list by default', () => {
    expect(new ProjectList().file).toBe(path.join(HOME_DIR, 'projects.json'))
  })
})

describe('the project list', () => {
  it("names a folder after itself and puts its outputs in archrift's home folder, under projects/", () => {
    const list = listIn()
    const p = list.add({ root: path.join(FIXTURES, 'plain-ts') })
    expect(p).toMatchObject({
      name: 'plain-ts',
      root: path.join(FIXTURES, 'plain-ts'),
      out: path.join(HOME_DIR, 'projects', 'plain-ts', 'graph.json'),
      views: path.join(HOME_DIR, 'projects', 'plain-ts', 'views'),
      snapshots: path.join(HOME_DIR, 'projects', 'plain-ts', 'snapshots'),
      cache: path.join(HOME_DIR, 'projects', 'plain-ts', 'cache'),
    })
    expect(list.active()?.name).toBe('plain-ts') // the only one
  })

  it('puts the outputs of a project with its config in .archrift/ there, beside it (as init sets it up)', () => {
    const list = listIn()
    const p = list.add({ root: path.join(FIXTURES, 'fullstack') })
    const own = path.join(FIXTURES, 'fullstack', '.archrift')
    expect(p).toMatchObject({ config: undefined, out: path.join(own, 'graph.json'), views: path.join(own, 'views'), snapshots: path.join(own, 'snapshots'), cache: path.join(own, 'cache') })
    expect(defaultOut('fullstack', path.join(FIXTURES, 'fullstack'))).toBe(path.join(own, 'graph.json'))
    expect(defaultOut('plain-ts', path.join(FIXTURES, 'plain-ts'))).toBe(path.join(HOME_DIR, 'projects', 'plain-ts', 'graph.json'))
  })

  it('updates the entry for a folder it has, and keeps names unique', () => {
    const list = listIn()
    const out = path.join(os.tmpdir(), 'x', 'graph.json')
    list.add({ root: path.join(FIXTURES, 'plain-ts') })
    const again = list.add({ root: path.join(FIXTURES, 'plain-ts'), out })
    expect(again).toMatchObject({ name: 'plain-ts', out, views: path.join(os.tmpdir(), 'x', 'views') })
    expect(list.all()).toHaveLength(1)
    expect(list.add({ root: path.join(FIXTURES, 'fullstack'), name: 'plain-ts' }).name).toBe('plain-ts-2')
  })

  it('remembers the project opened last, and forgets removed ones', () => {
    const list = listIn()
    list.add({ root: path.join(FIXTURES, 'plain-ts') })
    list.add({ root: path.join(FIXTURES, 'fullstack') })
    list.setActive('fullstack')
    expect(new ProjectList(list.file).active()?.name).toBe('fullstack')
    list.remove('fullstack')
    expect(list.all().map(p => p.name)).toEqual(['plain-ts'])
    expect(list.active()?.name).toBe('plain-ts')
    expect(() => list.remove('nope')).toThrow(/no project named nope/)
  })

  it('refuses what is not a folder, or a config that is not there', () => {
    const list = listIn()
    expect(() => list.add({ root: path.join(FIXTURES, 'nowhere') })).toThrow(/not a folder/)
    expect(() => list.add({ root: path.join(FIXTURES, 'plain-ts', 'src', 'app.ts') })).toThrow(/not a folder/)
    expect(() => list.add({ root: path.join(FIXTURES, 'plain-ts'), config: '/no/such/config.json' })).toThrow(/config not found/)
  })

  it('reads paths edited by hand relative to the file, and ~ as home', () => {
    const list = listIn()
    fs.writeFileSync(list.file, JSON.stringify({ projects: [{ name: 'here', root: '.', out: 'o/graph.json' }] }))
    const [p] = list.all()
    expect(p.root).toBe(path.dirname(list.file))
    expect(p.out).toBe(path.join(path.dirname(list.file), 'o', 'graph.json'))
    expect(expandPath('~/src')).toBe(path.join(os.homedir(), 'src'))
  })

  it('starts empty without a file, and survives a broken one', () => {
    const list = listIn()
    expect(list.all()).toEqual([])
    fs.writeFileSync(list.file, '{ not json')
    expect(list.all()).toEqual([])
    expect(list.active()).toBeUndefined()
  })
})
