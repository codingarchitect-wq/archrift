import './setup'
import { makeCircle, roundTo } from './index'
import { clamp, parse } from './util'

export async function main() {
  const c = makeCircle({ x: 1, y: 2 }, clamp(parse('3'), 0, 10))
  const lazy = await import('./lazy')
  lazy.load(c.describe())
  return roundTo(c.area())
}
