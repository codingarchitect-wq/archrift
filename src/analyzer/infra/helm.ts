// Helm templates, read leniently: not a Go template engine, just enough to
// see the resources a chart renders. Control actions (if, range, define, end)
// drop out with the lines they stand on; both branches of an `if` stay (the
// YAML reader keeps the last of a duplicate key). `.Chart.Name`,
// `.Chart.Version` and `.Values.x` scalars from the chart's values.yaml are
// filled in; anything else becomes `…`. Line numbers never change, so
// positions in the rendered text are positions in the file.

export interface HelmContext {
  chart?: { name: string; version: string }
  values: Record<string, string | number | boolean>
}

export interface HelmInclude {
  name: string
  line: number
  col: number
  /** On a line of its own: it renders the named template's resources there. */
  standalone: boolean
}

export interface Rendered {
  text: string
  includes: HelmInclude[]
  complexity: number
}

interface Action {
  start: number
  end: number
  body: string
}

const BLOCK = /^(if|range|with|define|block)\b/
const CONTROL = /^(if|else|end|range|with|define|block|break|continue|template|include|\$[\w]*\s*:?=)/

/** Comments (`{{/* … *\/}}`) become blanks, newlines kept. */
function blankComments(text: string): string {
  return text.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, m => m.replace(/[^\n]/g, ' '))
}

function actionsOf(text: string): Action[] {
  const out: Action[] = []
  let pos = 0
  for (;;) {
    const start = text.indexOf('{{', pos)
    if (start < 0) break
    const close = text.indexOf('}}', start + 2)
    const end = close < 0 ? text.length : close + 2
    out.push({ start, end, body: text.slice(start + 2, close < 0 ? text.length : close).replace(/^-\s*|\s*-$/g, '').trim() })
    pos = end
  }
  return out
}

/** Named templates: `{{ define "x" }}…{{ end }}`, with their bodies' offsets. */
export function findDefines(raw: string): { name: string; start: number; end: number; at: number }[] {
  const text = blankComments(raw)
  const out: { name: string; start: number; end: number; at: number }[] = []
  const stack: { kind: string; name?: string; bodyStart: number; at: number }[] = []
  for (const a of actionsOf(text)) {
    const m = BLOCK.exec(a.body)
    if (m) {
      const name = m[1] === 'define' ? /^define\s+"([^"]+)"/.exec(a.body)?.[1] : undefined
      stack.push({ kind: m[1], name, bodyStart: a.end, at: a.start })
    } else if (/^end\b/.test(a.body)) {
      const open = stack.pop()
      if (open?.kind === 'define' && open.name) out.push({ name: open.name, start: open.bodyStart, end: a.start, at: open.at })
    }
  }
  return out
}

/** Named templates a text includes (`include "x"`, `template "x"`), with where. */
export function includesOf(raw: string): { name: string; offset: number }[] {
  const out: { name: string; offset: number }[] = []
  for (const a of actionsOf(blankComments(raw))) {
    for (const m of a.body.matchAll(/\b(?:include|template)\s+"([^"]+)"/g)) out.push({ name: m[1], offset: a.start })
  }
  return out
}

/** The value of one action that isn't control: a field the context knows, else `…`. */
function evaluate(body: string, ctx: HelmContext): string {
  const field = /\$?\.(Chart|Values)((?:\.[\w-]+)+)/.exec(body)
  let value: string | undefined
  if (field) {
    const path = field[2].slice(1)
    if (field[1] === 'Chart') value = path === 'Name' ? ctx.chart?.name : path === 'Version' ? ctx.chart?.version : undefined
    else {
      const v = ctx.values[path]
      value = v === undefined ? undefined : String(v)
    }
  }
  if (value === undefined) {
    const fallback = /^default\s+"([^"]*)"/.exec(body) ?? (field ? undefined : /^"([^"]*)"$/.exec(body))
    if (fallback) value = fallback[1]
  }
  const quoted = /(^|\|\s*)s?quote\b|^s?quote\s/.test(body)
  const text = value ?? '…'
  return quoted ? JSON.stringify(text) : text
}

export function renderTemplate(raw: string, ctx: HelmContext): Rendered {
  const text = blankComments(raw)
  const actions = actionsOf(text)
  // lines on which nothing but actions stand
  const lineOf: number[] = []
  let line = 1
  for (let i = 0; i < text.length; i++) {
    lineOf.push(line)
    if (text.charCodeAt(i) === 10) line++
  }
  lineOf.push(line)
  const covered = new Uint8Array(text.length)
  for (const a of actions) covered.fill(1, a.start, a.end)
  const onlyActions = new Map<number, boolean>()
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') continue
    const l = lineOf[i]
    if (!onlyActions.has(l)) onlyActions.set(l, true)
    if (!covered[i] && c !== ' ' && c !== '\t' && c !== '\r') onlyActions.set(l, false)
  }

  const includes: HelmInclude[] = []
  let complexity = 1
  let out = ''
  let pos = 0
  let lineStart = 0
  for (const a of actions) {
    out += text.slice(pos, a.start)
    const startLine = lineOf[a.start]
    lineStart = text.lastIndexOf('\n', a.start - 1) + 1
    const standalone = onlyActions.get(startLine) === true
    if (/^(if|else|range|with)\b/.test(a.body)) complexity++
    const inc = /^(?:include|template)\s+"([^"]+)"/.exec(a.body.replace(/^\(\s*/, ''))
    for (const m of a.body.matchAll(/\b(?:include|template)\s+"([^"]+)"/g))
      includes.push({ name: m[1], line: startLine, col: a.start - lineStart + 1, standalone: standalone && inc?.[1] === m[1] })
    const newlines = text.slice(a.start, a.end).replace(/[^\n]/g, '')
    if (standalone || CONTROL.test(a.body) && !inc) out += newlines
    else out += (inc ? '…' : evaluate(a.body, ctx)) + newlines
    pos = a.end
  }
  out += text.slice(pos)
  // a line that held only actions is now blank: drop its whitespace so it doesn't break indentation
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i++) if (onlyActions.get(i + 1) && !lines[i].trim()) lines[i] = ''
  return { text: lines.join('\n'), includes, complexity }
}

/** A chart's values as `.Values` sees them: scalars by dotted key, list items by index. */
export function flattenValues(v: unknown, skip: (key: string) => boolean, prefix = '', out: Record<string, string | number | boolean> = {}) {
  if (Array.isArray(v)) v.forEach((x, i) => flattenValues(x, skip, `${prefix}${i}.`, out))
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) if (!skip(k)) flattenValues(x, skip, `${prefix}${k}.`, out)
  } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    const key = prefix.slice(0, -1)
    if (key && !(typeof v === 'string' && (v.includes('\n') || v.length > 200))) out[key] = v
  }
  return out
}
