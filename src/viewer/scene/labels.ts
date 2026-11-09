// Screen-space labels: DOM elements over the canvas, placed by
// priority with greedy collision culling, re-placed after every render. Crisp
// text at any zoom, and cheap for the ~150 labels ever shown at once.
import * as THREE from 'three'

export interface LabelSpec {
  id: string
  text: string
  priority: number
  className?: string
  /** Hide when the anchor's box is narrower than this on screen (districts). */
  minScreenWidth?: number
  /** Hide when the anchor's box is wider than this on screen (a name the scene itself writes legibly once close enough). */
  maxScreenWidth?: number
  /** Its width in pixels, for a label in a bigger font than the usual (otherwise guessed from its length). */
  width?: number
  /** `start`: the label begins at its anchor instead of centering on it (and keeps others clear there). */
  align?: 'start'
}

export interface Anchor {
  point: THREE.Vector3
  /** World-space width, for minScreenWidth. */
  width?: number
}

/**
 * A folder label's priority, where labels that overlap keep the higher: groups first, then folders
 * with a name written for them (described names on), then the rest; shallower before deeper within
 * each. A written name wins against the folders around it that have none: in the layers view `src`
 * stands on every plane right where its main block's label goes (src/components: "UI components").
 */
export function folderPriority(depth: number, kind: 'group' | 'named' | 'plain'): number {
  return kind === 'group' ? 450 : kind === 'named' ? 445 - depth * 10 : 400 - depth * 60
}

const MAX_LABELS = 150
const CHAR_W = 7
const LABEL_H = 18

export class LabelLayer {
  private readonly container: HTMLElement
  private specs: LabelSpec[] = []
  private readonly pool: HTMLDivElement[] = []
  private readonly v = new THREE.Vector3()
  private readonly v2 = new THREE.Vector3()

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div')
    this.container.className = 'labels'
    parent.appendChild(this.container)
  }

  setSpecs(specs: LabelSpec[]) {
    this.specs = [...specs].sort((a, b) => b.priority - a.priority)
  }

  update(camera: THREE.Camera, width: number, height: number, anchorOf: (id: string) => Anchor | undefined) {
    const placed: { x: number; y: number; w: number }[] = []
    let used = 0
    for (const spec of this.specs) {
      if (used >= MAX_LABELS) break
      const anchor = anchorOf(spec.id)
      if (!anchor) continue
      this.v.copy(anchor.point).project(camera)
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) continue
      const x = ((this.v.x + 1) / 2) * width
      const y = ((1 - this.v.y) / 2) * height
      if ((spec.minScreenWidth || spec.maxScreenWidth) && anchor.width !== undefined) {
        this.v2.copy(anchor.point).setX(anchor.point.x + anchor.width).project(camera)
        const screenWidth = Math.abs(((this.v2.x + 1) / 2) * width - x)
        if (screenWidth < (spec.minScreenWidth ?? 0) || screenWidth > (spec.maxScreenWidth ?? Infinity)) continue
      }
      const w = spec.width ?? spec.text.length * CHAR_W + 12
      // the middle of the box it takes
      const mid = spec.align === 'start' ? x + w / 2 : x
      if (placed.some(p => Math.abs(p.x - mid) < (p.w + w) / 2 && Math.abs(p.y - y) < LABEL_H)) continue
      placed.push({ x: mid, y, w })
      const el = this.element(used++)
      if (el.textContent !== spec.text) el.textContent = spec.text
      const cls = `label ${spec.className ?? ''}`
      if (el.className !== cls) el.className = cls
      el.style.transform = `translate(${Math.round(mid - w / 2)}px, ${Math.round(y - LABEL_H)}px)`
      el.style.display = ''
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].style.display = 'none'
  }

  private element(i: number) {
    let el = this.pool[i]
    if (!el) {
      el = document.createElement('div')
      this.container.appendChild(el)
      this.pool[i] = el
    }
    return el
  }
}
