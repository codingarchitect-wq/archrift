// The static flavor of the viewer, for `archrift export html`: one HTML file
// with every script, style and worker inside, which a browser opens from disk
// with no server and no network. `npm run build` makes it with
//
//   vite build --mode static        → dist/static/index.html (the template)
//   vite build --mode highlighter   → dist/static/highlight.js (shiki, embedded with --source)
//
// and the CLI writes a project's graph into a copy of the template
// (src/cli/export-html.ts). Three plugins make the build fit in one file:
// - `.static.ts` siblings replace their module (api.static.ts answers from the
//   page's data instead of the server; highlight.static.ts leaves shiki out),
// - workers are inlined as blobs: a page from disk may start a classic worker
//   from a blob, though not a module worker nor a file next to it,
// - the bundle's script and style are written into index.html.
import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { Plugin, UserConfig } from 'vite'
import { EMBED_MARK } from './src/server/embed.ts'

const VIEWER = path.resolve(import.meta.dirname, 'src/viewer')
export const STATIC_DIR = path.resolve(import.meta.dirname, 'dist/static')

/** A viewer module with a `<name>.static.ts` beside it is replaced by that one (except in the sibling itself). */
function staticSiblings(): Plugin {
  return {
    name: 'archrift-static-siblings',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.includes('?')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved || resolved.external || !resolved.id.startsWith(VIEWER + path.sep)) return null
      const sibling = resolved.id.replace(/\.tsx?$/, '.static.ts')
      return sibling !== resolved.id && sibling !== importer && fs.existsSync(sibling) ? sibling : null
    },
  }
}

const WORKER = /\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)\s*,?\s*/g

/**
 * `new Worker(new URL('./x.worker.ts', import.meta.url), …)` becomes Vite's
 * inline worker (`./x.worker.ts?worker&inline`): the worker's code travels in
 * the bundle and starts from a blob. Any view's worker written that way is
 * carried, with no list to keep.
 */
function inlineWorkers(): Plugin {
  return {
    name: 'archrift-inline-workers',
    enforce: 'pre',
    transform(code, id) {
      if (!id.startsWith(VIEWER + path.sep) || !code.includes('new Worker')) return null
      const imports: string[] = []
      const out = code.replace(WORKER, (_match, _quote: string, file: string) => {
        const name = `__archriftWorker${imports.length}`
        imports.push(`import ${name} from ${JSON.stringify(`${file}?worker&inline`)}`)
        return `new ${name}(`
      })
      return imports.length ? { code: `${imports.join('\n')}\n${out}`, map: null } : null
    },
  }
}

/** Scripts end at `</script` and comments open at `<!--`, even inside a string: written with an escape instead. */
const inlineScript = (code: string) => code.replace(/<(\/script|!--)/gi, '\\x3C$1')

/** The bundle's one script and one style, written into index.html; the template's mark for the data before </body>. */
function singleFile(): Plugin {
  return {
    name: 'archrift-single-file',
    enforce: 'post',
    transformIndexHtml: html => html.replace('</body>', `${EMBED_MARK}\n  </body>`),
    // last: Vite finishes the chunks in its own generateBundle (the dynamic imports' preload lists)
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const html = bundle['index.html']
        if (html?.type !== 'asset') throw new Error('static build: no index.html in the bundle')
        let page = String(html.source)
        for (const [name, file] of Object.entries(bundle)) {
          if (name === 'index.html') continue
          const ref = new RegExp(`<(script|link)\\b[^>]*\\b(?:src|href)="\\./${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>(?:</script>)?`)
          if (!ref.test(page)) throw new Error(`static build: ${name} isn't referenced by index.html, so the page would miss it`)
          const inline = file.type === 'chunk' ? `<script type="module">${inlineScript(file.code)}</script>` : `<style>${String(file.source)}</style>`
          page = page.replace(ref, () => inline)
          delete bundle[name]
        }
        html.source = page
      },
    },
  }
}

export function staticConfig(): UserConfig {
  return {
    root: 'src/viewer',
    base: './',
    build: {
      outDir: STATIC_DIR,
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
      cssCodeSplit: false,
      modulePreload: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rolldownOptions: { output: { codeSplitting: false } },
    },
    // classic workers: a module worker from a blob doesn't start in a page opened from disk
    worker: { format: 'iife' },
    plugins: [staticSiblings(), inlineWorkers(), react(), singleFile()],
  }
}

/** shiki and the grammars highlight.ts loads, as one self-contained ES module. */
export function highlighterConfig(): UserConfig {
  return {
    build: {
      outDir: STATIC_DIR,
      emptyOutDir: false,
      lib: { entry: path.join(VIEWER, 'ui/highlight.ts'), formats: ['es'], fileName: () => 'highlight.js' },
      // a library keeps its whitespace by default; this one is only ever embedded
      rolldownOptions: { output: { codeSplitting: false, minify: true } },
    },
  }
}
