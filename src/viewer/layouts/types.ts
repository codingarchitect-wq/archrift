// A layout places nodes as boxes. Every view produces the same
// shape, keyed by node id, so switching views is a tween between two maps.

/** x/z = footprint center, y = base, w/d = footprint, h = height. */
export interface Box {
  x: number
  y: number
  z: number
  w: number
  h: number
  d: number
}

/**
 * district/plane: platforms; building/external: the nodes themselves;
 * cluster: a directory's extent in views without platforms (not drawn,
 * but labelled, selectable and flown to).
 */
export type Placement = 'district' | 'building' | 'external' | 'plane' | 'cluster'

export interface Layout {
  /** The view that made it: city, layers, galaxy, or a view plug-in's id (src/viewer/views). */
  view: string
  /** Side length of the space the layout occupies (camera and fog scale with it). */
  size: number
  boxes: Map<string, Box>
  placement: Map<string, Placement>
  /** Containment depth of districts and clusters (root = 0). */
  depth: Map<string, number>
  /** Label text for boxes that aren't graph nodes (planes). */
  names?: Map<string, string>
  /** Layer index per file, top layer 0 (Layers view): edges should point to equal or higher indexes. */
  layerIndex?: Map<string, number>
  /** How nodes are drawn and where arcs attach. */
  shape: 'box' | 'sphere'
  arcAnchor: 'roof' | 'center'
  ground: boolean
  /** Home camera offset as a fraction of size, and the point it looks at. */
  home: [number, number, number]
  center: [number, number, number]
  /**
   * Boxes stay pickable, selectable and labelled but aren't drawn (a view
   * that draws its nodes itself, as a decoration).
   */
  hideBoxes?: boolean
  /** `none`: this view draws no dependency arcs (it shows dependencies its own way). */
  arcs?: 'default' | 'none'
  /** How the selected file opens: its symbols as floors (default), as moons (the galaxy's), or not at all. */
  openFile?: 'floors' | 'moons' | 'none'
  /** A diagram read whole: going to a node keeps the camera while the node is in view, and shows all of it otherwise. */
  keepView?: boolean
}

export const topOf = (b: Box) => ({ x: b.x, y: b.y + b.h, z: b.z })

export function emptyLayout(): Layout {
  return {
    view: 'city',
    size: 100,
    boxes: new Map(),
    placement: new Map(),
    depth: new Map(),
    shape: 'box',
    arcAnchor: 'roof',
    ground: true,
    home: [0.12, 0.75, 0.9],
    center: [0, 0, 0],
  }
}
