// Diagram kit: the home view of boards lying on the floor. The camera looks
// down from HOME's direction, steep enough that rows of text read without
// much foreshortening, and from as far as fits the boards into the part of
// the window the toolbar, the legend and the inspector leave free. Pure.

/** The home view's direction (times the layout's size): about 66° down. */
export const HOME: [number, number, number] = [0, 0.9, 0.4]

/** What covers the window, as shares of it: the toolbar on top, the legend at the bottom, the inspector on the right. */
export interface Screen {
  aspect: number
  top: number
  bottom: number
  right: number
}

export const DEFAULT_SCREEN: Screen = { aspect: 1.6, top: 0.12, bottom: 0.2, right: 0 }

const TAN_V = Math.tan((25 * Math.PI) / 180) // the engine's camera: 50° high

/** The window now: the toolbar's and the legend's heights as drawn (the toolbar wraps on a narrow window), the inspector's 412 px while something is selected. */
export function screenNow(inspector: boolean): Screen {
  if (typeof innerWidth !== 'number' || !innerWidth || !innerHeight) return { ...DEFAULT_SCREEN, right: inspector ? 0.26 : 0 }
  const toolbar = typeof document === 'object' ? document.querySelector('.toolbar')?.getBoundingClientRect().bottom : undefined
  const legend = typeof document === 'object' ? document.querySelector('.legend')?.getBoundingClientRect().top : undefined
  // the view's own controls may add a row once its data is in
  const top = (toolbar ?? 130) + 40
  const bottom = innerHeight - (legend && legend > innerHeight / 2 ? legend : innerHeight - 170) + 10
  return { aspect: innerWidth / innerHeight, top: Math.min(0.3, top / innerHeight), bottom: Math.min(0.35, bottom / innerHeight), right: inspector && innerWidth > 760 ? 412 / innerWidth : 0 }
}

/**
 * The camera's distance (as the layout's size, which HOME is scaled by) and
 * the point it looks at, so the rectangle u0..u1 × v0..v1 on the floor (x, z)
 * fills the free part of the window.
 */
export function homeFor(extent: { u0: number; v0: number; u1: number; v1: number }, screen: Screen = DEFAULT_SCREEN): { size: number; center: [number, number, number] } {
  const length = Math.hypot(...HOME)
  const dir = HOME.map(v => v / length)
  const up = [0, dir[2], -dir[1]] // the screen's up, in the world
  const corners = [extent.u0, extent.u1].flatMap(x => [extent.v0, extent.v1].map(z => [x, 0, z]))
  const free = { x0: -0.96, x1: 0.96 - 2 * screen.right, y0: -1 + 2 * screen.bottom, y1: 1 - 2 * screen.top }
  const tanH = TAN_V * screen.aspect
  let center: [number, number, number] = [(extent.u0 + extent.u1) / 2, 0, (extent.v0 + extent.v1) / 2]
  let distance = Math.max(40, Math.hypot(extent.u1 - extent.u0, extent.v1 - extent.v0))
  for (let it = 0; it < 12; it++) {
    const eye = center.map((v, i) => v + dir[i] * distance)
    const box = projected(corners, eye, dir, up, tanH)
    if (!box) {
      distance *= 1.5
      continue
    }
    const dx = (box.x0 + box.x1) / 2 - (free.x0 + free.x1) / 2
    const dy = (box.y0 + box.y1) / 2 - (free.y0 + free.y1) / 2
    center = [center[0] + dx * distance * tanH, center[1] + dy * distance * TAN_V * up[1], center[2] + dy * distance * TAN_V * up[2]]
    distance *= Math.max((box.x1 - box.x0) / (free.x1 - free.x0), (box.y1 - box.y0) / (free.y1 - free.y0)) * 1.02
  }
  return { size: distance / length, center }
}

/** The corners' extent on screen (normalized device coordinates), or null when one is behind the camera. */
function projected(corners: number[][], eye: number[], dir: number[], up: number[], tanH: number) {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const c of corners) {
    const v = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]]
    const depth = -(v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2])
    if (depth <= 1) return null
    const sx = v[0] / depth / tanH
    const sy = (v[1] * up[1] + v[2] * up[2]) / depth / TAN_V
    ;[x0, x1, y0, y1] = [Math.min(x0, sx), Math.max(x1, sx), Math.min(y0, sy), Math.max(y1, sy)]
  }
  return { x0, x1, y0, y1 }
}
