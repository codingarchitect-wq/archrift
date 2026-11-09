// Terrain view: the surface, its decoration. A lit mesh over the heightfield,
// colored per vertex with the viewer's colors of the region under it (area,
// heat, focus, selection), with contour lines drawn in the shader (every
// fifth stronger), water below the line and small blocks for packages (the
// engine hides every box in this view). Picks by marching the ray over the
// heightfield and mapping the hit to the file cell (or folder) under it.
import * as THREE from 'three'
import { NEUTRAL } from '../../colors.ts'
import type { Rect } from '../../layouts/city.ts'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { SceneEngine, Theme } from '../../scene/engine.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { WATER, blur, lastContaining, nearest, owners, raycastField } from './heightfield.ts'
import type { Terrain } from './layout.ts'
import { METRICS } from './metric.ts'

const MORPH_MS = 900
/** Contour lines over the full height (every fifth is stronger). */
const CONTOURS = 16
/** Folder borders take the nearest file's color this many vertices out. */
const BORDER = 4
const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)

export class TerrainSurface implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly engine: SceneEngine
  private readonly terrainOf: (layout: Layout) => Terrain | undefined
  private readonly colorsOf: () => Map<string, THREE.Color> | null
  private readonly uniforms = {
    uStep: { value: 1 },
    uWater: { value: 0 },
    uLine: { value: new THREE.Color() },
    uStrength: { value: 0.16 },
  }
  private readonly material: THREE.MeshLambertMaterial
  private mesh: THREE.Mesh | null = null
  private externals: THREE.InstancedMesh | null = null
  private externalIds: string[] = []
  private terrain: Terrain | null = null
  /** The engine draws no boxes under this surface (the layout says so). */
  private boxesHidden = false
  private rects: Rect[] = []
  /** Per vertex: the region that colors it, the nearest file (for folder borders), how wet it is. */
  private owner: Int32Array | null = null
  private near: { index: Int32Array; distance: Uint8Array } | null = null
  private shore: Float32Array | null = null
  private morph: { from: Float32Array; to: Float32Array; now: Float32Array; t0: number } | null = null

  constructor(engine: SceneEngine, terrainOf: (layout: Layout) => Terrain | undefined, colorsOf: () => Map<string, THREE.Color> | null) {
    this.engine = engine
    this.terrainOf = terrainOf
    this.colorsOf = colorsOf
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vGroundY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundY = transformed.y;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGroundY;\nuniform float uStep;\nuniform float uWater;\nuniform vec3 uLine;\nuniform float uStrength;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // contour lines about a pixel wide at any zoom; none on the water or the plain
          float level = vGroundY / uStep;
          float width = max(fwidth(level), 1e-4);
          float away = abs(fract(level - 0.5) - 0.5);
          float minor = 1.0 - smoothstep(0.0, width, away);
          float major = (1.0 - smoothstep(0.0, width * 1.7, away)) * step(mod(floor(level + 0.5), 5.0), 0.5);
          float onLand = step(uWater + uStep * 0.5, vGroundY);
          diffuseColor.rgb = mix(diffuseColor.rgb, uLine, max(minor * uStrength, major * uStrength * 2.0) * onLand);`,
        )
    }
    this.material.customProgramCacheKey = () => 'archrift-terrain'
  }

  update(ctx: ViewContext, layout: Layout) {
    const terrain = this.terrainOf(layout)
    if (!terrain) return
    if (terrain !== this.terrain) this.setTerrain(terrain, layout)
    this.boxesHidden = !!layout.hideBoxes
    this.paint(ctx.theme)
    this.engine.requestRender()
  }

  /** A new heightfield: morph to it from what is shown (from flat the first time). */
  private setTerrain(terrain: Terrain, layout: Layout) {
    const { n, size, step, heights } = terrain.field
    const before = this.terrain
    const reuse = this.mesh && before && before.field.n === n && before.field.size === size
    const to = new Float32Array(n * n)
    for (let k = 0; k < n * n; k++) to[k] = heights[k] * terrain.scale
    let from: Float32Array | null = null
    if (reuse) {
      const pos = this.mesh!.geometry.getAttribute('position') as THREE.BufferAttribute
      from = new Float32Array(n * n)
      for (let k = 0; k < n * n; k++) from[k] = pos.getY(k)
    } else {
      if (this.mesh) {
        this.object.remove(this.mesh)
        this.mesh.geometry.dispose()
      }
      this.mesh = new THREE.Mesh(gridGeometry(n, size, step), this.material)
      this.mesh.frustumCulled = false // its heights morph; it's almost always in view anyway
      this.object.add(this.mesh)
      if (!before) from = new Float32Array(n * n) // rise from the flat city
    }
    const animate = from && !matchMedia('(prefers-reduced-motion: reduce)').matches
    this.morph = animate ? { from: from!, to, now: new Float32Array(n * n), t0: performance.now() } : null
    this.writeHeights(animate ? from! : to)
    this.terrain = terrain
    this.rects = terrain.regions.map(r => r.rect)
    this.owner = owners(terrain.field, this.rects)
    this.near = nearest(n, this.owner, terrain.districts, BORDER)
    this.shore = blur(terrain.field.water, n, 0.8)
    this.uniforms.uStep.value = terrain.scale / CONTOURS
    this.uniforms.uWater.value = WATER * terrain.scale
    this.setExternals(layout)
  }

  private writeHeights(y: Float32Array) {
    const geometry = this.mesh!.geometry
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute
    const n = Math.round(Math.sqrt(pos.count))
    const step = pos.getX(1) - pos.getX(0)
    for (let k = 0; k < y.length; k++) pos.setY(k, y[k])
    writeNormals(y, n, step, normal.array as Float32Array)
    pos.needsUpdate = true
    normal.needsUpdate = true
  }

  /** Packages: small blocks south of the land, as the City has them. */
  private setExternals(layout: Layout) {
    if (this.externals) {
      this.object.remove(this.externals)
      ;(this.externals.material as THREE.Material).dispose()
      this.externals.dispose()
      this.externals = null
    }
    this.externalIds = [...layout.placement].filter(([, p]) => p === 'external').map(([id]) => id)
    if (!this.externalIds.length) return
    const mesh = new THREE.InstancedMesh(BOX, new THREE.MeshLambertMaterial(), this.externalIds.length)
    const m = new THREE.Matrix4()
    this.externalIds.forEach((id, i) => {
      const b = layout.boxes.get(id)!
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(b.x, b.y, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d)))
      mesh.setColorAt(i, new THREE.Color(NEUTRAL))
    })
    mesh.computeBoundingSphere()
    this.externals = mesh
    this.object.add(mesh)
  }

  /**
   * Vertex colors: a file cell takes the viewer's color for the file; folder
   * borders between cells the nearest file's, darkened, fading to the
   * folder's own color a few vertices out. Softened, lighter with height,
   * water tinted.
   */
  private paint(theme: Theme) {
    if (!this.mesh || !this.terrain || !this.owner || !this.near || !this.shore) return
    const { n, heights } = this.terrain.field
    const firstFile = this.terrain.districts
    const colors = this.colorsOf()
    const district = new THREE.Color(theme.district)
    const neutral = new THREE.Color(NEUTRAL)
    const ground = new THREE.Color(theme.ground)
    const regionColors = this.terrain.regions.map((r, i) => colors?.get(r.id) ?? (i < firstFile ? district : neutral))
    const [r, g, b] = [new Float32Array(n * n), new Float32Array(n * n), new Float32Array(n * n)]
    for (let k = 0; k < n * n; k++) {
      const o = this.owner[k]
      const c = o >= 0 ? regionColors[o] : ground
      r[k] = c.r
      g[k] = c.g
      b[k] = c.b
      const f = this.near.index[k]
      if (o >= firstFile || f < 0) continue
      const t = 1 - this.near.distance[k] / (BORDER + 1)
      const file = regionColors[f]
      r[k] += (file.r * 0.72 - r[k]) * t
      g[k] += (file.g * 0.72 - g[k]) * t
      b[k] += (file.b * 0.72 - b[k]) * t
    }
    const [sr, sg, sb] = [r, g, b].map(ch => blur(ch, n, 0.7))
    // the background with a hint of the accent: deep in the dark scheme, pale in the light one, apart from any land
    const waterColor = new THREE.Color(theme.background).lerp(new THREE.Color(theme.accent), 0.14)
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    const out = attr.array as Float32Array
    for (let k = 0; k < n * n; k++) {
      // a touch lighter with height, so the relief reads even in flat colors
      const lift = 0.86 + 0.28 * heights[k]
      const wet = 0.85 * this.shore[k]
      out[k * 3] = sr[k] * lift + (waterColor.r - sr[k] * lift) * wet
      out[k * 3 + 1] = sg[k] * lift + (waterColor.g - sg[k] * lift) * wet
      out[k * 3 + 2] = sb[k] * lift + (waterColor.b - sb[k] * lift) * wet
    }
    attr.needsUpdate = true
    this.uniforms.uLine.value.set(theme.selection)
    if (this.externals) {
      this.externalIds.forEach((id, i) => this.externals!.setColorAt(i, colors?.get(id) ?? neutral))
      if (this.externals.instanceColor) this.externals.instanceColor.needsUpdate = true
    }
  }

  animate(now: number) {
    if (!this.morph || !this.mesh) return false
    const k = Math.min(1, (now - this.morph.t0) / MORPH_MS)
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    const { from, to, now: y } = this.morph
    for (let i = 0; i < to.length; i++) y[i] = from[i] + (to[i] - from[i]) * e
    this.writeHeights(y)
    if (k === 1) this.morph = null
    return k < 1
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    if (!this.terrain) return undefined
    let best: DecorationHit | undefined
    let bestDistance = Infinity
    if (this.externals) {
      const hit = raycaster.intersectObject(this.externals, false)[0]
      if (hit?.instanceId !== undefined) {
        best = { id: this.externalIds[hit.instanceId], kind: 'external' }
        bestDistance = hit.distance
      }
    }
    const { origin, direction } = raycaster.ray
    const p = raycastField(this.terrain.field, this.terrain.scale, origin, direction)
    if (!p || Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) >= bestDistance) return best
    const i = lastContaining(this.rects, p.x, p.z)
    if (i < 0) return null // the ground around the land: mine, but no node
    return { id: this.terrain.regions[i].id, kind: i >= this.terrain.districts ? 'building' : 'district' }
  }

  stats(): Record<string, number> {
    const t = this.terrain
    if (!t) return {}
    return {
      grid: t.field.n,
      files: t.regions.length - t.districts,
      districts: t.districts,
      peaks: t.peaks.length,
      metric: METRICS.findIndex(m => m.id === t.metric),
      height: Math.round(t.scale),
      water: t.field.water.reduce((a, w) => a + (w > 0 ? 1 : 0), 0),
      externals: this.externalIds.length,
      boxesHidden: this.boxesHidden ? 1 : 0,
    }
  }

  dispose() {
    this.mesh?.geometry.dispose()
    this.material.dispose()
    if (this.externals) {
      ;(this.externals.material as THREE.Material).dispose()
      this.externals.dispose()
    }
  }
}

/** A flat n×n grid over the square, with room for heights, normals and colors. */
function gridGeometry(n: number, size: number, step: number) {
  const half = size / 2
  const positions = new Float32Array(n * n * 3)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3
      positions[k] = i * step - half
      positions[k + 2] = j * step - half
    }
  const index = new (n * n > 65535 ? Uint32Array : Uint16Array)((n - 1) * (n - 1) * 6)
  let o = 0
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = c + 1
      // counter-clockwise seen from above: normals point up
      index[o++] = a
      index[o++] = c
      index[o++] = b
      index[o++] = b
      index[o++] = c
      index[o++] = d
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  return g
}

/** Normals from the height grid by central differences (cheaper than per triangle, and smooth). */
function writeNormals(y: Float32Array, n: number, step: number, out: Float32Array) {
  for (let j = 0; j < n; j++) {
    const up = Math.max(j - 1, 0)
    const down = Math.min(j + 1, n - 1)
    for (let i = 0; i < n; i++) {
      const left = Math.max(i - 1, 0)
      const right = Math.min(i + 1, n - 1)
      const dx = (y[j * n + right] - y[j * n + left]) / ((right - left) * step)
      const dz = (y[down * n + i] - y[up * n + i]) / ((down - up) * step)
      const len = Math.hypot(dx, 1, dz)
      const k = (j * n + i) * 3
      out[k] = -dx / len
      out[k + 1] = 1 / len
      out[k + 2] = -dz / len
    }
  }
}
