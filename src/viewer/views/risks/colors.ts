// Risks view: its colors. Risk heat from calm to hot (the ink's ok → warn →
// danger), and one color per kind of debt, the same in the scene, the legend
// and the register. Debt colors are darker on a light background.
import * as THREE from 'three'
import { CO_CHANGE_COLOR, CYCLE_COLOR, VIOLATION_COLOR } from '../../colors.ts'
import type { Ink } from '../arc42-kit/ink.ts'
import type { Debt } from './model.ts'

export const DEBT_COLORS: Record<Debt | 'ruleError', { dark: string; light: string }> = {
  cycle: { dark: CYCLE_COLOR, light: '#d1401f' },
  rule: { dark: VIOLATION_COLOR, light: '#cf222e' },
  ruleError: { dark: VIOLATION_COLOR, light: '#cf222e' },
  coupling: { dark: CO_CHANGE_COLOR, light: '#a535c4' },
  untested: { dark: '#39c5cf', light: '#0e8a96' },
  complex: { dark: '#8b6cf0', light: '#6639ba' },
}

export const DEBT_NAMES: Record<Debt, string> = {
  cycle: 'in an import cycle',
  rule: 'breaks a rule',
  coupling: 'hidden coupling',
  untested: 'no test reaches it',
  complex: 'among the most complex',
}

export const debtColor = (debt: Debt | 'ruleError', light: boolean) => DEBT_COLORS[debt][light ? 'light' : 'dark']

/** Risk heat for t in 0–1: ok, warn halfway, danger at the top. */
export function heat(ink: Ink, t: number): THREE.Color {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? ink.ok.clone().lerp(ink.warn, x * 2) : ink.warn.clone().lerp(ink.danger, (x - 0.5) * 2)
}

/** A risk (1–25) on the heat scale; the lower half of the matrix stays calm. */
export const riskHeat = (ink: Ink, risk: number) => heat(ink, (risk - 1) / 24)

/** What a calm tower is made of: paper on light, a quiet slate on dark. */
const neutral = (ink: Ink) => (ink.light ? ink.paper.clone() : ink.line.clone().lerp(ink.board, 0.45))

/** A tower's color: calm ones stay neutral, so the eye goes to the hot ones. */
export function towerColor(ink: Ink, risk: number): THREE.Color {
  const t = (risk - 1) / 24
  return neutral(ink).lerp(riskHeat(ink, risk), 0.12 + 0.88 * Math.pow(t, 1.3))
}

/** A cell's floor: a soft tint of its risk on the board. */
export function cellColor(ink: Ink, risk: number): THREE.Color {
  const t = (risk - 1) / 24
  return ink.board.clone().lerp(riskHeat(ink, risk), ink.light ? 0.1 + 0.14 * t : 0.05 + 0.11 * t)
}
