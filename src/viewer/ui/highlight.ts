// Syntax highlighting for the source preview: Shiki with the JavaScript regex
// engine (no WASM) and the grammars of the languages archrift reads (TS/JS,
// Kotlin, Go, Avro's JSON) and of the files around them (templates, styles,
// YAML, shell, SQL), loaded on first use.
import { createHighlighterCore } from 'shiki/core'
import type { HighlighterCore, ThemedToken } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

let instance: Promise<HighlighterCore> | undefined

function highlighter() {
  instance ??= createHighlighterCore({
    themes: [import('shiki/themes/github-dark-default.mjs'), import('shiki/themes/github-light-default.mjs')],
    langs: [
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/tsx.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/jsx.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/scss.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/kotlin.mjs'),
      import('shiki/langs/go.mjs'),
      import('shiki/langs/yaml.mjs'),
      import('shiki/langs/shellscript.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/langs/docker.mjs'),
    ],
    engine: createJavaScriptRegexEngine(),
  })
  return instance
}

const LANGS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  avsc: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  kt: 'kotlin',
  kts: 'kotlin',
  go: 'go',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shellscript',
  bash: 'shellscript',
  sql: 'sql',
}

/** Tokens per line, or undefined for a language we don't highlight. */
export async function tokenize(path: string, code: string, dark: boolean): Promise<ThemedToken[][] | undefined> {
  const lang = /(^|\/)Dockerfile[^/]*$/.test(path) ? 'docker' : LANGS[path.slice(path.lastIndexOf('.') + 1)]
  if (!lang) return undefined
  const h = await highlighter()
  return h.codeToTokensBase(code, { lang, theme: dark ? 'github-dark-default' : 'github-light-default' })
}
