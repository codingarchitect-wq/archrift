import { add, PI } from './lib/math.js'
import legacy from './lib/legacy.cjs'
import fs from 'node:fs'
import chalk from 'chalk'

console.log(add(PI, 1), legacy.twice(2), fs.existsSync('.'), chalk)
