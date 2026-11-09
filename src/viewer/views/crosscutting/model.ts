// Crosscutting view, part 1: the candidates. A crosscutting concept is code
// that many building blocks rely on (translations, validation, auth …). The
// blocks are the top-level ones (the kit's levelOneBlocks, as §5's level 1:
// folders, or the toolbar's groups). Code is weighed in units: a small block
// whole, else a subfolder right below its block's folder (a group's: the one
// its files share) or a file lying directly in it (a barrel that only re-exports is
// passed over: its users reach the files behind it anyway). A unit's breadth
// is how many OTHER blocks depend on it, its spread how many places (the
// folders right below those blocks) do. Each unit gets a suggested concept
// from generic keywords in its path; units suggesting the same concept are
// one candidate (useTranslation in hooks/ and the i18n/ folder, say). Those
// used by enough blocks, or by two blocks in many places, are candidates, the
// most widely spread first. The concept is always shown as a question:
// naming it is the reader's job. Pure and deterministic: no scene, no store.
import type { GraphNode } from '../../../core/model.ts'
import type { World } from '../../world.ts'
import { layerOfBlock, levelOneBlocks } from '../arc42-kit/blocks.ts'
import type { BlockGrouping, TopBlock } from '../arc42-kit/blocks.ts'

export interface Member {
  /** The node a unit stands for: a folder (d:) or a file (f:). */
  id: string
  path: string
  /** The block its code lives in. */
  home: string
}

export interface Candidate {
  /** What selecting it selects: its most widely used member's node. */
  id: string
  /** Its units, most widely used first. */
  members: Member[]
  files: string[]
  /** The blocks its code lives in. */
  homes: string[]
  /** Other blocks using it → references from that block. */
  users: Map<string, number>
  breadth: number
  /** Places using it: folders right below the other blocks (a block's own files and a small block count as one place). */
  spread: number
  /** References from other blocks, summed. */
  weight: number
  /** A suggested concept ("Translations (i18n)"), when a keyword in its path suggests one. */
  concept?: string
  /** What its band is labelled: the concept as a question, or the folder or file name. */
  name: string
}

export interface CrosscuttingModel {
  /** The folder the code splits in (the system's white box). */
  system: string
  /** In pillar order: by layer (top layer first), then largest first. */
  blocks: TopBlock[]
  /** Per block (same order): its layer's index, or -1. */
  layers: number[]
  /** Most widely spread first, at most MAX_CANDIDATES. */
  candidates: Candidate[]
  /** How many other blocks a candidate needs (or two, in SPREAD places). */
  threshold: number
}

export interface CrosscuttingInput {
  world: World
  /** Files the filters let through. */
  isShown: (n: GraphNode) => boolean
  /** File-level dependencies: who uses each file, and how much (the viewer's DepGraph). */
  in: ReadonlyMap<string, readonly string[]>
  weight: ReadonlyMap<string, ReadonlyMap<string, number>>
  /** Architecture layers, top to bottom. */
  order: readonly string[]
  layerOf: (n: GraphNode) => string | undefined
  /** The toolbar's grouping: the pillars are its groups instead of folders. */
  grouping?: BlockGrouping | null
}

export const MAX_CANDIDATES = 12
/** A block with at most this many files is weighed whole. */
const SMALL_BLOCK = 8
/** Used by two blocks in at least this many places is crosscutting too (translation hooks used all over the UI). */
export const SPREAD = 6

interface Unit {
  member: Member
  files: string[]
  users: Map<string, number>
  /** Using places, by the block they're in. */
  places: Map<string, string>
}

export function crosscuttingModel(input: CrosscuttingInput): CrosscuttingModel {
  const { world } = input
  const top = levelOneBlocks(world, input.isShown, input.grouping ?? null)
  const layerIndex = new Map(input.order.map((l, i) => [l, i]))
  const layerOfBlockId = new Map(
    top.blocks.map(b => {
      const layer = layerOfBlock(b, world, input.layerOf, input.order)
      return [b.id, layer === undefined ? -1 : (layerIndex.get(layer) ?? -1)] as const
    }),
  )
  // pillars: top layer first, then the blocks without one; within a layer the largest first (topBlocks' order)
  const rank = (b: TopBlock) => {
    const l = layerOfBlockId.get(b.id)!
    return l < 0 ? input.order.length : l
  }
  const blocks = top.blocks.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map(x => x.b)
  const byId = new Map(blocks.map(b => [b.id, b]))

  // the folder right below a block's folder a file is in (undefined: directly in it)
  const below = (f: string, b: TopBlock) => {
    const dirPath = world.node(b.home)?.path ?? ''
    const path = world.node(f)?.path ?? ''
    const rest = dirPath ? path.slice(dirPath.length + 1) : path
    const slash = rest.indexOf('/')
    return slash < 0 ? undefined : `d:${dirPath ? `${dirPath}/` : ''}${rest.slice(0, slash)}`
  }
  const whole = (b: TopBlock) => b.loose || b.files.length <= SMALL_BLOCK
  // units: a small block whole; else a subfolder right below the block, or a file directly in it (by block:
  // groups may share a folder, each with its own files there)
  const unitFiles = new Map<string, string[]>()
  for (const b of blocks)
    for (const f of b.files) {
      const unit = b.loose ? f : whole(b) ? b.id : (below(f, b) ?? f)
      if (unit === f && isBarrel(world, f)) continue
      push(unitFiles, `${b.id}\u0000${unit}`, f)
    }
  // a place: the folder right below a block, or the block itself for its own files and small blocks
  const placeOf = (f: string) => {
    const b = byId.get(top.blockOf.get(f)!)!
    return whole(b) ? b.id : (below(f, b) ?? b.id)
  }

  const units: Unit[] = []
  for (const [key, files] of unitFiles) {
    const [home, unit] = key.split('\u0000')
    const users = new Map<string, number>()
    const places = new Map<string, string>()
    for (const f of files)
      for (const s of input.in.get(f) ?? []) {
        const from = top.blockOf.get(s)
        if (!from || from === home) continue
        users.set(from, (users.get(from) ?? 0) + (input.weight.get(s)?.get(f) ?? 1))
        places.set(placeOf(s), from)
      }
    if (users.size < 2) continue
    units.push({ member: { id: unit, path: world.node(unit)?.path ?? byId.get(unit)?.name ?? unit.slice(2), home }, files, users, places })
  }

  // units suggesting the same concept are one candidate; the others stand alone
  const groups = new Map<string, Unit[]>()
  for (const u of units) push(groups, conceptOf(u.member.path) ?? `unit:${u.member.id}`, u)
  const threshold = Math.max(2, Math.min(3, Math.ceil(0.4 * (blocks.length - 1))))
  const candidates: Candidate[] = []
  for (const [key, group] of groups) {
    const homes = new Set(group.map(u => u.member.home))
    const users = new Map<string, number>()
    const places = new Set<string>()
    for (const u of group) {
      for (const [b, w] of u.users) if (!homes.has(b)) users.set(b, (users.get(b) ?? 0) + w)
      for (const [p, b] of u.places) if (!homes.has(b)) places.add(p)
    }
    if (users.size < 2 || (users.size < threshold && places.size < SPREAD)) continue
    const spreadOf = (u: Unit) => u.places.size
    const members = [...group].sort((a, b) => spreadOf(b) - spreadOf(a) || b.users.size - a.users.size || cmp(a.member.path, b.member.path))
    const concept = key.startsWith('unit:') ? undefined : key
    const first = members[0].member
    const base = first.id.startsWith('f:')
      ? stem(first.path.split('/').pop()!)
      : first.id.startsWith('d:')
        ? `${first.path.split('/').pop() || byId.get(first.id)?.name || first.path}/`
        : first.path // a group, whole
    candidates.push({
      id: first.id,
      members: members.map(u => u.member),
      files: members.flatMap(u => u.files).sort(),
      homes: blocks.filter(b => homes.has(b.id)).map(b => b.id),
      users,
      breadth: users.size,
      spread: places.size,
      weight: [...users.values()].reduce((a, b) => a + b, 0),
      concept,
      name: concept ? `${concept}?` : base,
    })
  }
  candidates.sort((a, b) => b.spread - a.spread || b.breadth - a.breadth || b.weight - a.weight || cmp(a.id, b.id))
  return {
    system: top.system,
    blocks,
    layers: blocks.map(b => layerOfBlockId.get(b.id)!),
    candidates: candidates.slice(0, MAX_CANDIDATES),
    threshold,
  }
}

/** A file that only passes on what others declare (its dependencies are all re-exports). */
function isBarrel(world: World, file: string) {
  const out = world.index.out(file).filter(e => e.kind !== 'co-changes')
  return out.length > 0 && out.every(e => e.kind === 're-exports')
}

/**
 * Generic keywords → the concept they suggest, tried in order on the words of
 * a path, its own name first. Words come from splitting on separators and
 * camel case (`useAuth` → use, auth).
 */
const CONCEPTS: [string, RegExp][] = [
  ['Translations (i18n)', /^(i18n|l10n|intl|locale|locales|translation|translations|translate|messages)$/],
  ['Authentication', /^(auth|authentication|session|sessions|login|logout|signin|signup|oauth|jwt|password|passwords)$/],
  ['Feature gating', /^(flag|flags|feature|features|entitlement|entitlements|license|licence|licensing|tier|tiers|permission|permissions|gate|gates|gating)$/],
  ['Validation & schemas', /^(schema|schemas|zod|validation|validate|validator|validators)$/],
  ['Persistence', /^(db|database|storage|store|persist|persistence|dexie|prisma|repository|repositories|repo|dao|orm)$/],
  ['Logging', /^(log|logs|logger|logging|telemetry|tracing|audit)$/],
  ['Error handling', /^(error|errors|exception|exceptions)$/],
  ['Configuration', /^(config|configuration|env|environment|constants|settings)$/],
  ['Remote calls (API)', /^(api|trpc|rpc|http|fetch|client)$/],
  ['Platform abstraction', /^(platform|platforms|adapter|adapters)$/],
  ['UI primitives', /^(ui|theme|themes|primitives|design)$/],
  ['Formatting', /^(format|formatting|formatter|formatters)$/],
  ['Utilities', /^(util|utils|utility|utilities|helper|helpers|common|shared)$/],
  ['Shared types', /^(type|types|typings|interfaces|model|models)$/],
]

/** The concept a path suggests: the unit's own name first, then its folders from the nearest up. */
export function conceptOf(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    const name = stem(segments[i])
    // translation hooks by convention: useT, useNavT, useSettingsT …
    if (/^use[A-Za-z]*T$/.test(name)) return 'Translations (i18n)'
    const ws = words(name)
    for (const [concept, re] of CONCEPTS) if (ws.some(w => re.test(w))) return concept
  }
  return undefined
}

/** A name's words, lowercase: split at separators and camel case (`useDataService` → use, data, service). */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_.()[\]]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
}

const stem = (name: string) => name.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts|prisma|json)$/, '')

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
