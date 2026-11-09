// The `datastore` fact channel (docs/POLYGLOT.md): databases that scripts and
// manifests create, and that code uses. plugins/datastores.ts turns them into
// database nodes (`x:db:<engine>:<name>`) that repositories query.

export interface DatastoreFact {
  /** declare: a script or manifest creates it; use: code or its configuration connects to it. */
  type: 'declare' | 'use'
  /** The symbol, member or file doing it. */
  owner: string
  /** mysql, postgres, mongodb, redis … */
  engine: string
  /** The database's name (a MySQL database, a Mongo database); '' when not known. */
  name: string
  /** The module folder it belongs to ('' for none). */
  module: string
  site: [number, number]
}
