// What a view can add to the scene beyond boxes and arcs (a view plug-in's
// own 3D content: rain, a terrain surface, branches, subway lines). The engine
// adds its object while the view is shown, animates it, asks it first what the
// pointer is over, and disposes of it when the view changes.
import type * as THREE from 'three'
import type { HitKind } from './engine.ts'

export interface DecorationHit {
  id: string
  kind: HitKind
}

export interface Decoration {
  /** Added to the scene while the view is shown. */
  readonly object: THREE.Object3D
  /** Called every frame while it returns true (keep returning true to animate continuously). */
  animate?(time: number): boolean
  /**
   * What the pointer is over, when the decoration draws it: a hit, `null` for
   * "something of mine that isn't a node" (stops the search), or undefined to
   * let the engine look at its boxes.
   */
  pick?(raycaster: THREE.Raycaster): DecorationHit | null | undefined
  /** Counts for tests and debugging (window.__archrift.scene().decoration). */
  stats?(): Record<string, number>
  dispose(): void
}
