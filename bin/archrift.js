#!/usr/bin/env node
// The `archrift` command. A checkout runs its TypeScript source as it is (Node strips
// the types; `npm link` leaves the checkout outside node_modules), so an edit counts at
// the next call. The package from npm runs the built lib/ instead: Node won't strip
// types under node_modules, and the package carries no src/.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = new URL('../src/cli/main.ts', import.meta.url)
const checkout = fs.existsSync(source) && !fileURLToPath(source).split(/[\\/]/).includes('node_modules')
await import(checkout ? source : new URL('../lib/cli/main.js', import.meta.url))
