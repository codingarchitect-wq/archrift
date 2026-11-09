// Reading what an exported page carries (src/server/embed.ts): the meta at
// once, the graph and the source when first asked for. Only web APIs that Node
// has too (atob, Blob, DecompressionStream), so tests read a page's parts the
// way the browser does.
import { decodeGraph } from '../../core/serialize.ts'
import { EMBED } from '../../server/embed.ts'
import type { EmbedPart, ExportGraph, ExportMeta } from '../../server/embed.ts'
import type { SavedView } from '../api.ts'
import type { StaticData } from './backend.ts'

/** A part's text by its name: the element's content in a page. */
export type PartReader = (part: EmbedPart) => string | undefined

export const pagePart = (doc: Pick<Document, 'getElementById'>): PartReader => part => doc.getElementById(EMBED[part])?.textContent?.trim() || undefined

/** Bytes from base64 (Uint8Array.fromBase64 where the browser has it: much faster on megabytes). */
function fromBase64(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (native) return native(base64)
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** A part's gzipped, base64-encoded text, decompressed. */
export async function gunzipBase64(base64: string): Promise<string> {
  const stream = new Blob([fromBase64(base64) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

/** The page's meta, and its data for the static backend; throws when the page carries no graph (not an export). */
export function readExport(read: PartReader): { meta: ExportMeta; data: StaticData } {
  const metaText = read('meta')
  const graphText = read('graph')
  if (!metaText || !graphText) throw new Error('this page carries no graph: make one with `archrift export html`')
  const meta = JSON.parse(metaText) as ExportMeta
  const sourceText = read('source')
  return {
    meta,
    data: {
      info: meta.info,
      views: meta.views as unknown as SavedView[],
      ...(meta.descriptions ? { descriptions: meta.descriptions } : {}),
      graph: async () => {
        const { graph, sites } = JSON.parse(await gunzipBase64(graphText)) as ExportGraph
        return decodeGraph(graph, sites)
      },
      ...(sourceText ? { sources: async () => JSON.parse(await gunzipBase64(sourceText)) as Record<string, string> } : {}),
    },
  }
}

/**
 * The view the export was made on: the page's link until the reader moves on
 * (a reload then keeps where they were, as on a server).
 */
export function openAtStart(start: string, loc: Pick<Location, 'pathname' | 'search' | 'hash'> = location, history: Pick<History, 'replaceState'> = window.history) {
  if (!start || loc.search || loc.hash) return
  history.replaceState(null, '', loc.pathname + start)
}

/** An embedded ES module (the highlighter), imported from a blob: a page from disk may import those. */
export async function importPart<T>(read: PartReader, part: EmbedPart): Promise<T | undefined> {
  const base64 = read(part)
  if (!base64) return undefined
  const url = URL.createObjectURL(new Blob([await gunzipBase64(base64)], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)) as T
  } finally {
    URL.revokeObjectURL(url)
  }
}
