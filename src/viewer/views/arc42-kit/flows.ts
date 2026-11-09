// arc42 kit: dots that travel along paths, showing which way something flows
// (requests into the system, calls down a sequence, data to a store). One
// instanced mesh for all of them; painted by tone and owner like a Drawing.
// With reduced motion they stand still, spread along their paths.
import * as THREE from 'three'
import type { V3 } from './sketch.ts'

export interface FlowPath {
  /** World points, first to last (sample curves finely enough to look round). */
  points: readonly V3[]
  tone: string
  owner?: number
  /** World units per second (default 12). */
  speed?: number
  /** Distance between dots (default 6). */
  spacing?: number
  /** Dot radius (default 0.35). */
  size?: number
}

/** At most this many dots in all: beyond it, spacing grows. */
const MAX_DOTS = 6000
const DOT = new THREE.SphereGeometry(1, 10, 8)

interface Track {
  points: THREE.Vector3[]
  /** Distance from the start to each point. */
  at: number[]
  length: number
  speed: number
  dots: number
  first: number
}

export class Flows {
  readonly object: THREE.InstancedMesh
  private readonly material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
  private readonly tracks: Track[] = []
  private readonly paths: readonly FlowPath[]
  private readonly still: boolean
  private readonly m = new THREE.Matrix4()
  private readonly p = new THREE.Vector3()
  private readonly q = new THREE.Quaternion()
  private readonly s = new THREE.Vector3()

  constructor(paths: readonly FlowPath[], o: { still?: boolean } = {}) {
    this.paths = paths
    this.still = o.still ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    const lengths = paths.map(p => pathLength(p.points))
    const wanted = paths.reduce((n, p, i) => n + Math.max(1, Math.floor(lengths[i] / (p.spacing ?? 6))), 0)
    const stretch = Math.max(1, wanted / MAX_DOTS)
    let count = 0
    paths.forEach((path, i) => {
      const points = path.points.map(p => new THREE.Vector3(...p))
      const at = [0]
      for (let k = 1; k < points.length; k++) at.push(at[k - 1] + points[k].distanceTo(points[k - 1]))
      const dots = Math.max(1, Math.floor(lengths[i] / ((path.spacing ?? 6) * stretch)))
      this.tracks.push({ points, at, length: lengths[i], speed: path.speed ?? 12, dots, first: count })
      count += dots
    })
    this.object = new THREE.InstancedMesh(DOT, this.material, Math.max(1, count))
    this.object.count = count
    this.object.renderOrder = 2
    this.object.frustumCulled = false
    this.place(0)
  }

  /** Color each path's dots by its tone and owner. */
  paint(color: (tone: string, owner: number) => THREE.Color) {
    this.tracks.forEach((t, i) => {
      const c = color(this.paths[i].tone, this.paths[i].owner ?? -1)
      for (let k = 0; k < t.dots; k++) this.object.setColorAt(t.first + k, c)
    })
    if (this.object.instanceColor) this.object.instanceColor.needsUpdate = true
  }

  /** Move the dots to where they are at `time` (ms); true while they move. */
  animate(time: number): boolean {
    if (this.still) return false
    this.place(time / 1000)
    return this.tracks.length > 0
  }

  setOpacity(k: number) {
    this.material.opacity = k
  }

  stats() {
    return { flows: this.tracks.length, dots: this.object.count }
  }

  dispose() {
    this.object.dispose()
    this.material.dispose()
  }

  private place(seconds: number) {
    this.tracks.forEach((t, i) => {
      const size = this.paths[i].size ?? 0.35
      for (let k = 0; k < t.dots; k++) {
        const d = t.length ? (((k / t.dots) * t.length + seconds * t.speed) % t.length + t.length) % t.length : 0
        pointAt(t, d, this.p)
        this.object.setMatrixAt(t.first + k, this.m.compose(this.p, this.q, this.s.setScalar(size)))
      }
    })
    this.object.instanceMatrix.needsUpdate = true
  }
}

function pathLength(points: readonly V3[]) {
  let n = 0
  for (let k = 1; k < points.length; k++) n += Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1], points[k][2] - points[k - 1][2])
  return n
}

/** The point `d` along a track (binary search over its distances). */
function pointAt(t: Track, d: number, out: THREE.Vector3) {
  if (t.points.length === 1) return out.copy(t.points[0])
  let lo = 0
  let hi = t.at.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (t.at[mid] <= d) lo = mid
    else hi = mid
  }
  const span = t.at[hi] - t.at[lo] || 1
  return out.copy(t.points[lo]).lerp(t.points[hi], (d - t.at[lo]) / span)
}
