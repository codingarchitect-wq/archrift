// `archrift init`'s report as one static page (`.archrift/first-look.html`): the
// same sections as the markdown, with three charts (function complexity by
// band, the hotspots, the bridges). No scripts or styles from elsewhere: it
// opens from the disk.
// Colors are the dataviz reference palette's roles, light and dark.
import type { FirstLook } from '../core/first-look.ts'
import { LIMITS } from '../core/first-look.ts'
import type { Commands } from './first-look.ts'
import { BRIDGES_ABOUT, QUESTIONS_ABOUT, agentBlock, blockCounts, usedBy } from './first-look.ts'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (x: number) => x.toLocaleString('en-US')
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`

const STYLE = `
:root { color-scheme: light; --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --base: #c3c2b7; --ring: rgba(11,11,11,0.10); --series: #2a78d6; --good: #0ca30c; --good-text: #006300; --warning: #fab219; --critical: #d03b3b; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --base: #383835; --ring: rgba(255,255,255,0.10); --series: #3987e5; --good-text: #0ca30c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 36px 0 10px; }
.sub { color: var(--ink-2); margin: 0 0 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; padding: 0; list-style: none; }
.chips li { border: 1px solid var(--ring); background: var(--surface); border-radius: 999px; padding: 2px 10px; font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 12px 14px; }
.tile b { display: block; font-size: 22px; } .tile span { color: var(--ink-2); font-size: 13px; }
.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 14px 16px; }
.note { border-left: 3px solid var(--warning); padding: 8px 12px; background: var(--surface); margin: 8px 0; border-radius: 0 6px 6px 0; }
.note b { margin-right: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code, pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 12px 14px; overflow-x: auto; white-space: pre-wrap; }
.layers { display: flex; flex-direction: column; gap: 6px; }
.layer { display: grid; grid-template-columns: 180px 1fr; gap: 10px; align-items: center; background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 8px 12px; }
.layer > b { font-size: 14px; } .blocks { display: flex; flex-wrap: wrap; gap: 6px; }
.block { border: 1px solid var(--base); border-radius: 6px; padding: 2px 8px; font-size: 13px; }
.block small { color: var(--ink-2); }
.down { color: var(--muted); font-size: 13px; margin: 2px 0 8px; }
.status { white-space: nowrap; } .status.held { color: var(--good-text); } .status.warn::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--warning); margin-right: 6px; }
.status.error::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--critical); margin-right: 6px; }
svg text { fill: var(--ink-2); font: 12px system-ui, -apple-system, "Segoe UI", sans-serif; }
svg .value { fill: var(--ink); font-weight: 600; } svg .muted { fill: var(--muted); }
svg .grid { stroke: var(--grid); stroke-width: 1; } svg .base { stroke: var(--base); stroke-width: 1; }
svg .limit { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 4 3; }
svg .bar { fill: var(--series); } svg .hit { fill: transparent; cursor: default; } svg .hit:focus { outline: none; }
svg g.mark:hover .bar, svg g.mark:focus-within .bar { opacity: 0.8; }
#tip { position: fixed; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12); padding: 6px 10px; font-size: 13px; display: none; max-width: 420px; }
#tip strong { display: block; }
footer { color: var(--muted); font-size: 13px; margin-top: 40px; }
.questions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; counter-reset: q; }
.questions li { counter-increment: q; background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 10px 14px 10px 44px; position: relative; }
.questions li::before { content: counter(q); position: absolute; left: 14px; top: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
.questions .q { font-weight: 600; } .questions .why { color: var(--ink-2); font-size: 14px; margin: 4px 0 0; }
.nowrap { white-space: nowrap; } .blocklist { font-size: 13px; white-space: nowrap; }
.kind { display: inline-block; border: 1px solid var(--base); border-radius: 999px; padding: 0 8px; margin-left: 6px; font-size: 12px; font-weight: 400; color: var(--ink-2); white-space: nowrap; }
`

/** Tooltips: each mark's data-tip (title line, then detail lines), drawn with textContent. */
const SCRIPT = `
const tip = document.getElementById('tip')
function show(el, x, y) {
  const lines = el.dataset.tip.split('\\n')
  tip.replaceChildren()
  const head = document.createElement('strong'); head.textContent = lines[0]; tip.append(head)
  for (const l of lines.slice(1)) { const d = document.createElement('div'); d.textContent = l; tip.append(d) }
  tip.style.display = 'block'
  const r = tip.getBoundingClientRect()
  tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + 'px'
  tip.style.top = Math.max(8, y - r.height - 10) + 'px'
}
for (const el of document.querySelectorAll('[data-tip]')) {
  el.addEventListener('pointermove', e => show(el, e.clientX, e.clientY))
  el.addEventListener('pointerleave', () => { tip.style.display = 'none' })
  el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); show(el, r.right, r.top) })
  el.addEventListener('blur', () => { tip.style.display = 'none' })
}
`

/** A bar with 4px-rounded data end, anchored square on its baseline. */
function barPath(x: number, y: number, w: number, h: number, horizontal: boolean): string {
  const r = Math.min(4, horizontal ? h / 2 : w / 2, horizontal ? w : h)
  if (h <= 0 || w <= 0) return ''
  if (horizontal) return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`
  return `M${x},${y + h}v${-(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`
}

/** Four round steps from 0 to at least `max` (0, 50, 100, 150, 200 for 175). */
function niceTicks(max: number): number[] {
  const rough = Math.max(max, 1) / 4
  const pow = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(v => v >= rough)!
  const top = Math.ceil(Math.max(max, 1) / step) * step
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
}

/** Functions per complexity band, the two limits marked between the bands. */
function bandsChart(f: FirstLook): string {
  const W = 640
  const H = 240
  const m = { top: 24, right: 16, bottom: 36, left: 44 }
  const bands = f.functions.bands
  const ticks = niceTicks(Math.max(...bands.map(b => b.count)))
  const max = ticks[ticks.length - 1]
  const iw = W - m.left - m.right
  const ih = H - m.top - m.bottom
  const slot = iw / bands.length
  const bw = Math.min(64, slot - 24)
  const y = (v: number) => m.top + ih - (v / max) * ih
  const out = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Functions by complexity band">`]
  for (const t of ticks) out.push(`<line class="${t ? 'grid' : 'base'}" x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${n(t)}</text>`)
  bands.forEach((b, i) => {
    const x = m.left + i * slot + (slot - bw) / 2
    const h = y(0) - y(b.count)
    const tip = `${n(b.count)} functions\ncomplexity ${b.label}`
    out.push(
      `<g class="mark"><path class="bar" d="${barPath(x, y(b.count), bw, h, false)}"/>`,
      `<rect class="hit" x="${m.left + i * slot}" y="${m.top}" width="${slot}" height="${ih}" tabindex="0" data-tip="${esc(tip)}"/></g>`,
      `<text class="value" x="${x + bw / 2}" y="${y(b.count) - 6}" text-anchor="middle">${n(b.count)}</text>`,
      `<text x="${x + bw / 2}" y="${H - m.bottom + 18}" text-anchor="middle">${esc(b.label)}</text>`,
    )
  })
  // the limits fall between bands: 10 after "5–9", 20 after "10–19"
  for (const [after, label] of [[1, `logic limit ${LIMITS.logic}`], [2, `UI limit ${LIMITS.ui}`]] as const) {
    const x = m.left + (after + 1) * slot
    out.push(`<line class="limit" x1="${x}" x2="${x}" y1="${m.top - 8}" y2="${y(0)}"/><text class="muted" x="${x + 4}" y="${m.top - 10}">${label}</text>`)
  }
  out.push(`<text class="muted" x="${m.left + iw / 2}" y="${H - 4}" text-anchor="middle">cyclomatic complexity</text></svg>`)
  return out.join('')
}

/** A ranking as horizontal bars, the longest first; the path names each, the tip tells its numbers. */
function rankChart(rows: readonly { path: string; value: number; tip: string }[], label: string): string {
  const W = 640
  const row = 26
  const m = { top: 4, right: 16, bottom: 4, left: 260 }
  const H = m.top + m.bottom + rows.length * row
  const max = Math.max(...rows.map(r => r.value))
  const iw = W - m.left - m.right
  const out = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}">`, `<line class="base" x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${H - m.bottom}"/>`]
  rows.forEach((r, i) => {
    const y = m.top + i * row + 4
    const w = Math.max(2, (r.value / max) * iw)
    const name = r.path.length > 38 ? `…${r.path.slice(-37)}` : r.path
    out.push(
      `<text x="${m.left - 8}" y="${y + row / 2 + 1}" text-anchor="end">${esc(name)}</text>`,
      `<g class="mark"><path class="bar" d="${barPath(m.left, y, w, row - 8, true)}"/>`,
      `<rect class="hit" x="0" y="${y - 3}" width="${W}" height="${row}" tabindex="0" data-tip="${esc(r.tip)}"/></g>`,
    )
  })
  out.push('</svg>')
  return out.join('')
}

/** The hotspots, longest bar the hottest. */
const hotspotChart = (f: FirstLook) =>
  rankChart(
    f.hotspots.map(r => ({ path: r.path, value: r.score, tip: `${r.path}\n${plural(r.commits, 'commit')} · ${n(r.churn)} lines changed lately\ncomplexity ${n(r.complexity)} · ${n(r.loc)} lines` })),
    'Hotspots',
  )

/** The bridges, longest bar the most paths through. */
const bridgeChart = (f: FirstLook) =>
  rankChart(
    f.bridges.map(b => ({
      path: b.path,
      value: b.score,
      tip: `${b.path}\nbetweenness ${b.score} · in ${b.block}\n${usedBy(b.fanIn)} · it uses ${n(b.fanOut)}\nused by ${blockCounts(b.above) || 'nothing'}\nuses ${blockCounts(b.below) || 'nothing'}`,
    })),
    'Bridges',
  )

/** One block and its count a line. */
const blockLines = (blocks: FirstLook['bridges'][number]['above']) => blocks.map(b => `${esc(b.block)} ${n(b.files)}`).join('<br>')

/** Text with `code` in backticks, escaped, the code set as code. */
const withCode = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')

function bridgesSection(f: FirstLook): string[] {
  if (!f.bridges.length) return []
  const s = ['<h2>Bridges</h2>', `<p class="down">${esc(BRIDGES_ABOUT[0].toUpperCase() + BRIDGES_ABOUT.slice(1))}. Betweenness is the share of the shortest dependency paths between two other files that run through one. Hover a bar for its blocks.</p>`]
  s.push(`<div class="card">${bridgeChart(f)}</div>`)
  s.push('<table><tr><th class="num">#</th><th>File</th><th>Block</th><th class="num">Betweenness</th><th class="num nowrap">Fan-in</th><th class="num nowrap">Fan-out</th><th>Used by</th><th>Uses</th></tr>')
  f.bridges.forEach((b, i) =>
    s.push(
      `<tr><td class="num">${i + 1}</td><td><code>${esc(b.path)}</code></td><td><code>${esc(b.block)}</code></td><td class="num">${b.score}</td><td class="num">${n(b.fanIn)}</td><td class="num">${n(b.fanOut)}</td><td class="blocklist">${blockLines(b.above)}</td><td class="blocklist">${blockLines(b.below)}</td></tr>`,
    ),
  )
  s.push('</table>')
  return s
}

function questionsSection(f: FirstLook): string[] {
  if (!f.questions.length) return []
  const items = f.questions.map(q => `<li><span class="q">${withCode(q.question)}</span><span class="kind">${esc(q.type)}</span><p class="why">${withCode(q.why)}</p></li>`)
  return ['<h2>Questions worth asking</h2>', `<p class="down">${esc(QUESTIONS_ABOUT[0].toUpperCase() + QUESTIONS_ABOUT.slice(1))}.</p>`, `<ol class="questions">${items.join('')}</ol>`]
}

const blockChip = (b: FirstLook['blocks'][number]) => `<span class="block"><code>${esc(b.path)}</code> <small>${plural(b.files, 'file')} · ${n(b.loc)} lines${b.ui ? ' · UI' : ''}</small></span>`

function statusCell(r: FirstLook['rules'][number]): string {
  if (!r.broken) return `<span class="status held">✓ held</span>`
  return `<span class="status ${r.severity}">${n(r.broken)} broken</span>`
}

export function firstLookHtml(f: FirstLook, c: Commands): string {
  const s: string[] = []
  const when = f.generatedAt.slice(0, 16).replace('T', ' ')
  s.push(`<h1>${esc(f.project)}: first look</h1>`, `<p class="sub">archrift init, ${esc(when)} UTC · <code>${esc(c.root)}</code></p>`)
  s.push(`<ul class="chips">${f.stack.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`)
  const tiles: [string, string][] = [
    [n(f.size.files), `files of code (${n(f.size.loc)} lines)`],
    [n(f.size.tests), 'test files'],
    [n(f.size.functions), 'functions'],
    ...(f.history ? ([[n(f.history.commits), `commits by ${plural(f.history.authors, 'author')} since ${f.history.since}`]] as [string, string][]) : []),
    [n(f.cycles.count), 'import cycles'],
    [n(f.deadExports.count), 'dead exports'],
  ]
  s.push(`<div class="tiles">${tiles.map(([v, l]) => `<div class="tile"><b>${v}</b><span>${esc(l)}</span></div>`).join('')}</div>`)
  for (const note of f.notes) s.push(`<div class="note"><b>Note</b>${esc(note)}</div>`)
  const configText = f.config.status === 'written' ? `Wrote <code>${esc(f.config.path)}</code>: every line of it is a guess from this first look, made to be edited.` : f.config.status === 'kept' ? `Kept <code>${esc(f.config.path)}</code> as it was.` : 'A dry run: nothing written.'
  s.push(`<p>${configText}</p>`)

  if (f.excluded.length || f.vendored.length) {
    s.push('<h2>Left out of the analysis</h2><table><tr><th>Files</th><th>Why</th></tr>')
    for (const e of f.excluded) s.push(`<tr><td><code>${esc(e.glob)}</code></td><td>${esc(e.why)}</td></tr>`)
    for (const v of f.vendored) s.push(`<tr><td><code>${esc(v.glob)}</code></td><td>${esc(v.what)}: analyzed, held to no limit</td></tr>`)
    s.push('</table>')
  }
  if (f.layers.length) {
    s.push('<h2>Layers</h2><p class="down">Top to bottom: each block imports only from its own level or below, as the code does today. The rule <code>layers-point-down</code> keeps it so.</p><div class="layers">')
    for (const l of f.layers) s.push(`<div class="layer"><b>${esc(l.name)}</b><div class="blocks">${l.blocks.map(blockChip).join('')}</div></div>`)
    s.push('</div>')
  }
  if (f.blocks.length) {
    s.push(`<h2>${f.layers.length ? 'Blocks in no layer' : 'Blocks'}</h2>`)
    if (!f.layers.length) s.push('<p class="down">No layering: the blocks import each other in a circle, or not at all.</p>')
    s.push(`<div class="blocks">${f.blocks.map(blockChip).join('')}</div>`)
  }

  s.push('<h2>Import cycles</h2>', `<p>${f.cycles.count ? `${plural(f.cycles.count, 'cycle')}; the largest:` : 'None.'}</p>`)
  for (const cy of f.cycles.largest) s.push(`<pre>${esc(`${plural(cy.length, 'file')}: ${cy.slice(0, 8).join(' → ')}${cy.length > 8 ? ' → …' : ''}`)}</pre>`)

  if (f.hotspots.length) {
    s.push('<h2>Hotspots</h2><p class="down">Lines changed lately × complexity: code that changes a lot and is hard to change. Hover a bar for its numbers.</p>')
    s.push(`<div class="card">${hotspotChart(f)}</div>`)
    s.push('<table><tr><th class="num">#</th><th>File</th><th class="num">Commits</th><th class="num">Lines changed lately</th><th class="num">Complexity</th><th class="num">Lines</th></tr>')
    f.hotspots.forEach((h, i) => s.push(`<tr><td class="num">${i + 1}</td><td><code>${esc(h.path)}</code></td><td class="num">${n(h.commits)}</td><td class="num">${n(h.churn)}</td><td class="num">${n(h.complexity)}</td><td class="num">${n(h.loc)}</td></tr>`))
    s.push('</table>')
  }
  s.push(...bridgesSection(f))

  if (f.coherence.mixed.length || f.coherence.one.length) {
    s.push('<h2>Jobs done several ways</h2>')
    if (!f.coherence.mixed.length) s.push('<p>None: each job is done one way.</p>')
    else {
      s.push('<table><tr><th>Job</th><th>Ways (files)</th><th>Mixed in</th></tr>')
      for (const m of f.coherence.mixed) s.push(`<tr><td>${esc(m.label)}</td><td>${esc(m.ways.map(w => `${w.label} ${n(w.files)}`).join(' · '))}</td><td>${m.blocks.map(b => `<code>${esc(b)}</code>`).join(', ')}</td></tr>`)
      s.push('</table>')
    }
    if (f.coherence.one.length) s.push(`<p class="down">Done one way: ${esc(f.coherence.one.map(o => `${o.label.replace(/^\w+ · /, '')} (${o.way}, ${plural(o.files, 'file')})`).join(' · '))}.</p>`)
  }

  s.push('<h2>Function complexity</h2>', `<p class="down">Functions per band of cyclomatic complexity. The starter rules hold logic under ${LIMITS.logic} and UI code under ${LIMITS.ui}.</p>`, `<div class="card">${bandsChart(f)}</div>`)
  if (f.functions.largest.length) {
    s.push('<table><tr><th class="num">#</th><th>Function</th><th>Where</th><th class="num">Complexity</th></tr>')
    f.functions.largest.forEach((fn, i) => s.push(`<tr><td class="num">${i + 1}</td><td>${esc(fn.name)}${fn.ui ? ' <small>(UI)</small>' : ''}</td><td><code>${esc(`${fn.path}:${fn.line}`)}</code></td><td class="num">${n(fn.complexity)}</td></tr>`))
    s.push('</table>')
  }

  s.push('<h2>Dead exports</h2>', `<p>${plural(f.deadExports.count, 'export')} nothing imports${f.deadExports.folders.length ? ':' : '.'}</p>`)
  if (f.deadExports.folders.length) s.push(`<ul>${f.deadExports.folders.map(d => `<li><code>${esc(d.folder)}</code> ${n(d.count)}${d.vendored ? ' (copied in)' : ''}</li>`).join('')}</ul>`)

  if (f.rules.length) {
    s.push('<h2>Rules</h2><p class="down">Every rule is an error: <code>check</code> fails until the code keeps it, and <code>diff</code> fails on a change that breaks it again or further.</p>')
    s.push('<table><tr><th>Rule</th><th>Severity</th><th>Today</th><th>What it says</th></tr>')
    for (const r of f.rules) s.push(`<tr><td><code>${esc(r.name)}</code></td><td>${r.severity}</td><td>${statusCell(r)}</td><td>${esc(r.description ?? '')}</td></tr>`)
    s.push('</table>')
  }
  s.push(...questionsSection(f))

  s.push('<h2>Next</h2><table>')
  const steps: [string, string][] = [
    [`${c.cli} serve ${c.root} --open`, 'the 3D viewer, with the arc42 views'],
    [`${c.cli} check ${c.root}`, 'every rule and every case that breaks it'],
    [`${c.cli} coherence ${c.root}`, 'how many ways the code does each job'],
    [`${c.cli} query file <path>`, 'one file at a glance (run in the project)'],
    [`${c.cli} diff`, 'what a change does, before finishing it (run in the project)'],
  ]
  for (const [cmd, what] of steps) s.push(`<tr><td><code>${esc(cmd)}</code></td><td>${esc(what)}</td></tr>`)
  s.push('</table>')
  s.push('<h2>For a coding agent</h2><p>Add to the project’s CLAUDE.md or AGENTS.md:</p>', `<pre>${esc(agentBlock(c.cli))}</pre>`)
  s.push(`<footer>archrift init · ${esc(when)} UTC · results in <code>.archrift/</code> (git ignores all of them but the config)</footer>`)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(f.project)}: first look (archrift)</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${s.join('\n')}
</main>
<div id="tip" role="tooltip"></div>
<script>${SCRIPT}</script>
</body>
</html>
`
}
