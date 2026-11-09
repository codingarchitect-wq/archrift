// Stills of every view, to plan the showcase's shots (record.mjs): one screenshot
// per view, and where its camera rests. archrift serve on 127.0.0.1:4300, then
//   node scripts/showcase/stills.mjs out/showcase/stills [project]
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? 'out/showcase/stills'
const project = process.argv[3] ?? 'archrift'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' })
await page.addInitScript(() => localStorage.setItem('archrift.hint.seen', '1'))
await page.goto(`http://127.0.0.1:4300/?project=${project}&view=city`)
await page.waitForFunction(() => window.__archrift?.ready(), null, { timeout: 60000 })
const shots = [
  ['city', { view: 'city' }],
  ['city-hotspot', { view: 'city', colorBy: 'hotspot' }],
  ['layers', { view: 'layers', colorBy: 'area', edges: 'violations' }],
  ['galaxy', { view: 'galaxy', edges: 'auto' }],
  ['matrix', { view: 'matrix' }],
  ['wheel', { view: 'wheel' }],
  ['terrain', { view: 'terrain' }],
  ['tree', { view: 'tree' }],
  ['transit', { view: 'transit' }],
  ['context', { view: 'context' }],
  ['blocks', { view: 'blocks' }],
  ['runtime', { view: 'runtime' }],
  ['crosscutting', { view: 'crosscutting' }],
  ['risks', { view: 'risks' }],
  ['coherence', { view: 'coherence' }],
]
for (const [name, opts] of shots) {
  await page.evaluate(o => window.__archrift.setOptions(o), opts)
  await page.waitForTimeout(1500)
  await page.waitForFunction(() => window.__archrift.idle(), null, { timeout: 60000 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 80 })
  console.log(name, JSON.stringify(await page.evaluate(() => ({ ...window.__archrift.camera.home(), objects: window.__archrift.scene().objects }))))
}
await browser.close()
