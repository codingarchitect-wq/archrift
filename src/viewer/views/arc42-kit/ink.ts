// arc42 kit: the colors of a diagram, derived from the viewer's theme so the
// arc42 views read as one family in both color schemes. A tone is a color's
// name in a Sketch (resolved when painting): one of the names below,
// `cat:<n>` for the n-th categorical color (the area palette, also used for
// layers in layer order), or a literal `#rrggbb`.
import * as THREE from 'three'
import { AREA_PALETTE, VIOLATION_COLOR, WARNING_COLOR } from '../../colors.ts'
import type { Theme } from '../../scene/engine.ts'

export interface Ink {
  light: boolean
  background: THREE.Color
  ground: THREE.Color
  /** A diagram's board: a sheet just off the ground. */
  board: THREE.Color
  /** The board's rim, and quiet outlines. */
  edge: THREE.Color
  /** A building block's face. */
  paper: THREE.Color
  /** Lines and outlines that must read: the text color. */
  ink: THREE.Color
  /** Connectors at rest. */
  line: THREE.Color
  /** Secondary lines, grids, hatching. */
  muted: THREE.Color
  accent: THREE.Color
  danger: THREE.Color
  warn: THREE.Color
  ok: THREE.Color
}

export type ToneName = Exclude<keyof Ink, 'light'>

const cache = new WeakMap<Theme, Ink>()

export function inkOf(theme: Theme): Ink {
  const hit = cache.get(theme)
  if (hit) return hit
  const background = new THREE.Color(theme.background)
  const ground = new THREE.Color(theme.ground)
  const district = new THREE.Color(theme.district)
  const text = new THREE.Color(theme.selection)
  const light = lightness(background) > 0.5
  const white = new THREE.Color('#ffffff')
  const board = light ? ground.clone().lerp(white, 0.72) : ground.clone().lerp(district, 0.42)
  const ink: Ink = {
    light,
    background,
    ground,
    board,
    edge: light ? district.clone().lerp(text, 0.12) : district.clone().lerp(white, 0.1),
    paper: light ? white.clone() : district.clone().lerp(white, 0.06),
    ink: text.clone(),
    line: text.clone().lerp(board, light ? 0.42 : 0.38),
    muted: text.clone().lerp(board, 0.68),
    accent: new THREE.Color(theme.accent),
    danger: new THREE.Color(light ? '#cf222e' : VIOLATION_COLOR),
    warn: new THREE.Color(light ? '#bf8700' : WARNING_COLOR),
    ok: new THREE.Color(light ? '#1a7f37' : '#3fb950'),
  }
  cache.set(theme, ink)
  return ink
}

/** The n-th categorical color (the area palette, then hues around the circle), darkened on a light background until it stands out. */
export function categorical(n: number, ink: Ink): THREE.Color {
  const c =
    n < AREA_PALETTE.length
      ? new THREE.Color(AREA_PALETTE[n])
      : new THREE.Color().setHSL((((n - AREA_PALETTE.length) * 137.508 + 20) % 360) / 360, 0.55, 0.55)
  if (!ink.light) return c
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  return c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(hsl.l, 0.5))
}

/** A tone's color (a new instance): a name of Ink, `cat:<n>`, or `#rrggbb`. Unknown tones are the line color. */
export function toneColor(ink: Ink, tone: string): THREE.Color {
  if (tone.startsWith('#')) return new THREE.Color(tone)
  if (tone.startsWith('cat:')) return categorical(Number(tone.slice(4)) || 0, ink)
  const named = (ink as unknown as Record<string, unknown>)[tone]
  return named instanceof THREE.Color ? named.clone() : ink.line.clone()
}

/** A color faded toward the ground by k (0: as is, 1: gone): what isn't part of the selection. */
export function fade(c: THREE.Color, ink: Ink, k: number): THREE.Color {
  return c.lerp(ink.ground, k)
}

/** Text that reads on a background of this color: dark on light, white on dark. */
export function textOn(c: THREE.Color): string {
  return lightness(c) > 0.62 ? '#14171c' : '#ffffff'
}

export const lightness = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).l
