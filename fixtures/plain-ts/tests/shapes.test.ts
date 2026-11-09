import { makeCircle } from '../src/shapes'
import { onlyTested } from '../src/util'

declare function expect(v: unknown): { toBe(x: unknown): void }
expect(makeCircle({ x: 0, y: 0 }).area()).toBe(Math.PI)
expect(onlyTested()).toBe(true)
