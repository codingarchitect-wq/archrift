import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The arc42 §3 Context view on the fullstack fixture: the pages' user and the health check call in,
// and the code keeps its data in the Prisma database and a Dexie store (found from the queries:
// the fixture has no npm packages).
const URL = serverUrl('fullstack')
const SCHEMA = 'f:prisma/schema.prisma'

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
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

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the arc42 menu opens the context: the system among its neighbors, and City again', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: /^arc42/ }).click()
  await page.getByRole('menuitemradio', { name: /§3 Context/ }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=context/)
  await expect(views(page).getByRole('button', { name: /^arc42 · §3 Context/ })).toHaveAttribute('aria-pressed', 'true')
  const s = await scene(page)
  expect(s.view).toBe('context')
  expect(s.arcs).toBe(0) // the ties are the connections
  expect(s.decoration).toMatchObject({ neighbors: 4, inbound: 2, outbound: 0, stores: 2, ties: 4, libraries: 0, litNeighbors: 0 })
  expect(s.decoration!.dots).toBeGreaterThan(0)
  // the neighbors stand as boxes the engine picks and flies to, drawn by the view
  expect(s.objects.building).toBe(4)
  await expect(page.locator('.label.a42-title', { hasText: 'arc42 §3 · Context and Scope' })).toBeVisible()
  for (const name of ['User (browser)', 'Monitoring', 'Database', 'IndexedDB (browser)']) await expect(page.locator('.label.a42-pill', { hasText: name })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('Context and Scope')

  await views(page).getByRole('button', { name: 'City' }).click()
  await settle(page)
  const city = await scene(page)
  expect(city.view).toBe('city')
  expect(city.decoration).toBeNull()
  await expect(page.locator('.label.a42-pill')).toHaveCount(0)
})

test('a neighbor selects what stands for it and lights its tie; Escape clears it', async ({ page }) => {
  await page.goto(`${URL}?view=context`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  // the database drum, a little below the top of its box
  const p = await at(page, SCHEMA)
  await page.mouse.click(p.x, p.y + 10)
  await expect(title(page)).toHaveText('schema.prisma')
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBe(SCHEMA)
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ litNeighbors: 1, litTies: 1 })
  // the rest fades, labels included; the selection is named once, on its pill
  await expect(page.locator('.label.a42-pill.a42-dim', { hasText: 'User (browser)' })).toHaveCount(1)
  await expect(page.locator('.label.a42-pill.a42-accent', { hasText: 'Database' })).toHaveCount(1)
  await expect(page.locator('.label.selected')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await settle(page)
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBeNull()
  expect((await scene(page)).decoration).toMatchObject({ litNeighbors: 0, litTies: 0 })
})

test('selecting code lights the neighbors it talks to', async ({ page }) => {
  await page.goto(`${URL}?view=context#n=f:src/local/service.ts`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  // the local service queries the Dexie store, and nothing else outside
  expect((await scene(page)).decoration).toMatchObject({ litNeighbors: 1, litTies: 1 })
  await expect(page.locator('.label.a42-pill:not(.a42-dim)', { hasText: 'IndexedDB (browser)' })).toHaveCount(1)
})
