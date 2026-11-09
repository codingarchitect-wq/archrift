// Diagram kit: crisp text lying on a diagram's surface, as many rows as the
// cards need (the screen-space labels stop at 150). Glyphs are drawn once
// into a shared atlas as distance fields (sdf.ts), so one 2048² texture keeps
// text sharp from far away to close up; every glyph is one instance of a quad
// in a single mesh, so a few hundred cards of rows are one draw call. Like a
// Sketch's Drawing, each run has a tone and an owner and is painted again on
// every theme or selection change without being rebuilt. Text too small on
// screen to read fades out instead of shimmering.
import * as THREE from 'three'
import type { Surface } from '../arc42-kit/sketch.ts'
import { CSS_FONT } from './metrics.ts'
import type { FontName } from './metrics.ts'
import { distanceField } from './sdf.ts'

/** Icons drawn into the atlas like glyphs: a key for a primary key. */
export const ICON = { key: '' } as const

const SIZE = 2048
/** The em in atlas pixels, and the room around each glyph for its field. */
const PX = 40
const BUFFER = 8
const RADIUS = 8
const ASCENT = Math.round(PX * 0.96)
const DESCENT = Math.round(PX * 0.3)
/** A cell's height: every glyph of every font has the same, so a shelf holds any of them. */
const CELL_H = ASCENT + DESCENT + 2 * BUFFER

interface Glyph {
  /** Texture coordinates of its cell: left, top, right, bottom. */
  uv: [number, number, number, number]
  /** Its cell's width and its advance, in atlas pixels. */
  w: number
  advance: number
}

/** One atlas for every diagram: glyphs are added as texts need them and stay. */
class Atlas {
  readonly texture: THREE.DataTexture
  private readonly data = new Uint8Array(SIZE * SIZE)
  private readonly glyphs = new Map<string, Glyph>()
  private readonly canvas = document.createElement('canvas')
  private readonly g: CanvasRenderingContext2D
  private x = 0
  private y = 0
  private dirty = false
  private full = false

  constructor() {
    this.canvas.width = 4 * PX
    this.canvas.height = CELL_H
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!
    this.texture = new THREE.DataTexture(this.data, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType)
    this.texture.minFilter = THREE.LinearMipmapLinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = true
    this.texture.unpackAlignment = 1
    this.texture.needsUpdate = true
  }

  glyph(font: FontName, ch: string): Glyph {
    const key = `${font}\u0000${ch}`
    let glyph = this.glyphs.get(key)
    if (!glyph) this.glyphs.set(key, (glyph = this.draw(font, ch)))
    return glyph
  }

  /** Upload what was added since the last time. */
  flush() {
    if (!this.dirty) return
    this.texture.needsUpdate = true
    this.dirty = false
  }

  private draw(font: FontName, ch: string): Glyph {
    const g = this.g
    g.font = CSS_FONT[font](PX)
    const advance = ch === ICON.key ? PX : g.measureText(ch).width
    const w = Math.min(this.canvas.width, Math.ceil(advance) + 2 * BUFFER)
    if (this.x + w > SIZE) {
      this.x = 0
      this.y += CELL_H
    }
    if (this.y + CELL_H > SIZE) return this.overflow(advance)
    g.clearRect(0, 0, this.canvas.width, CELL_H)
    g.fillStyle = g.strokeStyle = '#000'
    if (ch === ICON.key) drawKey(g, BUFFER, BUFFER + ASCENT)
    else g.fillText(ch, BUFFER, BUFFER + ASCENT)
    const pixels = g.getImageData(0, 0, w, CELL_H).data
    const alpha = new Uint8Array(w * CELL_H)
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]
    const field = distanceField(alpha, w, CELL_H, RADIUS)
    for (let row = 0; row < CELL_H; row++) this.data.set(field.subarray(row * w, (row + 1) * w), (this.y + row) * SIZE + this.x)
    const glyph: Glyph = { uv: [this.x / SIZE, this.y / SIZE, (this.x + w) / SIZE, (this.y + CELL_H) / SIZE], w, advance }
    this.x += w
    this.dirty = true
    return glyph
  }

  /** The atlas is full (thousands of distinct glyphs): further ones advance but draw nothing. */
  private overflow(advance: number): Glyph {
    if (!this.full) console.warn('archrift: the diagram text atlas is full')
    this.full = true
    return { uv: [0, 0, 0, 0], w: 0, advance }
  }
}

/** A key's outline, an em wide, standing on the baseline at (x, y). */
function drawKey(g: CanvasRenderingContext2D, x: number, y: number) {
  const mid = y - PX * 0.36
  g.lineWidth = PX * 0.12
  g.lineCap = 'round'
  g.beginPath()
  g.arc(x + PX * 0.27, mid, PX * 0.19, 0, Math.PI * 2)
  g.moveTo(x + PX * 0.46, mid)
  g.lineTo(x + PX * 0.94, mid)
  g.moveTo(x + PX * 0.78, mid)
  g.lineTo(x + PX * 0.78, mid + PX * 0.2)
  g.moveTo(x + PX * 0.92, mid)
  g.lineTo(x + PX * 0.92, mid + PX * 0.16)
  g.stroke()
}

let shared: Atlas | undefined
const atlas = () => (shared ??= new Atlas())

/** A run of text on a surface. */
export interface TextRun {
  text: string
  font: FontName
  /** The em, in world units. */
  size: number
  /** Where its baseline starts (left), ends (right) or is centered (center). */
  u: number
  v: number
  align?: 'left' | 'right' | 'center'
  /** Shorten it with an ellipsis to fit this width. */
  max?: number
  lift?: number
  tone: string
  /** What it belongs to (painting); -1 or left out: nothing. */
  owner?: number
}

/** Per glyph: its quad on the surface (u, v of the top-left corner, width, height), its cell's texture coordinates, lift, color. */
const VERTEX = /* glsl */ `
  attribute vec4 aRect;
  attribute vec4 aUv;
  attribute float aLift;
  attribute vec3 aColor;
  uniform vec3 uOrigin;
  uniform vec3 uU;
  uniform vec3 uV;
  uniform vec3 uN;
  varying vec2 vUv;
  varying vec2 vLocal;
  varying vec3 vColor;
  #include <fog_pars_vertex>
  void main() {
    vec2 local = position.xy;
    vec3 world = uOrigin + (aRect.x + local.x * aRect.z) * uU + (aRect.y + local.y * aRect.w) * uV + aLift * uN;
    vUv = vec2(mix(aUv.x, aUv.z, local.x), mix(aUv.y, aUv.w, local.y));
    vLocal = local;
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`

/** The field's edge at 0.5, anti-aliased over a pixel; faded out while a cell is fewer than ~6 em pixels high. */
const FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uEm;
  varying vec2 vUv;
  varying vec2 vLocal;
  varying vec3 vColor;
  #include <fog_pars_fragment>
  void main() {
    float d = texture2D(uMap, vUv).r;
    float w = max(fwidth(d) * 0.75, 1e-4);
    float a = smoothstep(0.5 - w, 0.5 + w, d);
    float em = uEm / max(fwidth(vLocal.y), 1e-5);
    a *= smoothstep(3.5, 6.0, em) * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`

const QUAD = (() => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
})()

/** Text runs on one surface, built into one instanced mesh. */
export class TextLayer {
  object: THREE.Mesh = new THREE.Mesh()
  private readonly surface: Surface
  private readonly rects: number[] = []
  private readonly uvs: number[] = []
  private readonly lifts: number[] = []
  private readonly tones: string[] = []
  private readonly owners: number[] = []
  private material: THREE.ShaderMaterial | null = null
  private colors: THREE.InstancedBufferAttribute | null = null

  constructor(surface: Surface) {
    this.surface = surface
  }

  /** How wide a text is in a font at an em, as the glyphs measure. */
  width(text: string, font: FontName, size: number): number {
    let px = 0
    for (const ch of text) px += atlas().glyph(font, ch).advance
    return (px / PX) * size
  }

  /** Add a run; returns how wide it is drawn (after shortening). */
  add(run: TextRun): number {
    const text = run.max === undefined ? run.text : this.fit(run.text, run.font, run.size, run.max)
    const width = this.width(text, run.font, run.size)
    const scale = run.size / PX
    let pen = run.u - (run.align === 'right' ? width : run.align === 'center' ? width / 2 : 0)
    const top = run.v - (BUFFER + ASCENT) * scale
    for (const ch of text) {
      const g = atlas().glyph(run.font, ch)
      if (ch !== ' ' && g.w) this.glyph(g, pen - BUFFER * scale, top, scale, run)
      pen += g.advance * scale
    }
    return width
  }

  build() {
    atlas().flush()
    const count = this.tones.length
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = QUAD.index
    geometry.setAttribute('position', QUAD.getAttribute('position'))
    geometry.setAttribute('aRect', new THREE.InstancedBufferAttribute(new Float32Array(this.rects), 4))
    geometry.setAttribute('aUv', new THREE.InstancedBufferAttribute(new Float32Array(this.uvs), 4))
    geometry.setAttribute('aLift', new THREE.InstancedBufferAttribute(new Float32Array(this.lifts), 1))
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    geometry.setAttribute('aColor', this.colors)
    geometry.instanceCount = count
    const s = this.surface
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uMap: { value: null },
          uOpacity: { value: 1 },
          uEm: { value: PX / CELL_H },
          uOrigin: { value: new THREE.Vector3(...s.origin) },
          uU: { value: new THREE.Vector3(...s.u) },
          uV: { value: new THREE.Vector3(...s.v) },
          uN: { value: new THREE.Vector3(...s.n) },
        },
      ]),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      // over the card it lies on, whatever the distance
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -8,
    })
    this.material.uniforms.uMap.value = atlas().texture
    this.object = new THREE.Mesh(geometry, this.material)
    this.object.frustumCulled = false
    this.object.renderOrder = 3
    this.object.visible = count > 0
    // what the pointer is over is the card under the text
    this.object.raycast = () => {}
  }

  /** Color every glyph by its run's tone and owner. */
  paint(color: (tone: string, owner: number) => THREE.Color) {
    if (!this.colors) return
    const memo = new Map<string, THREE.Color>()
    for (let i = 0; i < this.tones.length; i++) {
      const key = `${this.tones[i]}:${this.owners[i]}`
      let c = memo.get(key)
      if (!c) memo.set(key, (c = color(this.tones[i], this.owners[i])))
      this.colors.setXYZ(i, c.r, c.g, c.b)
    }
    this.colors.needsUpdate = true
  }

  setOpacity(k: number) {
    if (this.material) this.material.uniforms.uOpacity.value = k
  }

  stats() {
    return { glyphs: this.tones.length }
  }

  dispose() {
    this.object.geometry.dispose()
    this.material?.dispose()
  }

  private fit(text: string, font: FontName, size: number, max: number): string {
    if (this.width(text, font, size) <= max) return text
    const chars = [...text]
    let lo = 0
    let hi = chars.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.width(`${chars.slice(0, mid).join('')}…`, font, size) <= max) lo = mid
      else hi = mid - 1
    }
    return lo ? `${chars.slice(0, lo).join('').trimEnd()}…` : ''
  }

  private glyph(g: Glyph, u: number, top: number, scale: number, run: TextRun) {
    this.rects.push(u, top, g.w * scale, CELL_H * scale)
    this.uvs.push(...g.uv)
    this.lifts.push(run.lift ?? 0)
    this.tones.push(run.tone)
    this.owners.push(run.owner ?? -1)
  }
}
