// Where `archrift snapshot` keeps its graphs: `<dir>/<sha>.json` plus an
// `index.json` listing them. Read by the server; written by the analyzer.
import fs from 'node:fs'
import path from 'node:path'

export interface Revision {
  sha: string
  /** How it was asked for (a tag, HEAD~40 …); the sha when picked by --count. */
  rev: string
  /** Commit time, unix seconds. */
  time: number
  subject: string
}

export interface SnapshotInfo extends Revision {
  files: number
  loc: number
}

export const SNAPSHOT_INDEX = 'index.json'
const SHA = /^[0-9a-f]{40}$/

/** The snapshots whose graphs exist, oldest first. */
export function readSnapshotIndex(dir: string): SnapshotInfo[] {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT_INDEX), 'utf8')) as SnapshotInfo[]
    return list.filter(s => SHA.test(s.sha) && fs.existsSync(path.join(dir, `${s.sha}.json`))).sort((a, b) => a.time - b.time)
  } catch {
    return []
  }
}

/** The graph file of a snapshot; undefined for anything that isn't a full sha. */
export const snapshotFile = (dir: string, sha: string) => (SHA.test(sha) ? path.join(dir, `${sha}.json`) : undefined)
