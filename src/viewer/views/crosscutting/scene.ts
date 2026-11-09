// Crosscutting view, part 3: what a layout stands for (the model and where
// things stand), kept by layout so the labels, colors and the decoration read
// it without recomputing; and what the selection lights up.
import { fileIdOf } from '../../../core/ids.ts'
import type { Layout } from '../../layouts/types.ts'
import type { World } from '../../world.ts'
import type { Arrangement } from './layout.ts'
import type { CrosscuttingModel } from './model.ts'

export interface CrosscuttingScene {
  model: CrosscuttingModel
  arrangement: Arrangement
}

export const scenes = new WeakMap<Layout, CrosscuttingScene>()

/** Owners in the drawing: pillar i is i, band k is BAND + k; -1 is the board. */
export const BAND = 1000

export interface Lit {
  pillars: Set<number>
  bands: Set<number>
}

/**
 * What the selection lights up, or null when nothing in the view is selected.
 * A band's code (one of its folders or files, or a file in them) lights the
 * band, the pillars using it and its homes; a block (or anything else in it)
 * lights the pillar and the bands it uses or holds.
 */
export function litBy(scene: CrosscuttingScene, world: World, selected: string | null): Lit | null {
  if (!selected) return null
  const { model } = scene
  const file = fileIdOf(selected)
  const ancestors = new Set(file ? world.index.ancestors(file).map(d => d.id) : [])
  const inside = (id: string) => selected === id || ancestors.has(id)
  const band = model.candidates.findIndex(c => c.members.some(m => inside(m.id)))
  if (band >= 0) {
    const c = model.candidates[band]
    const pillars = new Set(model.blocks.flatMap((b, i) => (c.users.has(b.id) || c.homes.includes(b.id) ? [i] : [])))
    return { pillars, bands: new Set([band]) }
  }
  // a group, or a folder's own files: the block itself or one of its files; a folder block: anything inside it
  const pillar = model.blocks.findIndex(b => (b.loose || b.group ? selected === b.id || (!!file && b.files.includes(file)) : inside(b.id)))
  if (pillar < 0) return null
  const id = model.blocks[pillar].id
  const bands = new Set(model.candidates.flatMap((c, k) => (c.users.has(id) || c.homes.includes(id) ? [k] : [])))
  return { pillars: new Set([pillar]), bands }
}

/** A drawing owner lit by the selection (always, without one). */
export function isLit(lit: Lit | null, owner: number) {
  if (!lit || owner < 0) return true
  return owner >= BAND ? lit.bands.has(owner - BAND) : lit.pillars.has(owner)
}
