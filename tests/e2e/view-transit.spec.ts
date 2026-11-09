import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The Transit view on the fullstack fixture: two lines, /accounts down through the client service and the
// tRPC router to the Prisma schema, and / down to the stand-in libraries; seven stations, no interchange.
const URL = serverUrl('fullstack')
const ACCOUNTS = 'f:src/app/(shop)/accounts/page.tsx'

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

test('the toolbar switches to a subway map of the requests, and back', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: 'Transit' }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=transit/)
  const s = await scene(page)
  expect(s.view).toBe('transit')
  expect(s.shape).toBe('sphere')
  expect(s.objects.building).toBe(7) // the stations
  expect(s.arcs).toBe(0) // the lines are the dependencies
  expect(s.decoration).toMatchObject({ lines: 2, candidates: 2, stations: 7, interchanges: 0, highlighted: 0 })
  // line names at their starts, station names, layer columns
  await expect(page.locator('.label.transit-line', { hasText: '/accounts' })).toBeVisible()
  await expect(page.locator('.label.transit-station', { hasText: 'schema.prisma' })).toBeVisible()
  await expect(page.locator('.label.transit-column', { hasText: 'client' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Lines 2\/2/ })).toBeVisible()

  await views(page).getByRole('button', { name: 'City' }).click()
  await settle(page)
  const city = await scene(page)
  expect(city.view).toBe('city')
  expect(city.decoration).toBeNull()
  await expect(page.getByRole('button', { name: /^Lines/ })).toHaveCount(0)
  await expect(page.locator('.label.transit-line')).toHaveCount(0)
})

test('a line picks the page it starts at; a station selects its file and lights up its lines', async ({ page }) => {
  await page.goto(`${URL}?view=transit`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  // the ribbon between the client service and the router belongs to /accounts
  const a = await at(page, 'f:src/client/service.ts')
  const b = await at(page, 'f:src/server/routers/accounts.ts')
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2)
  await expect(title(page)).toHaveText('page.tsx')
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBe(ACCOUNTS)
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ highlighted: 1 })

  await page.getByRole('button', { name: 'Home' }).click()
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ highlighted: 0 })
  const theme = await at(page, 'f:src/ui/ThemeContext.tsx')
  await page.mouse.click(theme.x, theme.y)
  await expect(title(page)).toHaveText('ThemeContext.tsx')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ highlighted: 1 })
  // the other line fades, labels included
  await expect(page.locator('.label.transit-line.transit-dim', { hasText: '/accounts' })).toHaveCount(1)
  await expect(page.locator('.label.transit-line.transit-dim', { hasText: /^\/$/ })).toHaveCount(0)
})

test('the line picker hides and shows lines', async ({ page }) => {
  await page.goto(`${URL}?view=transit`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await page.getByRole('button', { name: /^Lines 2\/2/ }).click()
  const picker = page.getByRole('dialog', { name: 'Lines' })
  await expect(picker.getByRole('checkbox')).toHaveCount(2)
  await expect(picker.getByRole('listitem').first()).toContainText('4 stations · data')

  await picker.getByRole('checkbox', { name: '/', exact: true }).uncheck()
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ lines: 1, stations: 4 })
  expect((await scene(page)).objects.building).toBe(4)
  await expect(page.getByRole('button', { name: /^Lines 1\/2/ })).toBeVisible()

  await picker.getByRole('button', { name: '12' }).click()
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ lines: 2, stations: 7 })
  await expect(picker.getByRole('checkbox', { name: '/', exact: true })).toBeChecked()

  // Escape closes the picker and leaves the selection alone
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
})
