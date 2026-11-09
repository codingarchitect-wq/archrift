// Diagram kit: a card, the box both the ERD's tables and the class diagram's
// types are drawn as. A title band (a small line above the title for a UML
// stereotype, a small aside after it for an entity's name), then
// compartments of rows: a mark column (a key, a tag such as FK, a visibility
// sign), the name, and a detail (a column's type at the right, or a member's
// signature after its name). A long card shows its first rows and "+N more";
// the selected one shows them all. This file sizes cards and says which rows
// show (pure, for the layouts and tests); card-draw.ts draws them.
import { fitText, textWidth } from './metrics.ts'

export interface CardRow {
  /** What a click on the row selects (a member, a column's node); the card's own id otherwise. */
  id?: string
  /** A primary key's key icon. */
  key?: boolean
  /** A short tag in the mark column: FK, UQ. */
  tag?: string
  /** A visibility sign: + − # ~. */
  sign?: string
  name: string
  /** A column's type (right-aligned) or what follows a member's name (its parameters and type). */
  detail?: string
  /** Muted: a nullable type, a relation field. */
  quiet?: boolean
  /** Abstract (UML italic). */
  italic?: boolean
  /** Static (UML underlined). */
  underline?: boolean
  /** The "+N more" line standing for rows left out. */
  more?: number
}

export interface CardContent {
  /** What a click on the card selects. */
  id: string
  title: string
  /** Small, above the title: a stereotype («interface»). */
  over?: string
  /** Small, after the title: the entity's name when the table's differs. */
  aside?: string
  /** The title in italics (an abstract class). */
  italic?: boolean
  /** Compartments of rows. */
  sections: CardRow[][]
  /** Drawn as a name in a dashed outline: something outside the diagram (a base type, a table elsewhere). */
  ghost?: boolean
  /** Title placement (UML centers it). */
  align: 'left' | 'center'
  /** Where a row's detail goes: right-aligned in its own column (a type), or after the name (a signature). */
  detail: 'right' | 'after'
}

export interface SizeLimits {
  /** Rows shown at most (the "+N more" lines included); all of them when the card is opened. */
  rows: number
  minW: number
  maxW: number
}

/** A card as drawn: its size, the title band's height, and the rows shown in each compartment with where they start. */
export interface CardShape {
  w: number
  h: number
  band: number
  sections: { rows: CardRow[]; v: number }[]
  /** The mark column's width (0 without marks), and the sign column's. */
  marks: number
  signs: number
}

/** Sizes in world units. */
export const CARD = {
  row: 1.5,
  pad: 0.75,
  /** The title band, with one line or two. */
  band: 2.3,
  band2: 3.3,
  /** Room above and below a compartment's rows. */
  inset: 0.3,
  titleEm: 1.0,
  nameEm: 0.78,
  detailEm: 0.7,
  smallEm: 0.62,
  markW: 2.0,
  signW: 0.95,
  gap: 0.9,
  r: 0.45,
  /** A ghost card's height. */
  ghost: 2.6,
} as const

/** How many rows each compartment shows within a budget: fair shares, what one doesn't need going to the others. */
export function allot(counts: readonly number[], budget: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= budget) return [...counts]
  const out = counts.map(() => 0)
  let left = Math.max(counts.filter(c => c > 0).length, budget)
  for (let pass = 0; pass < counts.length && left > 0; pass++) {
    const wanting = counts.map((c, i) => (c > out[i] ? i : -1)).filter(i => i >= 0)
    if (!wanting.length) break
    const share = Math.max(1, Math.floor(left / wanting.length))
    for (const i of wanting) {
      const give = Math.min(share, counts[i] - out[i], left)
      out[i] += give
      left -= give
    }
  }
  return out
}

/** The rows a compartment shows in `n` places: all of them, or the first n − 1 and a "+N more" line. */
export function shownRows(rows: readonly CardRow[], n: number): CardRow[] {
  if (rows.length <= n) return [...rows]
  const keep = Math.max(0, n - 1)
  return [...rows.slice(0, keep), { name: '', more: rows.length - keep }]
}

/** Size a card and choose its rows: within the limits, or every row when `all`. */
export function shapeCard(c: CardContent, limits: SizeLimits, all = false): CardShape {
  const marks = c.sections.some(s => s.some(r => r.key || r.tag)) ? CARD.markW : 0
  const signs = c.sections.some(s => s.some(r => r.sign)) ? CARD.signW : 0
  if (c.ghost) return { w: clamp(titleWidth(c), Math.min(limits.minW, 10), limits.maxW), h: CARD.ghost, band: CARD.ghost, sections: [], marks, signs }
  const counts = c.sections.map(s => s.length)
  const places = all ? counts : allot(counts, limits.rows)
  const band = c.over ? CARD.band2 : CARD.band
  let v = band
  const sections = c.sections.map((rows, i) => {
    const shown = shownRows(rows, places[i])
    const at = v
    v += shown.length * CARD.row + 2 * CARD.inset
    return { rows: shown, v: at }
  })
  const lead = marks + signs
  const w = Math.max(titleWidth(c), ...sections.flatMap(s => s.rows.map(r => rowWidth(r, c.detail, lead))))
  return { w: clamp(w, limits.minW, limits.maxW), h: Math.max(v, band + CARD.row), band, sections, marks, signs }
}

/** The middle of a row on the card (from its top), or undefined when the row isn't shown. */
export function rowMiddle(shape: CardShape, section: number, row: number): number | undefined {
  const s = shape.sections[section]
  if (!s || row >= s.rows.length || s.rows[row].more !== undefined) return undefined
  return s.v + CARD.inset + (row + 0.5) * CARD.row
}

function titleWidth(c: CardContent): number {
  const title = textWidth(c.title, c.italic ? 'italic' : 'title', CARD.titleEm) + (c.aside ? CARD.gap * 0.6 + textWidth(c.aside, 'text', CARD.smallEm) : 0)
  const over = c.over ? textWidth(c.over, 'text', CARD.smallEm) : 0
  return 2 * CARD.pad + Math.max(title, over)
}

function rowWidth(r: CardRow, detail: CardContent['detail'], lead: number): number {
  if (r.more !== undefined) return 2 * CARD.pad + textWidth(moreText(r.more), 'italic', CARD.nameEm)
  const name = textWidth(r.name, r.italic ? 'italic' : 'text', CARD.nameEm)
  const rest = r.detail ? (detail === 'right' ? CARD.gap : 0.15) + textWidth(r.detail, 'mono', CARD.detailEm) : 0
  return 2 * CARD.pad + lead + name + rest
}

export const moreText = (n: number) => `+${n} more`

/** A card's title as it fits its width (the drawing measures again and may shorten further). */
export const fittedTitle = (c: CardContent, w: number) => fitText(c.title, c.italic ? 'italic' : 'title', CARD.titleEm, w - 2 * CARD.pad)

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
