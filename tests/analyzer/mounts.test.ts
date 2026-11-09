import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles } from '../../src/analyzer/files.ts'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import { absPathOf, relPathOf, resolveMounts } from '../../src/analyzer/mounts.ts'

function tree(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-mounts-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

describe('mounts', () => {
  const root = tree({ 'src/a.ts': '', 'node_modules/x/index.js': '', 'build/out.js': '' })
  const other = tree({ 'k8s/kafka.yaml': 'a: 1\n', 'scripts/up.sh': '', '.git/HEAD': '' })

  it('maps graph paths under a mount to its folder and back', () => {
    const mounts = resolveMounts(root, { infra: other })
    expect(absPathOf(root, mounts, 'infra/k8s/kafka.yaml')).toBe(path.join(other, 'k8s/kafka.yaml'))
    expect(absPathOf(root, mounts, 'src/a.ts')).toBe(path.join(root, 'src/a.ts'))
    expect(absPathOf(root, { infra: other }, 'infra/scripts/up.sh')).toBe(path.join(other, 'scripts/up.sh'))
    expect(relPathOf(root, mounts, path.join(other, 'k8s/kafka.yaml'))).toBe('infra/k8s/kafka.yaml')
    expect(relPathOf(root, mounts, path.join(root, 'src/a.ts'))).toBe('src/a.ts')
    expect(relPathOf(root, mounts, path.join(os.tmpdir(), 'elsewhere.ts'))).toMatch(/^\.\./)
  })

  it('refuses a mount that is missing or that a folder of the root would shadow', () => {
    expect(() => resolveMounts(root, { infra: path.join(other, 'nope') })).toThrow(/no folder/)
    expect(() => resolveMounts(root, { src: other })).toThrow(/has a src of its own/)
  })

  it('lists the files of the root and the mounts, without the excluded ones', () => {
    const mounts = resolveMounts(root, { infra: other })
    expect(listFiles(root, mounts, ConfigSchema.parse({}))).toEqual(['infra/k8s/kafka.yaml', 'infra/scripts/up.sh', 'src/a.ts'])
    expect(listFiles(root, mounts, ConfigSchema.parse({ exclude: ['infra/scripts/**'] }))).toEqual(['infra/k8s/kafka.yaml', 'src/a.ts'])
  })
})
