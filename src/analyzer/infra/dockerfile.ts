// Dockerfiles: each build stage (`FROM image [AS name]`) is a symbol tagged
// with the image it starts from; a stage built on an earlier one, or copying
// from it (`COPY --from=build`), uses it. The file carries the images too.
import { symbolId } from '../../core/ids.ts'
import { countLoc, imageName } from './common.ts'
import type { InfraDecl, InfraFile } from './model.ts'

export function readDockerfile(file: InfraFile, text: string): void {
  const raw = text.split('\n')
  const stages: { decl: InfraDecl; alias?: string }[] = []
  // a stage by its name, or by its index (`COPY --from=0`)
  const stage = (ref: string) => stages.find((s, i) => s.alias === ref || String(i) === ref)
  const images = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const first = i
    let line = raw[i]
    if (/^\s*#/.test(line)) continue
    while (/\\\s*$/.test(line) && i + 1 < raw.length) line = line.replace(/\\\s*$/, ' ') + raw[++i].trim()
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+([\w.-]+))?/i.exec(line)
    if (from) {
      const [, image, alias] = from
      const base = stage(image)
      // an unnamed stage by its index, as `COPY --from=0` names it
      const name = alias ?? `stage-${stages.length}`
      const decl: InfraDecl = {
        id: symbolId(file.path, name),
        kind: 'symbol',
        name,
        subkind: 'stage',
        parent: `f:${file.path}`,
        range: [first + 1, 1, first + 1, line.length + 1],
        signature: `FROM ${image}`,
        tags: [],
        loc: 1,
        complexity: 1,
      }
      if (base) file.refs.push({ source: decl.id, target: { to: 'decl', id: base.decl.id }, subkind: 'uses', line: first + 1, col: line.indexOf(image) + 1 })
      else {
        const img = imageName(image)
        if (img) {
          decl.tags.push(`image:${img}`)
          images.add(img)
        }
      }
      // the previous stage ends where this one starts
      const prev = stages.at(-1)
      if (prev) closeStage(prev.decl, raw, first)
      stages.push({ decl, alias })
      file.decls.push(decl)
      continue
    }
    const copy = /--from=([\w.-]+)/.exec(line)
    const current = stages.at(-1)
    if (copy && current) {
      const source = stage(copy[1])
      if (source && source !== current) file.refs.push({ source: current.decl.id, target: { to: 'decl', id: source.decl.id }, subkind: 'uses', line: first + 1, col: line.indexOf(copy[0]) + 1 })
    }
  }
  const last = stages.at(-1)
  if (last) closeStage(last.decl, raw, raw.length)
  for (const s of stages) s.decl.loc = countLoc(text, s.decl.range[0], s.decl.range[2])
  file.tags.push(...[...images].sort().map(i => `image:${i}`))
}

/** A stage runs up to the last non-blank line before `next` (0-based, exclusive). */
function closeStage(decl: InfraDecl, raw: string[], next: number) {
  let end = next - 1
  while (end > decl.range[0] - 1 && !raw[end]?.trim()) end--
  decl.range = [decl.range[0], 1, end + 1, (raw[end]?.length ?? 0) + 1]
}
