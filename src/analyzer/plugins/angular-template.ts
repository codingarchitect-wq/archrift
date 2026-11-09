// Angular templates without an HTML parser (the Angular plugin, POLYGLOT P2):
// a tolerant scanner finds the elements with their attributes and the pipes
// a template uses, and component and directive selectors are matched against
// those elements the way Angular matches them: element name, attributes
// (bound ones too) and classes, with `:not(…)` parts ignored.

export interface TemplateAttribute {
  /** The name with the binding syntax stripped: `[x]`, `(x)`, `[(x)]`, `*x` and `bind-x` → x. */
  name: string
  binding: 'static' | 'property' | 'event' | 'two-way' | 'structural'
  value?: string
}

export interface TemplateElement {
  name: string
  attrs: TemplateAttribute[]
  classes: string[]
}

export interface ScannedTemplate {
  elements: TemplateElement[]
  /** Pipe names in the order of their first use. */
  pipes: string[]
}

/** One comma-separated part of a selector: `button[ss-button]` → element button, attribute ss-button. */
export interface SimpleSelector {
  element?: string
  attrs: string[]
  classes: string[]
}

/** The name an attribute matches selectors under, and how it's bound; undefined for template references (`#x`, `ref-x`) and variables (`let-x`). */
export function attributeName(raw: string): Pick<TemplateAttribute, 'name' | 'binding'> | undefined {
  if (/^(#|ref-|let-)/.test(raw)) return undefined
  if (raw.startsWith('[(') && raw.endsWith(')]')) return { name: raw.slice(2, -2), binding: 'two-way' }
  if (raw.startsWith('[') && raw.endsWith(']')) return { name: raw.slice(1, -1), binding: 'property' }
  if (raw.startsWith('(') && raw.endsWith(')')) return { name: raw.slice(1, -1), binding: 'event' }
  if (raw.startsWith('*')) return { name: raw.slice(1), binding: 'structural' }
  const prefixed = /^(bindon|bind|on)-(.+)$/.exec(raw)
  if (prefixed) return { name: prefixed[2], binding: prefixed[1] === 'on' ? 'event' : prefixed[1] === 'bind' ? 'property' : 'two-way' }
  return { name: raw, binding: 'static' }
}

/** Names after a `|` that isn't `||`, outside string literals: `a | date:'short' | translate` → date, translate. */
export function pipesIn(expression: string): string[] {
  const code = expression.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
  return [...code.matchAll(/(?<!\|)\|(?!\|)\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1])
}

export function scanTemplate(text: string): ScannedTemplate {
  const source = text.replace(/<!--[\s\S]*?-->/g, '')
  const elements: TemplateElement[] = []
  const pipes = new Set<string>()
  const addPipes = (expression: string) => pipesIn(expression).forEach(p => pipes.add(p))
  for (const m of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) addPipes(m[1])

  let i = 0
  while ((i = source.indexOf('<', i)) >= 0) {
    const tag = /^<([A-Za-z][\w.:-]*)/.exec(source.slice(i, i + 200))
    if (!tag) {
      i++
      continue
    }
    const el: TemplateElement = { name: tag[1].toLowerCase(), attrs: [], classes: [] }
    i += tag[0].length
    // attributes up to `>` or `/>`; quoted values may hold anything, `>` included
    while (i < source.length) {
      while (/\s/.test(source[i] ?? '')) i++
      if (i >= source.length || source[i] === '>') break
      if (source.startsWith('/>', i)) {
        i++
        break
      }
      const name = /^[^\s=>]+/.exec(source.slice(i, i + 200))?.[0] ?? source[i]
      i += name.length
      let j = i
      while (/\s/.test(source[j] ?? '')) j++
      let value: string | undefined
      if (source[j] === '=') {
        j++
        while (/\s/.test(source[j] ?? '')) j++
        const quote = source[j]
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, j + 1)
          value = source.slice(j + 1, end < 0 ? source.length : end)
          i = end < 0 ? source.length : end + 1
        } else {
          value = /^[^\s>]*/.exec(source.slice(j))![0]
          i = j + value.length
        }
      }
      const attr = attributeName(name.replace(/\/$/, ''))
      if (!attr) continue
      el.attrs.push(value === undefined ? attr : { ...attr, value })
      if (attr.binding === 'static' && attr.name === 'class' && value) el.classes.push(...value.split(/\s+/).filter(Boolean))
      if (value && (attr.binding === 'property' || attr.binding === 'two-way' || attr.binding === 'structural')) addPipes(value)
    }
    elements.push(el)
  }
  return { elements, pipes: [...pipes] }
}

/** The simple selectors of a selector list, `:not(…)` parts dropped: `ss-x, [ssX]` → two. */
export function parseSelector(selector: string): SimpleSelector[] {
  const out: SimpleSelector[] = []
  for (const raw of selector.split(/,(?![^(]*\))/)) {
    let s = raw.replace(/:not\([^)]*\)/g, '').trim()
    const attrs: string[] = []
    s = s.replace(/\[\s*([^\]=~|^$*\s]+)[^\]]*\]/g, (_, name: string) => (attrs.push(name), ''))
    const classes = [...s.matchAll(/\.([\w-]+)/g)].map(m => m[1])
    const element = /^[A-Za-z][\w-]*/.exec(s)?.[0].toLowerCase()
    if (element || attrs.length || classes.length) out.push({ ...(element ? { element } : {}), attrs, classes })
  }
  return out
}

/** Does an element match a simple selector? */
export function matchesSelector(sel: SimpleSelector, el: TemplateElement): boolean {
  if (sel.element && sel.element !== el.name) return false
  return sel.attrs.every(a => el.attrs.some(x => x.name === a)) && sel.classes.every(c => el.classes.includes(c))
}

/** A simple selector as text, the key under which declarations of the same selector are told apart. */
export function selectorKey(sel: SimpleSelector): string {
  return `${sel.element ?? ''}${sel.attrs.map(a => `[${a}]`).join('')}${sel.classes.map(c => `.${c}`).join('')}`
}
