// Shell scripts, read line by line: functions become symbols; the topics
// `kafka-topics --create` makes and the databases `CREATE DATABASE` makes in a
// database client's heredoc become facts; scripts and files the script runs
// or hands to a tool (`./up.sh`, `source lib.sh`, `helm … -f values.yaml`)
// become references, resolved against the files the reader has in pass B.
// `cd` is followed, so `cd ../kafka && ./up.sh` finds kafka/up.sh. Values of
// variables are never read.
import path from 'node:path'
import { symbolId } from '../../core/ids.ts'
import type { DatastoreFact } from '../plugins/datastore-facts.ts'
import type { MessagingFact } from '../plugins/messaging-facts.ts'
import { countLoc, parseYaml } from './common.ts'
import { addResource, isResource } from './k8s.ts'
import { createdDatabases } from './sql.ts'
import type { InfraDecl, InfraFile } from './model.ts'

/** The database client a command runs, and so the engine of the SQL it is handed. */
const CLIENTS: [RegExp, string][] = [
  [/(^|[\s/;(|&])(mysql|mariadb)(\s|$)/, 'mysql'],
  [/(^|[\s/;(|&])psql(\s|$)/, 'postgres'],
  [/(^|[\s/;(|&])(mongosh|mongo)(\s|$)/, 'mongodb'],
]
const BRANCH = /(^|[\s;(])(if|elif|for|while|until|case)\s|&&|\|\|/g
/** A path the script names: a script, a manifest, a values file, SQL. */
const PATH_TOKEN = /(?:^|[\s;&|(=<>"'`])((?:"?\$(?:\{\w+\}|\w+|\([^)]*\))"?\/)?[\w.@/-]*[\w@-]\.(?:sh|bash|ya?ml|sql|tpl))(?=$|[\s;&|)"'`<>])/g
/** A path's leading variable (`$SCRIPT_DIR/`, `$(dirname "$0")/`): the script's own folder, or the repository's top. */
const VARIABLE_PREFIX = /^"?\$(?:\{\w+\}|\w+|\([^)]*\))"?\//
const FUNCTION = /^\s*(?:function\s+([A-Za-z_][\w:.-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w:.-]*)\s*\(\s*\))\s*(\{.*)?$/

/** A command line, continuations joined, and the line it starts on. */
interface Logical {
  text: string
  line: number
}

/** Cuts a comment off a line: a `#` that starts a word, outside quotes. */
function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '\\') i++
    else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** `roots`: the folders a path may be relative to besides the script's own ('' for the root, a mount's name). */
export function readShell(file: InfraFile, text: string, roots: readonly string[]): void {
  const raw = text.split('\n')
  const dir = path.posix.dirname(file.path)
  const fileOwner = `f:${file.path}`

  // functions: from their header to the closing brace at their indentation
  const fns: { name: string; start: number; end: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const m = FUNCTION.exec(stripComment(raw[i]).trimEnd())
    if (!m) continue
    const name = m[1] ?? m[2]
    if (['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac'].includes(name)) continue
    const indent = /^\s*/.exec(raw[i])![0].length
    const rest = m[3] ?? ''
    let end = i
    if (!(rest.includes('}') && rest.lastIndexOf('}') > rest.indexOf('{'))) {
      end = raw.length - 1
      for (let j = i + 1; j < raw.length; j++) {
        const t = raw[j]
        if (/^\s*\}\s*(;.*|\s*#.*|[<>|&].*)?$/.test(t) && /^\s*/.exec(t)![0].length <= indent) {
          end = j
          break
        }
      }
    }
    if (!fns.some(f => f.name === name)) fns.push({ name, start: i + 1, end: end + 1 })
  }
  for (const f of fns) {
    const id = symbolId(file.path, f.name)
    const body = raw.slice(f.start - 1, f.end).join('\n')
    const decl: InfraDecl = {
      id,
      kind: 'symbol',
      name: f.name,
      subkind: 'function',
      parent: fileOwner,
      range: [f.start, 1, f.end, raw[f.end - 1].length + 1],
      signature: `${f.name}()`,
      tags: [],
      loc: countLoc(body),
      complexity: 1 + (body.match(BRANCH)?.length ?? 0),
    }
    file.decls.push(decl)
  }
  // the innermost function a line is in
  const ownerAt = (line: number) => {
    let best: { name: string; start: number; end: number } | undefined
    for (const f of fns) if (line >= f.start && line <= f.end && (!best || f.start >= best.start)) best = f
    return best ? symbolId(file.path, best.name) : fileOwner
  }

  // logical lines: continuations joined, comments and heredoc bodies apart
  const logical: Logical[] = []
  const heredocs: { owner: string; engine?: string; manifest: boolean; body: string; line: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const first = i
    let line = stripComment(raw[i])
    while (/\\\s*$/.test(line) && i + 1 < raw.length) {
      line = line.replace(/\\\s*$/, ' ') + stripComment(raw[++i]).trimStart()
    }
    if (!line.trim()) continue
    logical.push({ text: line, line: first + 1 })
    const here = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(line)
    if (here && !line.includes('<<<')) {
      const delimiter = here[3]
      const strip = here[1] === '-'
      const start = i + 1
      let j = i + 1
      while (j < raw.length && (strip ? raw[j].trim() : raw[j].replace(/\r$/, '')) !== delimiter) j++
      const engine = CLIENTS.find(([re]) => re.test(line))?.[1]
      const manifest = /\bkubectl\b[^|;&]*\b(apply|create|replace)\b/.test(line)
      heredocs.push({ owner: ownerAt(first + 1), engine, manifest, body: raw.slice(start, j).join('\n'), line: start + 1 })
      i = j
    }
  }

  // commands, in order, following cd
  let cwd = dir
  const base = (p: string) => path.posix.normalize(path.posix.join(cwd, p))
  for (const l of logical) {
    const owner = ownerAt(l.line)
    const subshell = l.text.trimStart().startsWith('(')
    const before = cwd
    // a client handed SQL inline: mysql -e "CREATE DATABASE x"
    const engine = CLIENTS.find(([re]) => re.test(l.text))?.[1]
    if (engine) for (const db of createdDatabases(l.text, engine)) addDatabase(file, owner, engine, db.name, l.line, db.offset + 1)
    for (const segment of l.text.split(/&&|\|\||;|\|/)) {
      const cmd = segment.trim().replace(/^\(\s*/, '')
      const cd = /^cd(?:\s+(.*))?$/.exec(cmd)
      if (cd) {
        const target = (cd[1] ?? '').trim().replace(/^["']|["']$/g, '')
        if (!target || target === '~' || target.startsWith('$') || target.startsWith('/') || target === '-') cwd = dir
        else cwd = base(target)
        continue
      }
      // kafka-topics.sh --create --topic x (in any order, also through kubectl exec)
      if (/kafka-topics(\.sh)?\b/.test(cmd) && /\s--create\b/.test(cmd)) {
        const topic = /\s--topic(?:\s+|=)(["']?)([^\s"';]+)\1/.exec(cmd)
        // a topic only a variable names (a helper's "$1") says nothing
        if (topic && !/^\$\{?\w+\}?$/.test(topic[2])) {
          const col = l.text.indexOf(topic[2]) + 1
          const fact: MessagingFact = { type: 'declare', owner, topics: [topic[2]], module: '', site: [l.line, Math.max(1, col)] }
          ;(file.facts.messaging ??= []).push(fact)
        }
      }
      // paths the command names
      for (const m of cmd.matchAll(PATH_TOKEN)) {
        const token = m[1]
        if (/^kafka-(topics|acls|configs|console-\w+)\.sh$/.test(token)) continue
        const rel = token.replace(VARIABLE_PREFIX, '')
        const named = rel !== token
        const candidates = [base(rel), path.posix.normalize(path.posix.join(dir, rel))]
        // a path from a variable or the repository's top (`k8s/kafka/up.sh`): also try it from the root
        if (named || !rel.startsWith('.')) candidates.push(...roots.map(r => path.posix.normalize(path.posix.join(r, rel))))
        const paths = [...new Set(candidates)].filter(p => !p.startsWith('..') && p !== file.path)
        if (!paths.length) continue
        const col = l.text.indexOf(token) + 1
        file.refs.push({ source: owner, target: { to: 'file', paths }, subkind: /\.(sh|bash)$/.test(token) ? 'runs' : 'uses', line: l.line, col: Math.max(1, col) })
      }
    }
    if (subshell) cwd = before
  }

  for (const h of heredocs) {
    // manifests handed to kubectl: `cat <<EOF | kubectl apply -f -`
    if (h.manifest)
      for (const doc of parseYaml(h.body).docs)
        if (isResource(doc.value)) addResource({ file, text: h.body, lineOffset: h.line - 1 }, doc.value, doc.range, [doc.start, doc.end])
    if (!h.engine) continue
    for (const db of createdDatabases(h.body, h.engine)) {
      const lines = h.body.slice(0, db.offset).split('\n')
      addDatabase(file, h.owner, h.engine, db.name, h.line + lines.length - 1, lines.at(-1)!.length + 1)
    }
  }
  if (file.resources?.length) file.tags.push('k8s')
  file.complexity = 1 + (logical.map(l => l.text).join('\n').match(BRANCH)?.length ?? 0)
}

function addDatabase(file: InfraFile, owner: string, engine: string, name: string, line: number, col: number) {
  const fact: DatastoreFact = { type: 'declare', owner, engine, name, module: '', site: [line, Math.max(1, col)] }
  ;(file.facts.datastore ??= []).push(fact)
}
