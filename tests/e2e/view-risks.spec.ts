import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The arc42 §11 view: the risk matrix. On the history fixture (four source
// files with git history) likelihood is churn; on fullstack (no history) the
// stand-in, complexity × fan-out.

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(150)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const views = (page: Page) => page.getByRole('group', { name: 'View' })
const at = async (page: Page, id: string) => {
  const p = await page.evaluate(id => window.__archrift.screenPosition(id), id)
  expect(p, id).not.toBeNull()
  return p!
}

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the arc42 menu opens the risk matrix, a tower selects its file, and City comes back', async ({ page }) => {
  await page.goto(serverUrl('history'))
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: /^arc42/ }).click()
  await page.getByRole('menuitemradio', { name: /§11 Risks & debt/ }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=risks/)
  await expect(views(page).getByRole('button', { name: /^arc42 · §11 Risks & debt/ })).toHaveAttribute('aria-pressed', 'true')

  const s = await scene(page)
  expect(s.view).toBe('risks')
  expect(s.arcs).toBe(0)
  expect(s.objects.building).toBe(4) // a, c, d and lib/b: one tower each
  expect(s.decoration).toMatchObject({ files: 4, cells: 25, related: 0 })
  // the board names the section, the scales say what they measure
  await expect(page.locator('.label.a42-title', { hasText: 'arc42 §11 · Risks and Technical Debt' })).toBeVisible()
  await expect(page.locator('.label', { hasText: 'likelihood of change: lines changed →' })).toBeVisible()
  await expect(page.locator('.label.risks-rank', { hasText: /^#1 / })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('Risks and Technical Debt')
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('lines changed in the last 90 days')

  // a tower is its file: click it, the inspector opens on it, and it and what depends on it stay bright
  const a = await at(page, 'f:src/a.ts')
  await page.mouse.click(a.x, a.y)
  await expect(title(page)).toHaveText('a.ts')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ related: 2 }) // a.ts, and c.ts that imports it
  await expect(page).toHaveURL(/view=risks/) // a diagram read whole: selecting keeps the view

  await views(page).getByRole('button', { name: 'City' }).click()
  await settle(page)
  const city = await scene(page)
  expect(city.view).toBe('city')
  expect(city.decoration).toBeNull()
  await expect(page.getByRole('button', { name: /^Register/ })).toHaveCount(0)
  // the label layer keeps spare label elements hidden, so only shown ones count
  await expect(page.locator('.label.risks-rank').filter({ visible: true })).toHaveCount(0)
})

test('the register lists every file by priority, and a row selects its file', async ({ page }) => {
  await page.goto(`${serverUrl('history')}?view=risks`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await page.getByRole('button', { name: /^Register/ }).click()
  const register = page.getByRole('dialog', { name: 'Risk register' })
  await expect(register).toBeVisible()
  const rows = register.locator('tbody tr')
  await expect(rows).toHaveCount(4)
  await expect(rows.first().locator('td').first()).toHaveText('1')
  const name = (await rows.nth(1).locator('.risks-link').textContent())!
  await rows.nth(1).click()
  await expect(title(page)).toHaveText(name)
  await expect(rows.nth(1)).toHaveClass(/selected/)
  // Escape closes the register and keeps the selection
  await page.keyboard.press('Escape')
  await expect(register).toHaveCount(0)
  expect(await page.evaluate(() => window.__archrift.state().selected)).not.toBeNull()
})

test('without git history, likelihood stands in as complexity × what a file uses', async ({ page }) => {
  await page.goto(`${serverUrl('fullstack')}?view=risks`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const s = await scene(page)
  expect(s.view).toBe('risks')
  expect(s.decoration).toMatchObject({ cells: 25 })
  expect(s.objects.building).toBe((s.decoration as Record<string, number>).files)
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('no git history')
  await expect(page.locator('.label', { hasText: 'likelihood of change: complexity × uses →' })).toBeVisible()

  // selecting the Prisma schema keeps everything that reaches it bright
  await page.evaluate(() => window.__archrift.select('f:prisma/schema.prisma'))
  await settle(page)
  const related = ((await scene(page)).decoration as Record<string, number>).related
  expect(related).toBeGreaterThan(1)
  await expect(title(page)).toHaveText('schema.prisma')
})

test('the plain fixture with an import cycle rings its two files', async ({ page }) => {
  await page.goto(`${serverUrl('plainTs')}?view=risks`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const s = await scene(page)
  expect(s.view).toBe('risks')
  // cycle-a.ts and cycle-b.ts: one ring each at least
  expect((s.decoration as Record<string, number>).rings).toBeGreaterThanOrEqual(2)
  await expect(page.locator('.label.a42-heading', { hasText: '2 in import cycles' })).toBeVisible()
})
