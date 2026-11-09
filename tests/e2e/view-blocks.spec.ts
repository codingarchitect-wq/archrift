import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The arc42 §5 Building Block View on the fullstack fixture: seven top-level blocks (src/app, client, server,
// local, ui, lib and prisma) with seven dependencies between them; the server opens into its routers folder and
// trpc.ts, with the client above and the Prisma schema below as neighbors; the routers folder opens one level more.
const URL = serverUrl('fullstack')

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(250)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const at = async (page: Page, id: string) => {
  const p = await page.evaluate(id => window.__archrift.screenPosition(id), id)
  expect(p, id).not.toBeNull()
  return p!
}
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const views = (page: Page) => page.getByRole('group', { name: 'View' })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the arc42 menu opens the building block view, and the toolbar switches back', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: /^arc42/ }).click()
  await page.getByRole('menuitemradio', { name: /§5 Building blocks/ }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=blocks/)
  await expect(views(page).getByRole('button', { name: /^arc42 · §5 Building blocks/ })).toHaveAttribute('aria-pressed', 'true')
  const s = await scene(page)
  expect(s.view).toBe('blocks')
  expect(s.arcs).toBe(0) // the connectors are the dependencies
  expect(s.objects.building).toBe(7) // the blocks, hidden but pickable
  expect(s.decoration).toMatchObject({ levels: 1, blocks: 7, links: 7, hidden: 0, openBlocks: 0 })
  await expect(page.locator('.label.a42-title', { hasText: 'Building Block View' })).toBeVisible()
  await expect(page.locator('.label.a42-heading', { hasText: 'Level 1 · fullstack' })).toBeVisible()
  await expect(page.locator('.label.a42-name', { hasText: /^server$/ })).toBeVisible()
  const legend = page.getByRole('complementary', { name: 'Legend' })
  await expect(legend).toContainText('Building Block View')
  await expect(legend).toContainText('7 blocks, 7 dependencies')

  await views(page).getByRole('button', { name: 'City' }).click()
  await settle(page)
  const city = await scene(page)
  expect(city.view).toBe('city')
  expect(city.decoration).toBeNull()
  await expect(page.locator('.label.a42-title')).toHaveCount(0)
})

test('a block opens its white box above, with its neighbors at the edge; a block in it selects, Escape closes it', async ({ page }) => {
  await page.goto(`${URL}?view=blocks`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  const server = await at(page, 'd:src/server')
  await page.mouse.click(server.x, server.y)
  await expect(title(page)).toHaveText('server')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ levels: 2, openBlocks: 2, stubs: 2 })
  await expect(page.locator('.label.a42-heading', { hasText: 'Level 2 · server' })).toBeVisible()
  await expect(page.locator('.label.blk-stub', { hasText: 'client' })).toBeVisible()
  // its provided interface: the three files the client and others use
  await expect(page.locator('.label.a42-small', { hasText: /3 files · \d+ lines · 3 used outside/ })).toBeVisible()
  // what isn't linked to the server fades
  await expect(page.locator('.label.a42-name.a42-dim', { hasText: /^ui$/ })).toHaveCount(1)
  await expect(page.locator('.label.a42-name.a42-dim', { hasText: /^client$/ })).toHaveCount(0)

  // a file in the white box: selected, the box stays open
  const trpc = await at(page, 'f:src/server/trpc.ts')
  await page.mouse.click(trpc.x, trpc.y)
  await expect(title(page)).toHaveText('trpc.ts')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ levels: 2 })

  await page.keyboard.press('Escape')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ levels: 1 })
})

test('a link opens the white boxes down to what it names; every dependency on request', async ({ page }) => {
  await page.goto(`${URL}?view=blocks#n=f:src/server/routers/accounts.ts`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await expect(title(page)).toHaveText('accounts.ts')
  expect((await scene(page)).decoration).toMatchObject({ levels: 3, openBlocks: 2, stubs: 3 })
  await expect(page.locator('.label.a42-heading', { hasText: 'Level 3 · routers' })).toBeVisible()

  // the server's white box draws its main dependencies: edges → all draws them all
  await page.getByRole('combobox', { name: 'edges' }).selectOption('all')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ levels: 3, hidden: 0 })
})

test('the toolbar’s edges option picks the dependencies drawn: none, those breaking a rule, the selection’s', async ({ page }) => {
  await page.goto(`${URL}?view=blocks`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const edges = page.getByRole('combobox', { name: 'edges' })
  const links = async () => (await scene(page)).decoration?.links
  expect(await links()).toBe(7)
  await edges.selectOption('none')
  await settle(page)
  expect(await links()).toBe(0)
  // the pages' imports of fake-libs (app → lib), the tRPC client's of the server (client → server)
  await edges.selectOption('violations')
  await settle(page)
  expect(await links()).toBe(2)
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('breaks a rule')
  await edges.selectOption('selection')
  await settle(page)
  expect(await links()).toBe(0)
  await page.evaluate(() => window.__archrift.select('d:src/client'))
  await settle(page)
  expect(await links()).toBe(2) // the app uses it, it uses the server
  // the other arc42 views draw no dependencies of their own to choose
  await page.evaluate(() => window.__archrift.setOptions({ view: 'risks' }))
  await expect(edges).toHaveCount(0)
})
