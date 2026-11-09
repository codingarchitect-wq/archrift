// §3 Context view, part 4: a small solid per kind of neighbor, so the diagram
// reads at a glance: a person, a database drum, a service block, a screen for
// the desktop OS, a stack of sheets for files, a clock for the scheduler, a
// ring for monitoring, a laptop for API clients, a hexagonal prism for other
// programs. About ICON_H tall and 2·ICON wide, standing at (x, base, z),
// facing the camera. Tones: `body:<side>` for the body, `top:<side>` for its
// lighter faces, `paper` and `ink` for details.
import * as THREE from 'three'
import { GROUND } from '../arc42-kit/sketch.ts'
import type { Sketch } from '../arc42-kit/sketch.ts'
import type { NeighborKind, Side } from './catalog.ts'

export function drawIcon(sk: Sketch, kind: NeighborKind, side: Side, owner: number, x: number, base: number, z: number) {
  const body = { tone: `body:${side}`, owner }
  const top = { tone: `top:${side}`, owner }
  const paper = { tone: 'paper', owner }
  const ink = { tone: 'ink', owner }
  const at = (dx: number, y: number, dz: number) => new THREE.Matrix4().makeTranslation(x + dx, base + y, z + dz)
  const solid = (paint: { tone: string; owner: number }, g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    sk.solid(paint, g, m)
    g.dispose()
  }
  switch (kind) {
    case 'person': {
      solid(body, new THREE.CylinderGeometry(1.15, 2.7, 4.1, 28), at(0, 2.05, 0))
      solid(top, new THREE.SphereGeometry(1.45, 24, 16), at(0, 5.55, 0))
      return
    }
    case 'clients': {
      // a laptop: a keyboard deck and a screen leaning back
      sk.slab(body, GROUND, { u: x, v: z + 0.6, w: 6.4, h: 4.2 }, { r: 0.5, lift: base, height: 0.5, top: `top:${side}` })
      const screen = new THREE.BoxGeometry(6.4, 4.4, 0.4).translate(0, 2.2, 0)
      solid(body, screen, at(0, 0.5, -1.4).multiply(new THREE.Matrix4().makeRotationX(-0.22)))
      solid(paper, new THREE.PlaneGeometry(5.4, 3.4).translate(0, 2.3, 0.21), at(0, 0.5, -1.4).multiply(new THREE.Matrix4().makeRotationX(-0.22)))
      return
    }
    case 'monitor': {
      // a ring on a post, a beat in the middle
      solid(body, new THREE.CylinderGeometry(0.35, 0.35, 2.2, 12), at(0, 1.1, 0))
      solid(top, new THREE.TorusGeometry(2.3, 0.5, 14, 40), at(0, 4.4, 0))
      solid(ink, new THREE.SphereGeometry(0.7, 16, 12), at(0, 4.4, 0))
      solid(body, new THREE.CylinderGeometry(2, 2.2, 0.4, 28), at(0, 0.2, 0))
      return
    }
    case 'scheduler': {
      // a clock face on a foot
      const face = new THREE.Matrix4().makeRotationX(Math.PI / 2)
      solid(body, new THREE.CylinderGeometry(2.9, 2.9, 0.9, 40), at(0, 3.4, 0).multiply(face))
      solid(paper, new THREE.CylinderGeometry(2.45, 2.45, 0.1, 40), at(0, 3.4, 0.46).multiply(face))
      solid(ink, new THREE.BoxGeometry(0.28, 1.9, 0.12).translate(0, 0.85, 0), at(0, 3.4, 0.56))
      solid(ink, new THREE.BoxGeometry(0.28, 1.4, 0.12).translate(0, 0.6, 0), at(0, 3.4, 0.56).multiply(new THREE.Matrix4().makeRotationZ(-2.1)))
      solid(body, new THREE.BoxGeometry(2.6, 0.5, 1.6), at(0, 0.25, 0))
      return
    }
    case 'service': {
      sk.slab(body, GROUND, { u: x, v: z, w: 6.6, h: 6.6 }, { r: 1.3, lift: base, height: 4.6, top: `top:${side}` })
      // a badge on the front: something you call
      sk.slab(paper, GROUND, { u: x, v: z + 3.35, w: 3.6, h: 0.2 }, { r: 0.1, lift: base + 1.4, height: 1.9 })
      return
    }
    case 'database':
    case 'browser-db': {
      const r = kind === 'database' ? 3 : 2.5
      const h = kind === 'database' ? 5.6 : 4.4
      solid(body, new THREE.CylinderGeometry(r, r, h, 40), at(0, h / 2, 0))
      solid(top, new THREE.CylinderGeometry(r * 0.999, r * 0.999, 0.12, 40), at(0, h + 0.06, 0))
      // the drum's bands
      for (const k of kind === 'database' ? [1 / 3, 2 / 3] : [1 / 2]) solid(top, new THREE.TorusGeometry(r + 0.02, 0.13, 8, 48).rotateX(Math.PI / 2), at(0, h * k, 0))
      return
    }
    case 'desktop': {
      solid(body, new THREE.BoxGeometry(7.4, 4.8, 0.55), at(0, 3.9, 0))
      solid(paper, new THREE.PlaneGeometry(6.6, 4), at(0, 3.9, 0.28))
      solid(body, new THREE.CylinderGeometry(0.35, 0.45, 1.6, 12), at(0, 0.8, -0.1))
      solid(top, new THREE.BoxGeometry(3.4, 0.3, 2), at(0, 0.15, -0.1))
      return
    }
    case 'files': {
      // a few sheets, each a little turned
      for (let k = 0; k < 3; k++) {
        const g = new THREE.BoxGeometry(5.6, 0.42, 4.4).translate(0, 0.21, 0)
        solid(k === 2 ? paper : body, g, at(0.25 * (k - 1), k * 0.55, -0.2 * k).multiply(new THREE.Matrix4().makeRotationY((k - 1) * 0.12)))
      }
      solid(top, new THREE.BoxGeometry(2.6, 0.04, 0.25), at(-0.6, 1.53, -0.1))
      solid(top, new THREE.BoxGeometry(3.6, 0.04, 0.25), at(-0.1, 1.53, 0.6))
      return
    }
    case 'processes': {
      solid(body, new THREE.CylinderGeometry(3, 3, 3, 6), at(0, 1.5, 0))
      solid(top, new THREE.CylinderGeometry(1.7, 1.7, 2.2, 6), at(0, 4.1, 0))
      return
    }
  }
}
