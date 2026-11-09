// `.archrift/config.json`: which files to analyze, which are tests
// and entrypoints, the build targets, layers, groups, rules and how git
// history is read.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { matcher } from '../core/glob.ts'
import { FILE_METRICS, FUNCTION_METRICS } from '../core/rules.ts'
import { DEFAULT_HISTORY } from './history.ts'

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.next*/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/target/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/.archrift/**',
  '**/.git/**',
  '**/.gradle/**',
  // Eclipse's Gradle output: copies of the sources and resources
  '**/bin/main/**',
  '**/bin/test/**',
]

export const DEFAULT_TESTS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**', 'e2e/**']

const LayerSchema = z.strictObject({
  name: z.string().min(1),
  /** Files this layer holds; a file belongs to the first layer that matches it. */
  match: z.union([z.string(), z.array(z.string())]),
})

const Selector = z.union([z.string(), z.array(z.string())])
const RuleCore = {
  name: z.string().min(1),
  description: z.string().optional(),
  severity: z.enum(['error', 'warn']).optional(),
}
const RuleBase = {
  ...RuleCore,
  /** Only this build target (default: all). */
  target: z.string().optional(),
}
/** A limit's bounds: metric → the most (max) or least (min) it may be. */
const bounds = <M extends readonly [string, ...string[]]>(metrics: M) => {
  const b = z.partialRecord(z.enum(metrics), z.number())
  return { max: b.optional(), min: b.optional() }
}
const hasBound = (l: { max?: object; min?: object }) => Object.keys(l.max ?? {}).length + Object.keys(l.min ?? {}).length > 0
const LimitSchema = z.union([
  z.strictObject({ files: Selector, except: Selector.optional(), ...bounds(FILE_METRICS) }).refine(hasBound, 'a limit needs max or min'),
  z.strictObject({ functions: Selector, except: Selector.optional(), ...bounds(FUNCTION_METRICS) }).refine(hasBound, 'a limit needs max or min'),
])
/** Architecture rules; see src/core/rules.ts for what each one checks. */
const RuleSchema = z.union([
  z.strictObject({ ...RuleBase, forbid: z.strictObject({ from: Selector, to: Selector, except: Selector.optional() }), runtimeOnly: z.boolean().optional() }),
  z.strictObject({ ...RuleBase, allow: z.strictObject({ from: Selector, to: Selector }), runtimeOnly: z.boolean().optional() }),
  // each folder the globs match (services/*) may not depend on another: no way to say "another" with from/to
  z.strictObject({ ...RuleBase, apart: Selector, runtimeOnly: z.boolean().optional() }),
  z.strictObject({ ...RuleBase, forbidReach: z.strictObject({ from: Selector, to: Selector, except: Selector.optional() }) }),
  z.strictObject({ ...RuleBase, requireReach: z.strictObject({ from: Selector, to: Selector, except: Selector.optional() }) }),
  z.strictObject({ ...RuleBase, cycles: z.literal('forbid'), scope: Selector.optional() }),
  z.strictObject({ ...RuleBase, layers: z.literal('down'), runtimeOnly: z.boolean().optional() }),
  // a measure belongs to a file, not to a build target
  z.strictObject({ ...RuleCore, limit: LimitSchema }),
])

const ParadigmSchema = z.strictObject({
  id: z.string().regex(/^[\w.-]+$/),
  label: z.string().optional(),
  /** An older way a newer one replaces. */
  legacy: z.boolean().optional(),
  /** Import specifiers: a package or prefix (`date-fns`, `org.junit.jupiter`), a project file (`src/trpc/client.ts`), or `/regex/`. */
  imports: z.array(z.string().min(1)).optional(),
  /** A regular expression the file's text matches (multiline). */
  text: z.string().min(1).optional(),
  /** Text patterns look only at files matching these globs. */
  files: z.array(z.string()).optional(),
})

const ConcernSchema = z.strictObject({
  id: z.string().regex(/^[\w.-]+$/),
  label: z.string().optional(),
  stack: z.string().optional(),
  about: z.string().optional(),
  /** A concern of test code (production code's otherwise). */
  tests: z.boolean().optional(),
  paradigms: z.array(ParadigmSchema).min(1),
})

const TargetSchema = z.strictObject({
  /** TypeScript moduleSuffixes for this target, e.g. [".desktop", ""]. */
  moduleSuffixes: z.array(z.string()).default(['']),
})

/** `requires`: ">=1", ">=1.2" or ">=1.2.3". */
const REQUIRES = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

export const ConfigSchema = z.strictObject({
  name: z.string().optional(),
  /** The lowest archrift version this config needs, as `">=0.2"`: an older one stops with a message saying how to update. */
  requires: z.string().regex(REQUIRES, 'requires: ">=<version>", the lowest archrift version this config needs').optional(),
  /**
   * Other folders analyzed with the root, by name (docs/POLYGLOT.md): `{ "infra": "~/src/infra" }`
   * puts their files under `infra/`. A relative folder is relative to the root.
   */
  mounts: z.record(z.string().regex(/^[\w.-]+$/), z.string()).default({}),
  /**
   * tsconfig file(s), relative to the root (`infra/…` for a mount's). Default: tsconfig.json when present.
   * A folder instead (`"infra/azure/"`) is a light project: every JS/TS file under it, the packages it
   * imports not loaded (src/analyzer/ts/project.ts).
   */
  tsconfig: z.union([z.string(), z.array(z.string())]).optional(),
  /** Only analyze files matching these globs (default: everything the tsconfig includes). */
  include: z.array(z.string()).optional(),
  /** Added to DEFAULT_EXCLUDE. Imports into excluded files become `x:excluded:` nodes. */
  exclude: z.array(z.string()).default([]),
  tests: z.array(z.string()).default(DEFAULT_TESTS),
  /** Files loaded by a framework or runtime rather than imported; their exports are never "dead". */
  entrypoints: z.array(z.string()).default([]),
  /** Architecture layers, top to bottom: dependencies are expected to point down. */
  layers: z.array(LayerSchema).optional(),
  /** Custom groups (features, teams …) the viewer can group by; a file joins the first that matches. */
  groups: z.array(LayerSchema).optional(),
  /**
   * Functional features (src/core/features.ts), found from the pages and API routes: one per first
   * route segment. `merge` names a feature after route prefixes (`"auth": ["/login", "/api/auth"]`,
   * also a way to rename one: `"dashboard": ["/"]`); `exclude` leaves routes out (transports such
   * as /api/trpc are by default).
   */
  features: z
    .strictObject({
      merge: z.record(z.string(), z.array(z.string())).default({}),
      exclude: z.array(z.string()).default([]),
    })
    .prefault({}),
  rules: z.array(RuleSchema).default([]),
  /** The last coverage run, relative to the root: an Istanbul coverage-final.json (Vitest writes one), for CRAP in `archrift query`. */
  coverage: z.string().default('coverage/coverage-final.json'),
  /**
   * Coherence (docs/COHERENCE.md): the project's own concerns, beside the catalog's (one with a catalog id
   * adds paradigms to it, or imports and patterns to one of its paradigms), and the concerns whose several
   * ways are intended, each with the reason (`"js.persistence": "local and cloud storage are two tiers"`).
   */
  coherence: z
    .strictObject({
      concerns: z.array(ConcernSchema).default([]),
      accept: z.record(z.string(), z.string().min(1)).default({}),
    })
    .prefault({}),
  /** Git history: churn, authors, recency and co-change, when the root is in a repository. */
  history: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Churn counts the lines changed in this many days before the newest commit. */
      windowDays: z.number().int().positive().default(DEFAULT_HISTORY.windowDays),
      /** Commits touching more files don't count toward co-change. */
      maxFilesPerCommit: z.number().int().min(2).default(DEFAULT_HISTORY.maxFilesPerCommit),
      minSupport: z.number().int().min(1).default(DEFAULT_HISTORY.minSupport),
      minConfidence: z.number().min(0).max(1).default(DEFAULT_HISTORY.minConfidence),
      maxPartners: z.number().int().min(1).default(DEFAULT_HISTORY.maxPartners),
    })
    .prefault({}),
  /**
   * Documents and the code they're about (src/core/docs.ts): the files and folders read as documents
   * (Markdown, HTML, text; relative to the root, `..` allowed; a missing one is skipped), the ones kept
   * true to the code (`diff` names them when code they describe changes; default: all but those in a
   * `historical`, `archive` or `old` folder, which never are), and the pattern of the decision ids the
   * code cites (`"\\bADR-\\d+\\b"`; default: one to three capitals and up to three digits, `D34`;
   * false: none). An id counts only where a document defines it.
   */
  docs: z
    .strictObject({
      include: z.array(z.string()).default(['README.md', 'ARCHITECTURE.md', 'docs', 'doc', 'adr']),
      current: z.array(z.string()).optional(),
      ids: z.union([z.string().min(1), z.literal(false)]).optional(),
    })
    .prefault({}),
  /** Build targets in order; the first is the primary one symbol references are resolved for. */
  targets: z.record(z.string(), TargetSchema).optional(),
  maxSitesPerEdge: z.number().int().min(0).default(20),
})

export type Config = z.infer<typeof ConfigSchema>

export interface Target {
  name: string
  moduleSuffixes: string[]
}

export function targetsOf(config: Config): Target[] {
  const entries = Object.entries(config.targets ?? {})
  return entries.length
    ? entries.map(([name, t]) => ({ name, moduleSuffixes: t.moduleSuffixes }))
    : [{ name: 'default', moduleSuffixes: [''] }]
}

/**
 * The tags a file gets from where it is: `test`, `entrypoint`, its layer and its group
 * (the first that matches). Also answers for a path no file has yet (`archrift query`).
 */
export function pathTags(config: Config): (relPath: string) => string[] {
  const isTest = matcher(config.tests)
  const isEntrypoint = matcher(config.entrypoints)
  const layers = (config.layers ?? []).map(l => ({ name: l.name, match: matcher([l.match].flat()) }))
  const groups = (config.groups ?? []).map(g => ({ name: g.name, match: matcher([g.match].flat()) }))
  return p => {
    const tags: string[] = []
    if (isTest(p)) tags.push('test')
    if (isEntrypoint(p)) tags.push('entrypoint')
    const layer = layers.find(l => l.match(p))
    if (layer) tags.push(`layer:${layer.name}`)
    const group = groups.find(g => g.match(p))
    if (group) tags.push(`group:${group.name}`)
    return tags
  }
}

/** This archrift's version (its package.json, two folders up in a checkout and in the built package alike). */
export const VERSION: string = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')).version

/** A project's own folder for archrift: `<root>/.archrift/`, or `.archviz/` where only archrift's former name is set up. */
export function projectDir(root: string): string {
  const dir = path.join(root, '.archrift')
  const former = path.join(root, '.archviz')
  return !fs.existsSync(dir) && fs.existsSync(former) ? former : dir
}

/** Whether `version` (1.2.3) is at least what `requires` (">=1.2") asks for. */
export function satisfies(version: string, requires: string): boolean {
  const want = REQUIRES.exec(requires.trim())
  if (!want) return false
  const have = version.split(/[.+-]/).map(Number)
  for (let i = 0; i < 3; i++) {
    const a = have[i] || 0
    const b = Number(want[i + 1] ?? 0)
    if (a !== b) return a > b
  }
  return true
}

/** Reads `configPath`, or `<root>/.archrift/config.json` when present, else defaults. */
export function loadConfig(root: string, configPath?: string): Config {
  const file = configPath ? path.resolve(configPath) : path.join(projectDir(root), 'config.json')
  if (!fs.existsSync(file)) {
    if (configPath) throw new Error(`config not found: ${file}`)
    return ConfigSchema.parse({})
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`invalid config ${file}:\n${z.prettifyError(parsed.error)}`)
  const { requires } = parsed.data
  if (requires && !satisfies(VERSION, requires)) throw new Error(`${file} needs archrift ${requires}, this one is ${VERSION}: npm i -g archrift@latest (or git pull where it is linked)`)
  return parsed.data
}
