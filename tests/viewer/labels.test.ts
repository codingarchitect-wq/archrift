import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LabelLayer, folderPriority } from '../../src/viewer/scene/labels.ts'

/** Just enough DOM for the label layer: elements with a style, a class and text. */
interface FakeElement {
  style: Record<string, string>
  className: string
  textContent: string
  children: FakeElement[]
  appendChild(child: FakeElement): void
}
const element = (): FakeElement => ({
  style: {},
  className: '',
  textContent: '',
  children: [],
  appendChild(child) {
    this.children.push(child)
  },
})

describe('folder labels', () => {
  const saved = (globalThis as { document?: unknown }).document
  beforeAll(() => {
    ;(globalThis as { document?: unknown }).document = { createElement: element }
  })
  afterAll(() => {
    ;(globalThis as { document?: unknown }).document = saved
  })

  /** The labels shown when `src` and `src/components` anchor a few units apart, as on a plane of the layers view. */
  function shown(srcKind: 'named' | 'plain', componentsKind: 'named' | 'plain', texts: [string, string]) {
    const parent = element()
    const layer = new LabelLayer(parent as unknown as HTMLElement)
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    const anchors = new Map([
      ['d:src', { point: new THREE.Vector3(0, 0, 0), width: 60 }],
      ['d:src/components', { point: new THREE.Vector3(1, -0.5, 0), width: 55 }],
    ])
    layer.setSpecs([
      { id: 'd:src', text: texts[0], priority: folderPriority(1, srcKind), className: 'district d1' },
      { id: 'd:src/components', text: texts[1], priority: folderPriority(2, componentsKind), className: 'district d2' },
    ])
    layer.update(camera, 800, 800, id => anchors.get(id))
    return parent.children[0].children.filter(e => e.style.display !== 'none').map(e => e.textContent)
  }

  it('keep the shallower of two folders that meet, by their code names', () => {
    expect(shown('plain', 'plain', ['src', 'components'])).toEqual(['src'])
  })

  it('give a folder with a written name the place over the folders around it that have none', () => {
    expect(shown('plain', 'named', ['src', 'UI components'])).toEqual(['UI components'])
    // named both: the shallower again
    expect(shown('named', 'named', ['Source', 'UI components'])).toEqual(['Source'])
  })

  it('rank a named folder at any depth above the plain ones, and groups above all folders', () => {
    for (let depth = 1; depth <= 4; depth++) {
      expect(folderPriority(4, 'named')).toBeGreaterThan(folderPriority(depth, 'plain'))
      expect(folderPriority(1, 'group')).toBeGreaterThan(folderPriority(depth, 'named'))
    }
  })
})
