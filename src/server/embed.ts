// What an exported page (`archrift export html`) carries, and where: the CLI
// writes these parts into the static viewer's template, the page reads them
// back (src/viewer/api.static.ts). Pure: no Node or DOM APIs, so both sides
// share it.
//
// Each part is a <script> element the browser doesn't run: the page's meta as
// JSON, the rest gzipped and base64-encoded (a graph of 5 MB of JSON takes
// about 1 MB that way), decompressed in the browser with DecompressionStream.
import type { ResolvedDescriptions } from '../core/descriptions.ts'
import type { SerializedGraph, SerializedSites } from '../core/serialize.ts'
import type { Info } from './views.ts'

/** The template's mark where the parts go (vite.static.ts puts it before </body>). */
export const EMBED_MARK = '<!--archrift:embed-->'

/** The elements' ids. */
export const EMBED = {
  /** ExportMeta, as JSON. */
  meta: 'archrift-meta',
  /** ExportGraph, gzipped. */
  graph: 'archrift-graph',
  /** The files' text (path → text), gzipped; only with --source. */
  source: 'archrift-source',
  /** The syntax highlighter (an ES module, dist/static/highlight.js), gzipped; only with --source. */
  highlighter: 'archrift-highlighter',
} as const

export type EmbedPart = keyof typeof EMBED

/** A saved view, as the server lists them. */
export interface EmbeddedView {
  name: string
  state: Record<string, unknown>
}

export interface ExportMeta {
  /** What /api/info would answer (without the local folders: the file gets shared). */
  info: Info
  /** The project's saved views, to open (not to change). */
  views: EmbeddedView[]
  /** The link the page opens on until the reader moves: a query (`?view=wheel`) and a hash (`#n=<id>`). */
  start: string
  /** The names and descriptions written for the code (`archrift describe`), when there are any. */
  descriptions?: ResolvedDescriptions
  exportedAt: string
}

/** The whole graph, as `archrift analyze` writes it (graph.json and graph.sites.json). */
export interface ExportGraph {
  graph: SerializedGraph
  sites: SerializedSites
}

/** The script elements for the parts given: meta as JSON, the others already compressed and base64-encoded. */
export function embedTags(meta: ExportMeta, parts: Partial<Record<Exclude<EmbedPart, 'meta'>, string>>): string {
  const tags = [`<script type="application/json" id="${EMBED.meta}">${scriptJson(meta)}</script>`]
  for (const [part, base64] of Object.entries(parts)) {
    if (base64) tags.push(`<script type="application/octet-stream" id="${EMBED[part as EmbedPart]}">${base64}</script>`)
  }
  return tags.join('\n')
}

/** The source panel's message in a page exported without --source. */
export const NO_SOURCE = "The source isn't in this export: `archrift export html --source` puts it in."

/** JSON that can't end its <script> element or open a comment in it: `<` is written as its escape. */
export const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
