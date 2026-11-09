import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The Tree view (src/viewer/views/tree): folders as branches, files as leaves at their folder's fork.

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
/** The engine's tweens and trips are over (the bark grows alongside, as long), and nothing is loading. */
const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(150)
}
/** Leaves (files) and branches (folders) drawn. */
const counts = async (page: Page) => {
  const s = await scene(page)
  return { leaves: s.objects.building ?? 0, branches: s.decoration?.branches }
}

let errors: string[] = []
test.beforeEach(({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('?view=tree grows plain-ts: a trunk, a branch for src, its files as leaves', async ({ page }) => {
  await page.goto(`${serverUrl('plainTs')}?view=tree`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await expect(page.getByRole('button', { name: 'Tree', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await scene(page)).toMatchObject({ view: 'tree', shape: 'sphere', objects: { building: 9 }, decoration: { branches: 2, segments: 16 } })
  // the tests' folder grows once tests are shown
  await page.getByRole('checkbox', { name: 'tests' }).check()
  await settle(page)
  expect(await counts(page)).toEqual({ leaves: 10, branches: 3 })
})

test('from the toolbar: pick a branch and a leaf, open its moons, and switch back', async ({ page }) => {
  await page.goto(serverUrl('fullstack'))
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const city = await counts(page)
  await page.getByRole('button', { name: 'Tree', exact: true }).click()
  await settle(page)
  const s = await scene(page)
  expect(s).toMatchObject({ view: 'tree', shape: 'sphere' })
  expect(s.objects.building).toBe(city.leaves) // every file the city shows
  expect(s.decoration!.branches).toBeGreaterThan(8)
  expect(s.decoration!.segments).toBe(s.decoration!.branches * 8)

  // the trunk, just below the first fork, is the root folder
  const fork = await page.evaluate(() => window.__archrift.screenPosition('d:.'))
  await page.mouse.click(fork!.x, fork!.y + 40)
  await expect.poll(() => page.evaluate(() => window.__archrift.state().selected)).toBe('d:.')
  await page.keyboard.press('Escape')
  await settle(page)
  // back to the whole tree (framing the root left the crown under the toolbar)
  await page.getByRole('button', { name: 'Home' }).click()
  await settle(page)

  // a leaf is its file, which opens into its symbols as moons
  const leaf = await page.evaluate(() => window.__archrift.screenPosition('f:src/client/service.ts'))
  await page.mouse.click(leaf!.x, leaf!.y)
  await expect(title(page)).toHaveText('service.ts')
  await settle(page)
  expect((await scene(page)).objects.floor).toBeGreaterThan(0)

  // a folder from the breadcrumbs: selected, and flown to
  await page.getByRole('navigation', { name: 'Breadcrumbs' }).getByRole('button', { name: 'client', exact: true }).click()
  await expect(title(page)).toHaveText('client')
  await settle(page)
  expect(await page.evaluate(() => window.__archrift.screenPosition('d:src/client'))).not.toBeNull()

  await page.keyboard.press('1')
  await settle(page)
  expect(await scene(page)).toMatchObject({ view: 'city', shape: 'box', decoration: null })
  await expect(title(page)).toHaveText('client')
})

// tests/helpers/history-repo.ts: a.ts, b.ts, c.ts in src at the start; b.ts moves into src/lib; d.ts arrives last
test('the timeline grows the tree: leaves and branches come and go, nothing moves', async ({ page }) => {
  await page.goto(`${serverUrl('history')}?view=tree`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  expect(await counts(page)).toEqual({ leaves: 4, branches: 3 }) // a, c, d, lib/b: the root, src, lib

  await page.getByRole('button', { name: /^History/ }).click()
  await page.getByRole('button', { name: 'Open the timeline (3 snapshots)' }).click()
  const timeline = page.getByRole('group', { name: 'Timeline' })
  const slider = timeline.getByRole('slider', { name: 'Point in time' })
  await expect(slider).toBeEnabled()
  await settle(page)
  const where = () => page.evaluate(() => window.__archrift.screenPosition('f:src/a.ts'))
  const now = await where()

  await slider.focus()
  await page.keyboard.press('Home')
  await expect(timeline).toContainText('start')
  await settle(page)
  expect(await counts(page)).toEqual({ leaves: 3, branches: 2 }) // a, b, c; no lib yet
  expect(await where()).toEqual(now)

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(timeline).toContainText('move b into lib')
  await settle(page)
  expect(await counts(page)).toEqual({ leaves: 3, branches: 3 }) // a, c, lib/b
  expect(await where()).toEqual(now)

  await page.keyboard.press('End')
  await settle(page)
  expect(await counts(page)).toEqual({ leaves: 4, branches: 3 })

  await timeline.getByRole('button', { name: 'Close timeline' }).click()
  await expect(timeline).toBeHidden()
  await settle(page)
  expect(await counts(page)).toEqual({ leaves: 4, branches: 3 })
})
