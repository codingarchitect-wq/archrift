import { describe, expect, it } from 'vitest'

describe('the viewer store', () => {
  it('can be imported outside a browser (view plug-ins and their tests use it)', async () => {
    const { store } = await import('../../src/viewer/store.ts')
    expect(store.getState().options.view).toBe('city')
    expect(store.getState().status).toBe('loading')
  })

  it('labels with the described names when asked, but never names a folder by the words for its own files', async () => {
    const { labelOf, store } = await import('../../src/viewer/store.ts')
    const s = {
      ...store.getState(),
      descriptions: {
        entries: {
          'd:src': { name: 'Request guard', summary: 'src/proxy.ts guards the routes.', ownFiles: true as const },
          'd:src/lib': { name: 'Core logic', summary: 'Shared code.' },
        },
        orphans: [],
      },
    }
    const described = { ...s, options: { ...s.options, names: 'described' as const } }
    expect(labelOf(s, 'd:src/lib', 'lib')).toBe('lib')
    expect(labelOf(described, 'd:src/lib', 'lib')).toBe('Core logic')
    // src stands on every plane of the layers view: "Request guard" there would name the hooks' plane too
    expect(labelOf(described, 'd:src', 'src')).toBe('src')
    // the blocks view's unit of src's own files is what the words are for
    expect(labelOf(described, 'd:src', 'src/', true)).toBe('Request guard')
  })
})
