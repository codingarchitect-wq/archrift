import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The arc42 §6 Runtime View on the fullstack fixture: /accounts as a sequence diagram, from the
// browser through the page and the client service, over tRPC to the accounts router, to the Prisma model.
const URL = serverUrl('fullstack')
const SERVICE = 'f:src/client/service.ts'
const ROUTER = 'f:src/server/routers/accounts.ts'

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task && window.__archrift.scene().view === 'runtime')
  await page.waitForTimeout(150)
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
/** A label shown (the viewer keeps hidden ones around to reuse). */
const label = (page: Page, css: string, text: string | RegExp) => page.locator(css, { hasText: text }).filter({ visible: true })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the arc42 menu opens a sequence diagram of /accounts, down to the data, and City brings the city back', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: /^arc42/ }).click()
  await page.getByRole('menuitemradio', { name: /^§6 Runtime/ }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=runtime/)
  await expect(views(page).getByRole('button', { name: /^arc42 · §6 Runtime/ })).toHaveAttribute('aria-pressed', 'true')
  const s = await scene(page)
  expect(s.view).toBe('runtime')
  expect(s.arcs).toBe(0) // the messages are the dependencies
  // Browser, the page, the stand-in libraries, the client service | the router, the database
  expect(s.decoration).toMatchObject({ participants: 6, messages: 6, rpc: 1, queries: 1, databases: 1, server: 2, pane: 1, fragments: 0, highlighted: 0 })
  await expect(page.getByRole('button', { name: 'Scenario: /accounts ▾' })).toBeVisible()
  await expect(label(page, '.label.a42-title', 'arc42 §6 · Runtime View')).toBeVisible()
  await expect(label(page, '.label.rt-rpc', 'accounts.list.query()')).toBeVisible()
  await expect(label(page, '.label.rt-query', 'Account.findMany()')).toBeVisible()
  await expect(label(page, '.label.a42-name', 'schema.prisma')).toBeVisible()
  await expect(label(page, '.label', 'network · tRPC')).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('Runtime View')

  await views(page).getByRole('button', { name: 'City' }).click()
  await page.waitForFunction(() => window.__archrift.idle() && window.__archrift.scene().view === 'city')
  expect((await scene(page)).decoration).toBeNull()
  await expect(page.locator('.label.rt-rpc').filter({ visible: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Scenario:/ })).toHaveCount(0)
})

test('a lifeline selects its file and lights up its messages; an activation selects the call it runs', async ({ page }) => {
  await page.goto(`${URL}?view=runtime`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  // just under where the viewer puts its name: the header
  const service = await at(page, SERVICE)
  await page.mouse.click(service.x, service.y + 8)
  await expect(title(page)).toHaveText('service.ts')
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBe(SERVICE)
  await settle(page)
  // new CloudService(), getAccounts(), and the tRPC call it makes
  expect((await scene(page)).decoration).toMatchObject({ highlighted: 3 })
  await expect(label(page, '.label.a42-name.selected', 'service')).toBeVisible()
  await expect(label(page, '.label.a42-small.a42-dim', 'Account.findMany()')).toHaveCount(1)

  // the router's activation, just under the tRPC call: the procedure it runs
  await page.getByRole('button', { name: 'Home' }).click()
  await settle(page)
  const router = await at(page, ROUTER)
  const rpc = await page.locator('.label.rt-rpc').filter({ visible: true }).boundingBox()
  await page.mouse.click(router.x, rpc!.y + rpc!.height + 8)
  await expect(title(page)).toHaveText('list')
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBe('s:src/server/routers/accounts.ts#accountsRouter.list')
})

test('the scenario picker lists the pages and API routes, and draws another', async ({ page }) => {
  await page.goto(`${URL}?view=runtime`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await page.getByRole('button', { name: /^Scenario:/ }).click()
  const menu = page.getByRole('menu', { name: 'Scenarios' })
  await expect(menu.getByRole('menuitemradio')).toHaveCount(4)
  await expect(menu.getByRole('menuitemradio', { name: /^\/accounts\b.*6 messages/ })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitemradio', { name: /^\/api\/health/ })).toBeVisible()

  await menu.getByRole('menuitemradio', { name: /^\/\s/ }).click()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Scenario: / ▾' })).toBeVisible()
  // the home page: its theme hook and the links it renders, no network, no data
  expect((await scene(page)).decoration).toMatchObject({ participants: 4, messages: 4, rpc: 0, queries: 0, pane: 0 })
  await expect(label(page, '.label.a42-small', 'useTheme()')).toBeVisible()

  // an API route: its handler, called over HTTP
  await page.getByRole('button', { name: /^Scenario:/ }).click()
  await page.getByRole('menuitemradio', { name: /^\/api\/health/ }).click()
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ participants: 2, messages: 1, server: 1, pane: 1 })
  await expect(label(page, '.label', 'GET /api/health')).toBeVisible()
  await expect(label(page, '.label', 'network · HTTP')).toBeVisible()
})

test('the replay switch stops and restarts the pulse', async ({ page }) => {
  await page.goto(`${URL}?view=runtime`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const replay = page.getByRole('button', { name: 'replay' })
  await expect(replay).toHaveAttribute('aria-pressed', 'true')
  expect((await scene(page)).decoration?.dots).toBeGreaterThan(0)
  await replay.click()
  await expect(replay).toHaveAttribute('aria-pressed', 'false')
  await replay.click()
  await expect(replay).toHaveAttribute('aria-pressed', 'true')
})

test('opening the view with a page selected starts at that page', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await page.evaluate(() => window.__archrift.select('f:src/app/page.tsx'))
  await expect(title(page)).toHaveText('page.tsx')
  // the arc42 menu opens over the inspector
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: /^arc42/ }).click()
  await page.getByRole('menuitemradio', { name: /§6 Runtime/ }).click()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Scenario: / ▾' })).toBeVisible()
  expect((await scene(page)).decoration).toMatchObject({ messages: 4 })
})
