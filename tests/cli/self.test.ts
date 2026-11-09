// How archrift says to run itself: the way it was started (the PATH, npx, or its entry file).
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENTRY, invokedAs, shellPath } from '../../src/cli/self.ts'

describe('the command archrift was started with', () => {
  it('is `archrift` from a folder on the PATH (npm link, npm i -g)', () => {
    expect(invokedAs('/opt/homebrew/bin/archrift', ['/usr/bin', '/opt/homebrew/bin'].join(path.delimiter))).toBe('archrift')
  })

  it("is `npx archrift` from a project's node_modules/.bin", () => {
    expect(invokedAs('/work/app/node_modules/.bin/archrift', '/usr/bin')).toBe('npx archrift')
  })

  it('is `node <entry>` otherwise, its path short under the home folder', () => {
    expect(invokedAs('/tmp/elsewhere/archrift', '/usr/bin')).toBe(`node ${shellPath(ENTRY)}`)
    expect(invokedAs(ENTRY, '/usr/bin')).toBe(`node ${shellPath(ENTRY)}`)
    expect(shellPath(path.join(os.homedir(), 'src/archrift/src/cli/main.ts'))).toBe('~/src/archrift/src/cli/main.ts')
    expect(shellPath('/with space/main.ts', '/home/ada')).toBe('"/with space/main.ts"')
  })

  it("is this checkout's src/cli/main.ts here", () => {
    expect(ENTRY).toBe(path.resolve(import.meta.dirname, '../../src/cli/main.ts'))
  })
})
