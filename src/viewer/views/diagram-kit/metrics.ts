// Diagram kit: the fonts cards are written in, and how wide a text is in
// them. Layouts size cards from these widths without a canvas (they run in
// tests too); the text layer measures the real glyphs and shortens a text
// with an ellipsis where it still doesn't fit. The widths are Helvetica's,
// which system-ui is close to.

/** The card fonts: a title, body text (also italic), monospace for types and signatures. */
export type FontName = 'title' | 'text' | 'italic' | 'mono'

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** CSS fonts at a pixel size (the atlas draws glyphs with them). */
export const CSS_FONT: Record<FontName, (px: number) => string> = {
  title: px => `650 ${px}px ${SANS}`,
  text: px => `400 ${px}px ${SANS}`,
  italic: px => `italic 400 ${px}px ${SANS}`,
  mono: px => `400 ${px}px ${MONO}`,
}

/** Advance widths in thousandths of an em (Helvetica's AFM). */
const WIDTHS: Record<string, number> = {}
const set = (chars: string, w: number) => {
  for (const c of chars) WIDTHS[c] = w
}
set('ijl', 222)
set('frt', 278)
set(' .,:;!/[]I\\', 278)
set('|', 260)
set("'", 191)
set('"', 355)
set('()-`r', 333)
set('{}', 334)
set('*', 389)
set('^', 469)
set('ckszvxyJ', 500)
set('abdeghnopqu0123456789#$_?L', 556)
set('<>=+~', 584)
set('FTZ', 611)
set('ABEKPSVXY&', 667)
set('CDHNRUw', 722)
set('GOQ', 778)
set('mM', 833)
set('%', 889)
set('W', 944)
set('@', 1015)
set('…', 1000)
set('«»', 556)
set('·', 278)
set('→', 1000)

/** The title's bold face runs wider than the body text. */
const BOLD = 1.07

/** How wide `text` is at `size` (world units per em) in a font. */
export function textWidth(text: string, font: FontName, size: number): number {
  if (font === 'mono') return [...text].length * 0.6 * size
  let w = 0
  for (const c of text) w += WIDTHS[c] ?? 600
  return (w / 1000) * size * (font === 'title' ? BOLD : 1)
}

/** The longest start of `text` (with an ellipsis) no wider than `max`. */
export function fitText(text: string, font: FontName, size: number, max: number): string {
  if (textWidth(text, font, size) <= max) return text
  const chars = [...text]
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (textWidth(`${chars.slice(0, mid).join('')}…`, font, size) <= max) lo = mid
    else hi = mid - 1
  }
  return lo ? `${chars.slice(0, lo).join('').trimEnd()}…` : ''
}
