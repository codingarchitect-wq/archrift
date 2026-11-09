import type { Point, Shape } from './types'
import { Color } from '@/types'
import { round } from './util'

export abstract class Base implements Shape {
  abstract area(): number
  get name() {
    return 'base'
  }
  describe(): string {
    return `${this.name}: ${round(this.area())}`
  }
}

export class Circle extends Base {
  radius: number
  color = Color.red
  constructor(radius: number) {
    super()
    this.radius = radius
  }
  area() {
    return Math.PI * this.radius ** 2
  }
  override get name() {
    return 'circle'
  }
}

export function makeCircle(center: Point, r = 1): Circle {
  if (r < 0 || center.x < 0) throw new Error('negative')
  return new Circle(r)
}
