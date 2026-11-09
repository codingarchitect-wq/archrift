import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The Wheel view plug-in (src/viewer/views/wheel): files around a ring, folders as bands, bundled arcs.

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(150)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const position = (page: Page, id: string) => page.evaluate(i => window.__archrift.screenPosition(i), id)
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })

let errors: string[] = []
test.beforeEach(({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the toolbar switches to the wheel: ticks, one band, routed arcs; a tick selects its file and the camera stays', async ({ page }) => {
  await page.goto(serverUrl('plainTs'))
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  await page.getByRole('button', { name: 'Wheel' }).click()
  await settle(page)
  const s = await scene(page)
  expect(s).toMatchObject({ view: 'wheel', shape: 'sphere' })
  expect(s.objects.building).toBeGreaterThan(5)
  expect(s.arcs).toBeGreaterThan(0)
  // tests are hidden: src/ is the only folder
  expect(s.decoration).toMatchObject({ sectors: 1, levels: 1, folded: 0, marks: s.objects.building })
  expect(s.decoration!.routed).toBeGreaterThanOrEqual(s.arcs)
  expect(await page.evaluate(() => window.__archrift.state().options.view)).toBe('wheel')

  const tick = (await position(page, 'f:src/util.ts'))!
  await page.mouse.click(tick.x, tick.y)
  await expect(title(page)).toHaveText('util.ts')
  await settle(page)
  const selected = await scene(page)
  expect(selected.highlighted).toBeGreaterThan(0)
  expect(selected.decoration!.routed).toBeGreaterThanOrEqual(selected.highlighted)
  // a diagram read whole: selecting keeps the camera
  const after = (await position(page, 'f:src/util.ts'))!
  expect(Math.hypot(after.x - tick.x, after.y - tick.y)).toBeLessThan(2)

  await page.keyboard.press('1')
  await settle(page)
  expect(await scene(page)).toMatchObject({ view: 'city', shape: 'box', decoration: null })
  await expect(title(page)).toHaveText('util.ts')
})

test('?view=wheel opens it; hovering a folder’s band lights up its bundles, clicking selects the folder', async ({ page }) => {
  await page.goto(`${serverUrl('fullstack')}?view=wheel`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const s = await scene(page)
  expect(s.view).toBe('wheel')
  expect(s.decoration!.levels).toBeGreaterThanOrEqual(3)
  expect(s.decoration!.sectors).toBeGreaterThan(5)
  expect(s.decoration!.lit).toBe(0)

  const band = (await position(page, 'd:src/server'))!
  await page.mouse.move(band.x, band.y)
  await expect.poll(async () => (await scene(page)).decoration!.lit).toBeGreaterThan(0)
  await expect(page.getByRole('tooltip')).toContainText('server')

  await page.mouse.click(band.x, band.y)
  await expect(title(page)).toHaveText('server')
  await settle(page)
  expect((await scene(page)).highlighted).toBeGreaterThan(0)

  // leaving the canvas puts the bundles out
  await page.dispatchEvent('#scene canvas', 'pointerleave')
  await expect.poll(async () => (await scene(page)).decoration!.lit).toBe(0)
})

test('grouped by detected module, the bands are the modules', async ({ page }) => {
  await page.goto(`${serverUrl('fullstack')}?view=wheel&group=community`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const s = await scene(page)
  expect(s.decoration!.levels).toBe(1)
  expect(s.decoration!.sectors).toBeGreaterThan(1)
  const modules = await page.evaluate(() => window.__archrift.state().options.groupBy)
  expect(modules).toBe('community')
})
