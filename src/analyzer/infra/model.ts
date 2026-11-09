// What the infrastructure reader (docs/POLYGLOT.md, P5) keeps per file
// between its two passes. Pass A reads one file on its own and is cached by
// the file's hash; pass B renders Helm templates with their chart's values
// and links names across files (a Service's selector, an Ingress backend, a
// chart's dependency, a script another script runs).
import type { Range } from '../../core/model.ts'

export type InfraLanguage = 'yaml' | 'helm' | 'shell' | 'sql' | 'dockerfile'

/** What a file is to the reader; decided from its path and the files around it. */
export type InfraKind =
  | 'manifest' // YAML: Kubernetes manifests, pipelines, any other YAML
  | 'chart' // Chart.yaml
  | 'values' // a Helm values file (values.yaml, values-prod.yaml, kafka-values.yaml)
  | 'helm-template' // a chart's templates/*.yaml: Go templates, rendered in pass B
  | 'helm-helpers' // a chart's templates/*.tpl: named templates (define)
  | 'compose' // docker-compose.yml
  | 'app-config' // Spring / Go application configuration (application*.yml, src/main/resources/**)
  | 'shell'
  | 'sql'
  | 'dockerfile'

export interface InfraDecl {
  id: string
  kind: 'symbol' | 'member'
  name: string
  subkind: string
  parent: string
  range: Range
  signature?: string
  tags: string[]
  loc: number
  complexity: number
}

/** Where a reference points, resolved in pass B. */
export type InfraTarget =
  /** A file the reader has: the first candidate path that exists. */
  | { to: 'file'; paths: string[] }
  /** A declaration of the same file (a compose service another depends on). */
  | { to: 'decl'; id: string }
  /** A Kubernetes resource by kind and name (several kinds: any of them). */
  | { to: 'k8s'; kinds: string[]; name: string; namespace?: string }
  /** The workloads whose pods carry these labels (a Service's selector). */
  | { to: 'pods'; labels: Record<string, string>; namespace?: string }
  /** A Helm chart: by its folder when a `file://` repository names it, else by name. */
  | { to: 'chart'; name: string; dir?: string }
  /** A Helm named template (`include "x"`). */
  | { to: 'define'; name: string }

export interface InfraRef {
  source: string
  target: InfraTarget
  subkind?: string
  line: number
  col: number
}

/** A Kubernetes resource, for linking by name and labels. */
export interface K8sResource {
  id: string
  kind: string
  name: string
  namespace?: string
  /** Labels of the pods it runs (workloads). */
  podLabels?: Record<string, string>
}

/** A named template of a chart's helpers (`{{ define "x" }}`), kept as text for pass B to render. */
export interface HelmDefine {
  id: string
  name: string
  body: string
  /** Line of the body's first line. */
  line: number
}

export interface InfraFile {
  path: string
  hash: string
  kind: InfraKind
  language: InfraLanguage
  loc: number
  complexity: number
  tags: string[]
  decls: InfraDecl[]
  refs: InfraRef[]
  /** Per fact channel (`messaging`, `datastore`). */
  facts: Record<string, unknown[]>
  resources?: K8sResource[]
  defines?: HelmDefine[]
  /** Chart.yaml: what templates see as `.Chart`. */
  chart?: { name: string; version: string }
  /** values.yaml: its scalar values by dotted key, without secret-looking ones (what templates see as `.Values`). */
  values?: Record<string, string | number | boolean>
  errors?: boolean
}
