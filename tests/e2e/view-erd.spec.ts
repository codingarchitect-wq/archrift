import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// Tables (ERD) on the fullstack fixture: its Prisma schema (User, and Account with a foreign key to it) and
// its Dexie database (an accounts table) as two boards. The cards go app's accounts (0), then db's User (1),
// the table referenced most, and Account (2). plain-ts declares no schema.
const URL = serverUrl('fullstack')
const ACCOUNT = 's:prisma/schema.prisma#Account'

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(200)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const at = async (page: Page, id: string) => {
  const p = await page.evaluate(id => window.__archrift.screenPosition(id), id)
  expect(p, id).not.toBeNull()
  return p!
}
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const legend = (page: Page) => page.getByRole('complementary', { name: 'Legend' })
const views = (page: Page) => page.getByRole('group', { name: 'View' })
/** A label shown (the viewer keeps hidden ones around to reuse). */
const label = (page: Page, css: string, text: string | RegExp) => page.locator(css, { hasText: text }).filter({ visible: true })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the Diagrams menu opens the tables, one board per database, and City brings the city back', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: /^Diagrams/ }).click()
  await page.getByRole('menuitemradio', { name: /^Tables \(ERD\)/ }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=erd/)
  await expect(views(page).getByRole('button', { name: /^Diagrams · Tables \(ERD\)/ })).toHaveAttribute('aria-pressed', 'true')
  const s = await scene(page)
  expect(s.view).toBe('erd')
  expect(s.arcs).toBe(0) // the foreign keys are the connectors
  expect(s.objects.building).toBe(3) // the cards, undrawn, for the minimap
  expect(s.decoration).toMatchObject({ boards: 2, cards: 3, tables: 3, links: 1, arcs: 0, foreignKeys: 1, focused: 0, opened: 0 })
  expect(s.decoration!.glyphs).toBeGreaterThan(40)
  await expect(label(page, '.label.a42-heading', /^db · SQL · Prisma$/)).toBeVisible()
  await expect(label(page, '.label.a42-heading', /^app · IndexedDB · Dexie$/)).toBeVisible()
  await expect(label(page, '.label.a42-title', /^Entity–relationship diagram · 2 tables$/)).toBeVisible()
  await expect(legend(page)).toContainText('Entity–relationship diagram')
  await expect(legend(page)).toContainText('2 databases, 3 tables, 1 foreign key')
  await expect(page.getByRole('button', { name: 'Database: all ▾' })).toBeVisible()

  await views(page).getByRole('button', { name: 'City' }).click()
  await page.waitForFunction(() => window.__archrift.idle() && window.__archrift.scene().view === 'city')
  expect((await scene(page)).decoration).toBeNull()
  await expect(page.getByRole('button', { name: /^Database:/ })).toHaveCount(0)
  await expect(page.locator('.label.a42-heading').filter({ visible: true })).toHaveCount(0)
})

test('a table opens with its neighbors lit, the legend lists who reads and writes it, and a reader picked there lights what it queries', async ({ page }) => {
  await page.goto(`${URL}?view=erd`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  const account = await at(page, 'erd:card:2')
  await page.mouse.click(account.x, account.y)
  await expect(title(page)).toHaveText('Account')
  await settle(page)
  // Account and the User it references; the connector between them; the rest (app's accounts) faded
  expect((await scene(page)).decoration).toMatchObject({ focused: 2, focusLinks: 1 })
  await expect(legend(page).getByRole('button', { name: 'accounts.ts' }).first()).toBeVisible()
  await expect(legend(page)).toContainText(/reads \(\d+\)/)

  // the router reading it: selected, it lights the tables it queries, and the list stays
  await legend(page).getByRole('button', { name: 'accounts.ts' }).first().click()
  await expect(title(page)).toHaveText('accounts.ts')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ focused: 1, opened: 0 })
  await expect(legend(page)).toContainText(/reads \(\d+\)/)

  await page.keyboard.press('Escape')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ focused: 0 })
  await expect(legend(page)).toContainText('select a table to see who reads and writes it')
})

test('relation fields show on demand, and the toolbar picks one database', async ({ page }) => {
  await page.goto(`${URL}?view=erd`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const rows = (await scene(page)).decoration!.rows

  await page.getByRole('button', { name: 'relation fields' }).click()
  await settle(page)
  await expect(page.getByRole('button', { name: 'relation fields' })).toHaveAttribute('aria-pressed', 'true')
  // User.accounts and Account.user, which Prisma navigates but doesn't store
  expect((await scene(page)).decoration!.rows).toBe(rows + 2)

  await page.getByRole('button', { name: 'Database: all ▾' }).click()
  await page.getByRole('menuitemradio', { name: /^app/ }).click()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Database: app ▾' })).toBeVisible()
  expect((await scene(page)).decoration).toMatchObject({ boards: 1, cards: 1, links: 0 })

  // selecting a table of another database by search: it is just not drawn
  await page.evaluate(id => window.__archrift.select(id), ACCOUNT)
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ focused: 0 })
})

test('a graph without a schema says so', async ({ page }) => {
  await page.goto(`${serverUrl('plainTs')}?view=erd`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  expect((await scene(page)).decoration).toEqual({})
  await expect(label(page, '.label.a42-heading', 'No database schema found')).toBeVisible()
  await expect(legend(page)).toContainText('No database schema in this graph')
  await expect(page.getByRole('button', { name: 'relation fields' })).toHaveCount(0)
})
