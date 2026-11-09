import { createRoot } from 'react-dom/client'
import { fileIdOf } from '../core/ids.ts'
import { connect, readTheme, sceneId } from './controller.ts'
import { SceneEngine } from './scene/engine.ts'
import { actions, store } from './store.ts'
import { App } from './ui/App.tsx'
import { runtime } from './ui/runtime.ts'
import './ui/styles.css'

const engine = new SceneEngine(document.getElementById('scene')!, readTheme())
runtime.engine = engine
connect(engine)
createRoot(document.getElementById('ui')!).render(<App />)
void actions.load()

// a pasted link or browser navigation to #n=<id> selects that node
addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#n=')) return
  const id = decodeURIComponent(location.hash.slice(3))
  if (id !== store.getState().selected) void actions.select(id)
})

// hooks for end-to-end tests and debugging
Object.assign(window, {
  __archrift: {
    ready: () => store.getState().status === 'ready',
    state: () => store.getState(),
    select: (id: string) => actions.select(id),
    setOptions: (patch: Parameters<typeof actions.setOptions>[0]) => actions.setOptions(patch),
    startPath: (from: string) => actions.startPath(from),
    /** Client coordinates of a node's scene object (its floor when its building is open). */
    screenPosition: (id: string) => {
      const s = store.getState()
      const file = s.selected ? fileIdOf(s.selected) : undefined
      const scene = sceneId(s, id, file && s.details[file] ? file : null)
      return scene ? engine.screenPosition(scene) : null
    },
    idle: () => !engine.busy(),
    scene: () => engine.stats(),
    /** The camera, for scripted tours (scripts/showcase.ts): where it rests in this view, and placing it. */
    camera: {
      home: () => engine.homeView(),
      state: () => engine.cameraState(),
      place: (position: [number, number, number], target: [number, number, number]) => engine.place(position, target),
    },
    /** Frames per second while the camera orbits for `ms`. */
    bench: (ms = 3000) =>
      new Promise<number>(resolve => {
        engine.controls.autoRotate = true
        engine.controls.autoRotateSpeed = 20
        engine.requestRender()
        let frames = 0
        const t0 = performance.now()
        const tick = (now: number) => {
          frames++
          if (now - t0 < ms) return void requestAnimationFrame(tick)
          engine.controls.autoRotate = false
          resolve(Math.round((frames * 1000) / (now - t0)))
        }
        requestAnimationFrame(tick)
      }),
  },
})
