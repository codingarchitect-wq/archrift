import { a } from './cycle-a'

export function b(): number {
  return typeof a === 'function' ? 0 : 1
}
