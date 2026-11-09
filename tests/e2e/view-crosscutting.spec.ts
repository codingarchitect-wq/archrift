import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The arc42 §8 Crosscutting view (src/viewer/views/crosscutting) on the fullstack fixture: seven building
// blocks under src/ stand as pillars; src/lib (the stand-in libraries) is the one candidate, used by app,
// local and ui, so one band with three collars and a sleeve on lib's own pillar.

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const views = (page: Page) => page.getByRole('group', { name: 'View' })
const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(150)
}

let errors: string[] = []
test.beforeEach(({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the arc42 menu opens the crosscutting concepts: pillars for the blocks, a band for the candidate, and back', async ({ page }) => {
  await page.goto(serverUrl('fullstack'))
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await views(page).getByRole('button', { name: /^arc42/ }).click()
  await page.getByRole('menuitemradio', { name: /§8 Crosscutting/ }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=crosscutting/)
  await expect(views(page).getByRole('button', { name: /^arc42/ })).toHaveText(/§8 Crosscutting/)
  const s = await scene(page)
  expect(s).toMatchObject({ view: 'crosscutting', arcs: 0, objects: { building: 7 } })
  expect(s.decoration).toMatchObject({ pillars: 7, bands: 1, collars: 3, homes: 1, litPillars: 0, litBands: 0 })
  await expect(page.locator('.label.a42-title')).toHaveText('arc42 §8 · Crosscutting Concepts')
  await expect(page.locator('.label.a42-heading')).toHaveText('1 concept candidate across 7 building blocks')
  await expect(page.locator('.label.cc-band')).toHaveText('lib/')
  await expect(page.locator('.label.cc-note')).toHaveText('src/lib · used by 3 of 7 blocks')
  for (const name of ['app', 'client', 'server', 'local', 'ui', 'prisma', 'lib']) await expect(page.locator('.label.cc-pillar', { hasText: new RegExp(`^${name}$`) })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('Crosscutting Concepts')

  await views(page).getByRole('button', { name: 'City', exact: true }).click()
  await settle(page)
  expect((await scene(page)).decoration).toBeNull()
  await expect(page.locator('.label.cc-pillar')).toHaveCount(0)
  await expect(views(page).getByRole('button', { name: /^arc42/ })).toHaveAttribute('aria-pressed', 'false')
})

test('a pillar selects its block and lights the bands it uses; code of a band lights the band and its users', async ({ page }) => {
  await page.goto(`${serverUrl('fullstack')}?view=crosscutting`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  // a pillar, below its cap: the local store uses the stand-in libraries (its Dexie), the client doesn't
  const click = async (id: string) => {
    const top = await page.evaluate(id => window.__archrift.screenPosition(id), id)
    expect(top, id).not.toBeNull()
    await page.mouse.click(top!.x, top!.y + 25)
    await settle(page)
  }
  await click('d:src/local')
  await expect(title(page)).toHaveText('local')
  expect((await scene(page)).decoration).toMatchObject({ litPillars: 1, litBands: 1 })
  await click('d:src/client')
  await expect(title(page)).toHaveText('client')
  expect((await scene(page)).decoration).toMatchObject({ litPillars: 1, litBands: 0 })
  await expect(page.locator('.label.cc-band.cc-on')).toHaveCount(0)
  await expect(page.locator('.label.cc-band.a42-dim')).toHaveText('lib/')

  // a file in src/lib: the band, its three users and its home
  await page.evaluate(() => window.__archrift.select('f:src/lib/fake-libs.ts'))
  await expect(title(page)).toHaveText('fake-libs.ts')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ litPillars: 4, litBands: 1 })
  await expect(page.locator('.label.cc-band.cc-on')).toHaveText('lib/')
  await expect(page.locator('.label.cc-pillar.a42-dim')).toHaveCount(3)

  await page.keyboard.press('Escape')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ litPillars: 0, litBands: 0 })
  expect(await page.evaluate(() => window.__archrift.state().options.view)).toBe('crosscutting')
})

test('with a single block there is nothing to cut across, and the board says so', async ({ page }) => {
  await page.goto(`${serverUrl('plainTs')}?view=crosscutting`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ pillars: 1, bands: 0, collars: 0 })
  await expect(page.locator('.label.a42-heading')).toHaveText('0 concept candidates across 1 building block')
  await expect(page.locator('.label.cc-empty')).toHaveText('Too few building blocks for anything to cut across them')
})
