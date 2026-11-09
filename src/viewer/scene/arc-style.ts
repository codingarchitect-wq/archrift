// How the selection's arcs are drawn: bold while there are few, thinner and
// lighter as they multiply, so a busy selection (a change's files with every
// dependency they have) stays readable rather than a solid mass of color.

/** Up to this many arcs keep the full width. */
const FEW = 12
/** From this many on, the thinnest. */
const MANY = 200
const WIDEST = 2.6
const THINNEST = 1

/** The width in pixels and the opacity for `n` arcs of a selection. */
export function focusArcStyle(n: number): { width: number; opacity: number } {
  if (n <= FEW) return { width: WIDEST, opacity: 1 }
  const t = Math.min(1, Math.log2(n / FEW) / Math.log2(MANY / FEW))
  return { width: WIDEST - (WIDEST - THINNEST) * t, opacity: 1 - 0.45 * t }
}
