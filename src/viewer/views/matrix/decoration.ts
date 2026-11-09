// The Matrix view's 3D content: a near-black (or pale) backdrop, the cells as
// instanced quads, row strips and column ticks in the rows' colors, row and
// column names written in the atlas's glyphs (they fade in once legible),
// layer blocks, the selection's crosshair, and digital rain falling down every
// column behind the cells, faster and denser where the file changed recently.
// Picking a cell (or a name) answers its row's (or column's) node; hovering a
// lit cell names both ends.
import * as THREE from 'three'
import { CYCLE_COLOR, UP_COLOR, VIOLATION_COLOR } from '../../colors.ts'
import type { Layout } from '../../layouts/types.ts'
import type { SceneEngine, Theme } from '../../scene/engine.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { glyphAtlas, glyphIndex } from './glyphs.ts'
import { CELL, KIND, colX, rank, rowY, wallFor, wallOf } from './model.ts'
import type { MatrixModel, Wall } from './model.ts'
import { selectionOf } from './selection.ts'
import type { MatrixSelection } from './selection.ts'
import { rain as rainSetting, reducedMotion, summary } from './settings.ts'
import {
  UNITS_WIDTH,
  cellsFragment,
  cellsVertex,
  rainFragment,
  rainVertex,
  textFragment,
  textVertex,
  ticksFragment,
  ticksVertex,
} from './shaders.ts'

const NAME_WIDTH = 32
const RAIN_GLYPH = CELL * 1.25
const FADE_MS = 700
const BURST_SECONDS = 2.2
const DIAGONAL = 5
/** The inspector's width and margin (it covers the scene's right side while something is selected). */
const INSPECTOR_WIDTH = 412

interface Palette {
  dark: boolean
  backdrop: THREE.Color
  frame: THREE.Color
  grid: THREE.Color
  diagonal: THREE.Color
  usesLow: THREE.Color
  usesHigh: THREE.Color
  up: THREE.Color
  cycle: THREE.Color
  violation: THREE.Color
  text: THREE.Color
  textHi: THREE.Color
  rainHead: THREE.Color
  rainTrail: THREE.Color
  rainAlpha: [number, number]
  burstTrail: THREE.Color
  burstAlpha: [number, number]
  cross: THREE.Color
  crossAlpha: number
}

function paletteFor(theme: Theme): Palette {
  const hsl = { h: 0, s: 0, l: 0 }
  const dark = new THREE.Color(theme.background).getHSL(hsl).l < 0.5
  const c = (hex: string) => new THREE.Color(hex)
  // on the pale wall, the signal colors a shade darker so they keep their contrast
  const signal = (hex: string) => (dark ? c(hex) : c(hex).lerp(c('#000000'), 0.15))
  return {
    dark,
    backdrop: c(dark ? '#010604' : '#f1f7f2'),
    frame: c(dark ? '#03120a' : '#e3eee5'),
    grid: c(dark ? '#145a31' : '#8dbf9c'),
    diagonal: c(dark ? '#0f3a22' : '#a9ccb3'),
    usesLow: c(dark ? '#1f8a43' : '#7dbb90'),
    usesHigh: c(dark ? '#c4ffd4' : '#063d1b'),
    up: signal(UP_COLOR),
    cycle: signal(CYCLE_COLOR),
    violation: signal(VIOLATION_COLOR),
    text: c(dark ? '#3fe07a' : '#167a3e'),
    textHi: c(dark ? '#e6fff0' : '#03250f'),
    rainHead: c(dark ? '#e9fff0' : '#0a4d22'),
    rainTrail: c(dark ? '#00ff41' : '#1f9a4d'),
    rainAlpha: dark ? [0.26, 0.8] : [0.13, 0.36],
    burstTrail: c(dark ? '#8dffb0' : '#0b7a36'),
    burstAlpha: dark ? [0.85, 1] : [0.6, 0.9],
    cross: c(theme.accent),
    crossAlpha: dark ? 0.16 : 0.12,
  }
}

/** A stable 0–1 number per string and salt (FNV-1a). */
function hash(text: string, salt: number) {
  let h = 2166136261 ^ salt
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return ((h >>> 0) % 100_000) / 100_000
}

/** Instanced quads over one unit square, not culled (the shaders place them). */
function quads<T extends THREE.Material>(material: T, renderOrder: number) {
  const square = new THREE.PlaneGeometry(1, 1)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setIndex(square.getIndex())
  geometry.setAttribute('position', square.getAttribute('position'))
  geometry.instanceCount = 0
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return mesh
}

function shader(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false, depthTest: false })
}

export interface MatrixSources {
  model(layout: Layout): MatrixModel | undefined
  colors(layout: Layout): Map<string, THREE.Color> | undefined
}

export function matrixDecoration(ctx: ViewContext, engine: SceneEngine, sources: MatrixSources): ViewDecoration {
  const group = new THREE.Group()
  const atlas = glyphAtlas()
  const reduced = reducedMotion()
  let palette = paletteFor(ctx.theme)
  let themeKey = ''

  // shared uniforms
  const time = { value: performance.now() / 1000 }
  const fade = { value: reduced ? 1 : 0 }
  const side = { value: CELL }
  let unitsTexture = new THREE.DataTexture(new Uint8Array(UNITS_WIDTH * 4), UNITS_WIDTH, 1)
  const units = { value: unitsTexture }
  let namesTexture = new THREE.DataTexture(new Uint8Array(NAME_WIDTH), NAME_WIDTH, 1, THREE.RedFormat)
  const names = { value: namesTexture }
  const selMode = { value: 0 }
  /** A cell's height on screen, in pixels (from the camera, each frame). */
  const cellPixels = { value: 10 }

  // backdrop and the matrix's own square
  const plane = new THREE.PlaneGeometry(1, 1)
  const flat = (order: number, opacity = 1) => {
    const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, fog: false }))
    m.renderOrder = order
    return m
  }
  // (faded in with the rest when the view is shown)
  const backdrop = flat(-10, fade.value)
  const frame = flat(-9, fade.value)
  ;(frame.material as THREE.MeshBasicMaterial).depthTest = false

  const grid = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 * fade.value, depthWrite: false, depthTest: false }))
  grid.renderOrder = -8
  grid.frustumCulled = false

  const rainMaterial = (burst: boolean) =>
    shader(rainVertex, rainFragment, {
      uTime: time,
      uFade: fade,
      uSide: side,
      uCell: { value: CELL },
      uGlyphH: { value: RAIN_GLYPH },
      uStatic: { value: burst && reduced ? 1 : 0 },
      uNames: names,
      uAtlas: { value: atlas },
      uWindow: { value: 0.8 },
      uHead: { value: new THREE.Color() },
      uTrail: { value: new THREE.Color() },
      uHeadAlpha: { value: 1 },
      uTrailAlpha: { value: 0.3 },
      uGlow: { value: burst ? 0.3 : 0 },
    })
  const rain = quads(rainMaterial(false), -7)
  const bursts = quads(rainMaterial(true), -6)
  rain.position.z = bursts.position.z = -CELL * 0.5

  const cellBackground = { value: new THREE.Color() }
  /** How much of its color a cell off the crosshair keeps. */
  const dimmed = { value: 0.2 }
  const cells = quads(
    shader(cellsVertex, cellsFragment, {
      uUnits: units,
      uCell: { value: CELL },
      uSide: side,
      uSelMode: selMode,
      uCellPixels: cellPixels,
      uBackground: cellBackground,
      uDimmed: dimmed,
      uFade: fade,
    }),
    -5,
  )
  // row strips (over the rows' own slivers of boxes) and column ticks, in the rows' colors
  const tick = (rows: boolean) =>
    quads(
      shader(ticksVertex, ticksFragment, { uUnits: units, uCell: { value: CELL }, uSide: side, uRows: { value: rows ? 1 : 0 }, uAt: { value: 0 }, uThickness: { value: 1 }, uFade: fade }),
      -4,
    )
  const strips = tick(true)
  const ticks = tick(false)
  const textColor = { value: new THREE.Color() }
  const textHi = { value: new THREE.Color() }
  const hasSel = { value: 0 }
  const text = quads(
    shader(textVertex, textFragment, {
      uUnits: units,
      uAtlas: { value: atlas },
      uWindow: { value: 0.62 },
      uGlyphSize: { value: new THREE.Vector2() },
      uText: textColor,
      uTextHi: textHi,
      uHasSel: hasSel,
      uFade: fade,
    }),
    -3,
  )

  // the selection's crosshair, and the cell under the pointer
  const band = (order: number) => {
    const m = flat(order)
    ;(m.material as THREE.MeshBasicMaterial).depthTest = false
    m.visible = false
    return m
  }
  // behind the cells, so they keep their colors
  const rowBand = band(-6)
  const colBand = band(-6)
  const hoverBand = band(-6)
  const outline = (order: number) => {
    const corners = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ].map(([x, y]) => new THREE.Vector3(x, y, 0))
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }))
    line.renderOrder = order
    line.visible = false
    return line
  }
  const diagonalMark = outline(-1)
  const hoverMark = outline(-1)
  group.add(backdrop, frame, grid, rain, bursts, cells, strips, ticks, text, rowBand, colBand, hoverBand, diagonalMark, hoverMark)
  for (const o of [rowBand, colBand, hoverBand, diagonalMark, hoverMark]) o.position.z = CELL * 0.4

  // the pointer's cell: a readout of what depends on what
  const container = engine.renderer.domElement.parentElement ?? document.body
  container.classList.add('matrix-view')
  const tip = document.createElement('div')
  tip.className = 'matrix-tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  container.appendChild(tip)
  const pointer = { x: 0, y: 0 }
  const onMove = (e: PointerEvent) => void ((pointer.x = e.clientX), (pointer.y = e.clientY))
  const onLeave = () => setHover(null)
  // the engine's own click handler picks first: a click on the wall is where the eye already is
  let picked: { row: number; at: number } | null = null
  let clicked: { row: number; at: number } | null = null
  const onClick = () => void (clicked = picked && performance.now() - picked.at < 100 ? picked : null)
  const canvas = engine.renderer.domElement
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('click', onClick)

  let model: MatrixModel | undefined
  let wall: Wall = wallOf(0)
  let selection: MatrixSelection | null = null
  let hovered: number | null = null
  let travelSeq = ctx.s.travel?.seq ?? -1
  let shown = false
  let lastLive = ctx.s.live?.at
  let burstUntil = 0
  /** Columns the last live change sent rain down. */
  let burst = 0
  let fadeStart = reduced ? 0 : -1
  let raining = rainSetting.get()
  let drops = 0
  let rainColumns = 0
  const unsubscribe = rainSetting.subscribe(() => {
    raining = rainSetting.get()
    rain.visible = raining
    engine.requestRender()
  })
  rain.visible = raining

  function rebuild(m: MatrixModel) {
    model = m
    wall = wallFor(m)
    const n = m.units.length
    side.value = wall.side
    selection = null
    hovered = null

    backdrop.scale.set(wall.side * 40 + 4000, wall.side * 40 + 4000, 1)
    backdrop.position.set(wall.side / 2, wall.side / 2, -CELL * 3)
    frame.scale.set(wall.side + wall.pad * 2, wall.side + wall.pad * 2, 1)
    frame.position.set(wall.side / 2, wall.side / 2, -CELL)

    // per-row color and state
    unitsTexture.dispose()
    unitsTexture = new THREE.DataTexture(new Uint8Array(UNITS_WIDTH * Math.max(1, Math.ceil(n / UNITS_WIDTH)) * 4), UNITS_WIDTH, Math.max(1, Math.ceil(n / UNITS_WIDTH)))
    unitsTexture.needsUpdate = true
    units.value = unitsTexture

    // names for the rain to spell: length, then glyph slots
    namesTexture.dispose()
    const nameData = new Uint8Array(NAME_WIDTH * Math.max(n, 1))
    m.units.forEach((u, i) => {
      const chars = [...u.name].slice(0, NAME_WIDTH - 1)
      nameData[i * NAME_WIDTH] = chars.length
      chars.forEach((ch, k) => (nameData[i * NAME_WIDTH + k + 1] = glyphIndex(ch)))
    })
    namesTexture = new THREE.DataTexture(nameData, NAME_WIDTH, Math.max(n, 1), THREE.RedFormat)
    namesTexture.needsUpdate = true
    names.value = namesTexture

    // cells, then the diagonal
    const count = m.cells.length + n
    const at = new Float32Array(count * 2)
    m.cells.forEach((c, i) => at.set([c.col, c.row], i * 2))
    for (let i = 0; i < n; i++) at.set([i, i], (m.cells.length + i) * 2)
    setAttributes(cells, { aCell: [at, 2], aStyle: [new Float32Array(count * 4), 4] }, count)

    // row strips and column ticks
    const order = Float32Array.from({ length: n }, (_, i) => i)
    for (const [mesh, at] of [
      [strips, -wall.pad - wall.strip / 2],
      [ticks, wall.side + wall.pad + wall.strip / 2],
    ] as const) {
      setAttributes(mesh, { aIndex: [order.slice(), 1] }, n)
      const u = (mesh.material as THREE.ShaderMaterial).uniforms
      u.uAt.value = at
      u.uThickness.value = wall.strip
    }

    // names: rows right-aligned left of the strips, columns reading upward above the ticks
    let glyphs = 0
    for (const u of m.units) glyphs += u.name.length * 2
    const g = new Float32Array(glyphs * 3)
    const owner = new Float32Array(glyphs * 2)
    let k = 0
    m.units.forEach((u, i) => {
      const chars = [...u.name]
      chars.forEach((ch, j) => {
        g.set([wall.rowTextRight - (chars.length - j - 0.5) * wall.glyphW, rowY(wall, i), glyphIndex(ch)], k * 3)
        owner.set([i, 0], k * 2)
        k++
        g.set([colX(i), wall.colTextBottom + (j + 0.5) * wall.glyphW, glyphIndex(ch)], k * 3)
        owner.set([i, 1], k * 2)
        k++
      })
    })
    setAttributes(text, { aGlyph: [g, 3], aUnit: [owner, 2] }, k)
    ;(text.material as THREE.ShaderMaterial).uniforms.uGlyphSize.value.set(wall.glyphW, wall.glyphH)

    // block squares along the diagonal, and their edges across the matrix
    const lines: number[] = []
    const y = (row: number) => wall.side - row * CELL
    for (const b of m.blocks) {
      const x0 = b.start * CELL
      const x1 = b.end * CELL
      lines.push(x0, y(b.start), 0, x1, y(b.start), 0, x1, y(b.start), 0, x1, y(b.end), 0, x1, y(b.end), 0, x0, y(b.end), 0, x0, y(b.end), 0, x0, y(b.start), 0)
      if (b.end < n) lines.push(0, y(b.end), 0, wall.side, y(b.end), 0, x1, 0, 0, x1, wall.side, 0)
    }
    grid.geometry.dispose()
    grid.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))

    // rain: 1–3 drops per column by activity, and one idle burst per column
    const drop: number[] = []
    const column: number[] = []
    const start: number[] = []
    m.units.forEach((u, i) => {
      const a = u.activity
      const perColumn = 1 + (a > 0.45 ? 1 : 0) + (a > 0.85 ? 1 : 0)
      for (let d = 0; d < perColumn; d++) {
        const speed = Math.max(RAIN_GLYPH * (4 + 14 * a), wall.side * (0.05 + 0.17 * a)) * (0.8 + 0.4 * hash(u.id, d * 3 + 1))
        const trail = Math.min(wall.side * 0.7, Math.max(RAIN_GLYPH * (6 + 20 * a), wall.side * (0.08 + 0.25 * a))) * (0.75 + 0.5 * hash(u.id, d * 3 + 2))
        const gap = wall.side * (0.15 + 2.4 * (1 - a))
        drop.push(speed, trail, wall.side + trail + gap, hash(u.id, d * 3 + 3))
        column.push(i)
        start.push(-1)
      }
    })
    drops = column.length
    rainColumns = new Set(column).size
    setAttributes(rain, { aDrop: [new Float32Array(drop), 4], aColumn: [new Float32Array(column), 1], aStart: [new Float32Array(start), 1] }, drops)
    const burstDrop = new Float32Array(n * 4)
    // a burst falls through the matrix in 1.6 s, trail and all, whatever its size
    const burstTrail = Math.max(wall.side * 0.45, RAIN_GLYPH * 4)
    for (let i = 0; i < n; i++) burstDrop.set([(wall.side + burstTrail) / (BURST_SECONDS - 0.6), burstTrail, 0, 0], i * 4)
    setAttributes(
      bursts,
      { aDrop: [burstDrop, 4], aColumn: [order.slice(), 1], aStart: [new Float32Array(n).fill(-2), 1] },
      n,
    )
    burstUntil = 0
  }

  /** A fresh geometry for a family of quads (the old one's buffers are freed). */
  function setAttributes(mesh: THREE.Mesh, attributes: Record<string, [Float32Array, number]>, count: number) {
    const old = mesh.geometry as THREE.InstancedBufferGeometry
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setIndex(old.getIndex())
    geometry.setAttribute('position', old.getAttribute('position'))
    for (const [name, [data, size]] of Object.entries(attributes)) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, size))
    geometry.instanceCount = count
    mesh.geometry = geometry
    old.dispose()
  }

  /** Cell colors: green brighter with more references; the reasons in their colors. */
  function paintCells() {
    if (!model) return
    const style = (cells.geometry as THREE.InstancedBufferGeometry).getAttribute('aStyle') as THREE.InstancedBufferAttribute
    const data = style.array as Float32Array
    // brightness: half by rank (dense folder matrices don't wash out), half by log weight (magnitudes still show)
    const top = Math.log1p(model.maxWeight || 1)
    const ranked = rank(model.cells.map(c => c.weight))
    const c = new THREE.Color()
    model.cells.forEach((cell, i) => {
      const t = 0.5 * ranked[i] + 0.5 * (Math.log1p(cell.weight) / top)
      // a broken rule is red, an error or a warning alike
      if (cell.kind === KIND.violation || cell.kind === KIND.warning) c.copy(palette.violation)
      else if (cell.kind === KIND.cycle) c.copy(palette.cycle)
      else if (cell.kind === KIND.up) c.copy(palette.up).multiplyScalar(0.7 + 0.3 * t)
      else c.copy(palette.usesLow).lerp(palette.usesHigh, t)
      data.set([c.r, c.g, c.b, cell.kind], i * 4)
    })
    const inside = Math.log1p(model.inside.reduce((a, b) => Math.max(a, b), 1))
    model.units.forEach((_, i) => {
      c.copy(palette.diagonal)
      if (model!.inside[i]) c.lerp(palette.usesLow, 0.6 * (Math.log1p(model!.inside[i]) / inside))
      data.set([c.r, c.g, c.b, DIAGONAL], (model!.cells.length + i) * 4)
    })
    style.needsUpdate = true
  }

  function applyPalette() {
    ;(backdrop.material as THREE.MeshBasicMaterial).color.copy(palette.backdrop)
    ;(frame.material as THREE.MeshBasicMaterial).color.copy(palette.frame)
    ;(grid.material as THREE.LineBasicMaterial).color.copy(palette.grid)
    cellBackground.value.copy(palette.frame)
    dimmed.value = palette.dark ? 0.2 : 0.35
    textColor.value.copy(palette.text)
    textHi.value.copy(palette.textHi)
    for (const [mesh, alpha] of [
      [rain, palette.rainAlpha],
      [bursts, palette.burstAlpha],
    ] as const) {
      const u = (mesh.material as THREE.ShaderMaterial).uniforms
      u.uHead.value.copy(mesh === bursts && palette.dark ? new THREE.Color('#ffffff') : palette.rainHead)
      u.uTrail.value.copy(mesh === bursts ? palette.burstTrail : palette.rainTrail)
      u.uTrailAlpha.value = alpha[0]
      u.uHeadAlpha.value = alpha[1]
    }
    for (const b of [rowBand, colBand]) {
      const m = b.material as THREE.MeshBasicMaterial
      m.color.copy(palette.cross)
      m.opacity = palette.crossAlpha
    }
    const hb = hoverBand.material as THREE.MeshBasicMaterial
    hb.color.copy(palette.text)
    hb.opacity = palette.dark ? 0.07 : 0.08
    ;(diagonalMark.material as THREE.LineBasicMaterial).color.copy(palette.cross)
    ;(hoverMark.material as THREE.LineBasicMaterial).color.copy(palette.textHi)
    paintCells()
  }

  /** Row colors (as their strips) and states into the per-row texture. */
  function paintUnits(colors: Map<string, THREE.Color> | undefined) {
    if (!model) return
    const data = unitsTexture.image.data as Uint8Array
    const neutral = new THREE.Color('#8b95a5')
    model.units.forEach((u, i) => {
      const c = colors?.get(u.id) ?? neutral
      const state = !selection ? 85 : selection.row === i ? 255 : selection.related.has(i) ? 170 : 0
      data.set([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), state], i * 4)
    })
    unitsTexture.needsUpdate = true
    selMode.value = !selection ? 0 : selection.row !== undefined ? 1 : 2
    hasSel.value = selection ? 1 : 0
  }

  function placeCrosshair() {
    const row = selection?.row
    rowBand.visible = colBand.visible = diagonalMark.visible = row !== undefined
    if (row === undefined) return
    const left = wall.rowTextRight - wall.textLength
    rowBand.scale.set(wall.side - left, CELL, 1)
    rowBand.position.set((left + wall.side) / 2, rowY(wall, row), CELL * 0.4)
    const top = wall.colTextBottom + wall.textLength
    colBand.scale.set(CELL, top, 1)
    colBand.position.set(colX(row), top / 2, CELL * 0.4)
    diagonalMark.scale.set(CELL * 1.2, CELL * 1.2, 1)
    diagonalMark.position.set(colX(row), rowY(wall, row), CELL * 0.4)
  }

  function setHover(cell: { row: number; col: number } | null) {
    const index = cell && model ? model.cellAt.get(cell.row * model.units.length + cell.col) : undefined
    const key = cell ? cell.row * 1e6 + cell.col : null
    if (key === hovered) return positionTip(index !== undefined)
    hovered = key
    hoverMark.visible = hoverBand.visible = !!cell
    if (cell) {
      hoverMark.scale.set(CELL, CELL, 1)
      hoverMark.position.set(colX(cell.col), rowY(wall, cell.row), CELL * 0.4)
      hoverBand.scale.set(CELL, wall.side, 1)
      hoverBand.position.set(colX(cell.col), wall.side / 2, CELL * 0.4)
    }
    if (index === undefined || !model) tip.hidden = true
    else {
      const c = model.cells[index]
      const a = model.units[c.row]
      const b = model.units[c.col]
      const why = [
        `${c.weight.toLocaleString('en-US')} reference${c.weight === 1 ? '' : 's'}`,
        c.up ? 'points up' : '',
        c.cycle ? 'in an import cycle' : '',
        c.rules ? `breaks ${c.rules.join(', ')}` : '',
      ].filter(Boolean)
      const line = document.createElement('div')
      const from = document.createElement('strong')
      from.textContent = a.path
      const to = document.createElement('strong')
      to.textContent = b.path
      line.append(from, ' → ', to)
      const detail = document.createElement('div')
      detail.className = 'dim'
      detail.textContent = why.join(' · ')
      tip.replaceChildren(line, detail)
      tip.hidden = false
    }
    positionTip(index !== undefined)
    engine.requestRender()
  }

  function positionTip(visible: boolean) {
    if (!visible) return
    tip.style.transform = `translate(${Math.round(pointer.x + 14)}px, ${Math.round(Math.max(4, pointer.y - 58))}px)`
  }

  function stay() {
    engine.moveCamera(engine.camera.position.toArray(), engine.controls.target.toArray())
  }

  /** Pan just far enough to bring a row's crossing with its column into view, clear of the toolbar and the inspector. */
  function reveal(row: number) {
    const point = new THREE.Vector3(colX(row), rowY(wall, row), 0)
    const p = point.clone().project(engine.camera)
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const x = ((p.x + 1) / 2) * width
    const y = ((1 - p.y) / 2) * height
    const right = width - (width > 760 ? INSPECTOR_WIDTH : 0) - 60
    const dx = x < 60 ? x - 60 : x > right ? x - right : 0
    const dy = y < 170 ? y - 170 : y > height - 60 ? y - (height - 60) : 0
    if (p.z > 1) return engine.moveCamera(point.clone().add(engine.camera.position.clone().sub(engine.controls.target)).toArray(), point.toArray())
    if (!dx && !dy) return stay()
    // pixels to world units at the wall, along the screen's axes
    const perPixel = (2 * engine.camera.position.distanceTo(engine.controls.target) * Math.tan(THREE.MathUtils.degToRad(engine.camera.fov / 2))) / height
    const shift = new THREE.Vector3()
      .setFromMatrixColumn(engine.camera.matrixWorld, 0)
      .multiplyScalar(dx * perPixel)
      .addScaledVector(new THREE.Vector3().setFromMatrixColumn(engine.camera.matrixWorld, 1), -dy * perPixel)
    engine.moveCamera(engine.camera.position.clone().add(shift).toArray(), engine.controls.target.clone().add(shift).toArray())
  }

  /**
   * Once the names on the wall can be read, the floating row and column labels
   * would only repeat them; and when the selected row's strip is out of view,
   * its name shows at the crossing instead.
   */
  function watchCamera() {
    const distance = engine.camera.position.distanceTo(engine.controls.target)
    const height = canvas.clientHeight || 1
    const rowPixels = (CELL * height) / (2 * distance * Math.tan(THREE.MathUtils.degToRad(engine.camera.fov / 2)))
    cellPixels.value = rowPixels
    container.classList.toggle('matrix-legible', rowPixels >= 11)
    const row = selection?.row
    let far = false
    if (row !== undefined && model) {
      const strip = engine.screenPosition(model.units[row].id)
      const r = canvas.getBoundingClientRect()
      far = !strip || strip.x < r.left || strip.x > r.right || strip.y < r.top || strip.y > r.bottom
    }
    container.classList.toggle('matrix-far', far)
  }

  const planeZ = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const hit = new THREE.Vector3()

  return {
    object: group,

    update(next: ViewContext, layout: Layout) {
      const m = sources.model(layout)
      if (!m) return
      if (m !== model) {
        rebuild(m)
        themeKey = ''
      }
      const key = `${next.theme.background}|${next.theme.accent}`
      if (key !== themeKey) {
        themeKey = key
        palette = paletteFor(next.theme)
        applyPalette()
      }
      selection = selectionOf(next.s, next.world, m, next.grouping?.groupOf)
      paintUnits(sources.colors(layout))
      placeCrosshair()

      // The viewer flies to a selected row's strip, close up at the wall's edge, where neither the
      // row's cells nor its column show. Instead the camera stays put after a click on the wall and
      // otherwise pans to where the row and its column cross, unless that's in view already; showing
      // the view with a selection shows the whole wall. (Queued: it replaces the viewer's own trip,
      // asked for after this update, before a frame is drawn.)
      const travel = next.s.travel
      const row = selection?.row
      if (travel && travel.seq !== travelSeq) {
        travelSeq = travel.seq
        const fromClick = clicked !== null && clicked.row === row && performance.now() - clicked.at < 5000
        clicked = null
        if (row !== undefined && travel.to === next.s.selected) queueMicrotask(() => (fromClick ? stay() : reveal(row)))
      } else if (!shown && row !== undefined) queueMicrotask(() => engine.home())
      shown = true

      // watch mode: rain bursts down the columns of the files that just changed
      const live = next.s.live
      if (live && live.at !== lastLive) {
        lastLive = live.at
        const now = performance.now() / 1000
        const startAttr = (bursts.geometry as THREE.InstancedBufferGeometry).getAttribute('aStart') as THREE.InstancedBufferAttribute
        const columns = new Set(live.files.flatMap(f => m.rowOf(f) ?? []))
        for (const col of columns) startAttr.array[col] = now
        burst = columns.size
        if (burst) {
          startAttr.needsUpdate = true
          burstUntil = now + (reduced ? 2 : BURST_SECONDS)
        }
      }
      if (fadeStart < 0) fadeStart = performance.now()
      const found = { rows: m.units.length, cells: m.cells.length, ...m.counts, depth: m.depth, metric: m.metric }
      if (JSON.stringify(found) !== JSON.stringify(summary.get())) summary.set(found)
      engine.requestRender()
    },

    animate(now: number) {
      time.value = now / 1000
      watchCamera()
      let active = false
      if (fadeStart >= 0 && fade.value < 1) {
        fade.value = Math.min(1, (now - fadeStart) / FADE_MS)
        active = fade.value < 1
        ;(backdrop.material as THREE.MeshBasicMaterial).opacity = (frame.material as THREE.MeshBasicMaterial).opacity = fade.value
        ;(grid.material as THREE.LineBasicMaterial).opacity = 0.55 * fade.value
      }
      return (raining && !!model?.units.length) || time.value < burstUntil || active
    },

    pick(raycaster: THREE.Raycaster) {
      if (!model || !raycaster.ray.intersectPlane(planeZ, hit)) return undefined
      const n = model.units.length
      const col = Math.floor(hit.x / CELL)
      const row = Math.floor((wall.side - hit.y) / CELL)
      const inRows = row >= 0 && row < n
      const inCols = col >= 0 && col < n
      const answer = (i: number) => {
        picked = { row: i, at: performance.now() }
        return { id: model!.units[i].id, kind: model!.units[i].kind === 'external' ? ('external' as const) : ('building' as const) }
      }
      if (inRows && inCols) {
        setHover({ row, col })
        return answer(row)
      }
      setHover(null)
      // the names: a row's left of the matrix, a column's above it
      if (inRows && hit.x < 0 && hit.x >= wall.rowTextRight - wall.textLength) return answer(row)
      if (inCols && hit.y > wall.side && hit.y <= wall.colTextBottom + wall.textLength) return answer(col)
      picked = null
      return null
    },

    stats() {
      return {
        rows: model?.units.length ?? 0,
        cells: model?.cells.length ?? 0,
        up: model?.counts.up ?? 0,
        cycle: model?.counts.cycle ?? 0,
        violation: model?.counts.violation ?? 0,
        warning: model?.counts.warning ?? 0,
        aggregated: model?.depth === null || !model ? 0 : 1,
        rain: raining ? 1 : 0,
        rainColumns: raining ? rainColumns : 0,
        drops: raining ? drops : 0,
        glyphs: (text.geometry as THREE.InstancedBufferGeometry).instanceCount,
        selectedRow: selection?.row ?? -1,
        bursts: burst,
      }
    },

    dispose() {
      unsubscribe()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('click', onClick)
      container.classList.remove('matrix-view', 'matrix-legible', 'matrix-far')
      tip.remove()
      summary.set(null)
      group.traverse(o => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry && mesh.geometry !== plane) mesh.geometry.dispose()
        const material = mesh.material as THREE.Material | undefined
        material?.dispose()
      })
      plane.dispose()
      atlas.dispose()
      unitsTexture.dispose()
      namesTexture.dispose()
    },
  }
}
