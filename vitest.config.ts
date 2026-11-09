import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    // archrift's home folder (the project list, results of projects without a .archrift/), never the user's ~/.config
    env: { ARCHRIFT_HOME: path.resolve(import.meta.dirname, 'out/test-home') },
  },
})
