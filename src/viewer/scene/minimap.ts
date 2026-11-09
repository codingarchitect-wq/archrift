// Top-down minimap: the layout's footprint, colored like the
// scene, with the part of the ground the camera sees. Clicking pans there.
import * as THREE from 'three'
import type { Box } from '../layouts/types.ts'
import type { HitKind } from './engine.ts'

const SIZE = 168

export class Minimap {
  onPick?: (x: number, z: number) => void
  private readonly canvas: HTMLCanvasElement
  private readonly base: HTMLCanvasElement
  private scale = 1
  private cx = 0
  private cz = 0
  private readonly ray = new THREE.Raycaster()

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'minimap'
    this.canvas.setAttribute('aria-label', 'Minimap: click to move there')
    this.canvas.setAttribute('role', 'img')
    const dpr = Math.min(devicePixelRatio, 2)
    for (const c of [this.canvas, (this.base = document.createElement('canvas'))]) {
      c.width = c.height = SIZE * dpr
      c.style.width = c.style.height = `${SIZE}px`
    }
    parent.appendChild(this.canvas)
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect()
      const x = (e.clientX - r.left - SIZE / 2) / this.scale + this.cx
      const z = (e.clientY - r.top - SIZE / 2) / this.scale + this.cz
      this.onPick?.(x, z)
    })
  }

  /** Redraw the footprint (after a layout or color change). */
  drawBase(boxes: Map<string, Box>, kindOf: Map<string, HitKind>, colorOf: (id: string) => THREE.Color, size: number, center: [number, number, number], background: string) {
    const dpr = this.base.width / SIZE
    this.scale = (SIZE - 12) / (size * 1.05)
    this.cx = center[0]
    this.cz = center[2]
    const g = this.base.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = background
    g.fillRect(0, 0, SIZE, SIZE)
    const toX = (x: number) => SIZE / 2 + (x - this.cx) * this.scale
    const toY = (z: number) => SIZE / 2 + (z - this.cz) * this.scale
    // platforms first, then what stands on them, lowest first
    const order = [...boxes].filter(([id]) => kindOf.get(id) !== 'cluster').sort((a, b) => rank(kindOf.get(a[0])) - rank(kindOf.get(b[0])) || a[1].y - b[1].y)
    for (const [id, b] of order) {
      const kind = kindOf.get(id)
      g.fillStyle = `#${colorOf(id).getHexString()}`
      g.globalAlpha = kind === 'plane' ? 0.35 : 1
      const w = Math.max(b.w * this.scale, 1)
      const d = Math.max(b.d * this.scale, 1)
      g.fillRect(toX(b.x) - w / 2, toY(b.z) - d / 2, w, d)
    }
    g.globalAlpha = 1
  }

  /** Copy the footprint and draw what the camera sees on top. */
  drawView(camera: THREE.PerspectiveCamera, target: THREE.Vector3, accent: string) {
    const dpr = this.canvas.width / SIZE
    const g = this.canvas.getContext('2d')!
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.drawImage(this.base, 0, 0)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -target.y)
    const hit = new THREE.Vector3()
    const corners: [number, number][] = []
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      this.ray.setFromCamera(new THREE.Vector2(x, y), camera)
      if (this.ray.ray.intersectPlane(plane, hit)) corners.push([hit.x, hit.z])
      else {
        // looking above the horizon: clamp the corner far along the view direction
        const far = this.ray.ray.at(camera.far * 0.2, new THREE.Vector3())
        corners.push([far.x, far.z])
      }
    }
    const toX = (x: number) => SIZE / 2 + (x - this.cx) * this.scale
    const toY = (z: number) => SIZE / 2 + (z - this.cz) * this.scale
    g.beginPath()
    corners.forEach(([x, z], i) => (i ? g.lineTo(toX(x), toY(z)) : g.moveTo(toX(x), toY(z))))
    g.closePath()
    g.fillStyle = hexAlpha(accent, 0.12)
    g.fill()
    g.strokeStyle = accent
    g.lineWidth = 1.2
    g.stroke()
    g.beginPath()
    g.arc(toX(target.x), toY(target.z), 2.5, 0, Math.PI * 2)
    g.fillStyle = accent
    g.fill()
  }

  setVisible(visible: boolean) {
    this.canvas.style.display = visible ? '' : 'none'
  }
}

const rank = (k: HitKind | undefined) => (k === 'plane' ? 0 : k === 'district' ? 1 : 2)

function hexAlpha(color: string, alpha: number) {
  const c = new THREE.Color(color)
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${alpha})`
}
