import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The fullstack fixture's config has five rules: an allow rule the pages break twice, a forbid
// warning the tRPC client breaks twice (type-only imports count), a reach rule that holds, a limit
// both page components are too long for, and a cycles rule on a folder the fixture doesn't have.
const URL = serverUrl('fullstack')

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })

test.beforeEach(async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
})

test('the rules panel lists broken and passing rules', async ({ page }) => {
  const button = page.getByRole('button', { name: /^Rules/ })
  await expect(button.locator('.count.error')).toHaveText('2')
  // the limit's two, and the rule that matches nothing counts once
  await expect(button.locator('.count.warn')).toHaveText('5')
  await button.click()
  const panel = page.getByRole('dialog', { name: 'Architecture rules' })
  const rules = panel.getByRole('region')
  await expect(rules).toHaveText([/^✗pages-use-services2/, /^!client-apart-from-server2/, /^!short-pages2/, /^!components-acyclic[^0-9]/, /^✓no-server-in-pages/])
  await expect(panel.getByRole('region', { name: 'Rule components-acyclic' }).getByRole('list', { name: 'Matches nothing' })).toHaveText(
    'scope src/components/** matches no file: the rule checks nothing there',
  )
  await expect(panel.getByRole('region', { name: 'Rule short-pages' }).getByRole('button')).toHaveText([
    /^Home in app\/page\.tsxloc 9 \(max 5\) · src\/app/,
    /^Accounts in accounts\/page\.tsxloc 6 \(max 5\) · src\/app\/\(shop\)\/accounts/,
  ])
  await expect(panel.getByRole('region', { name: 'Rule no-server-in-pages' })).toContainText('forbidReach · Server code never ends up')
  await expect(panel.getByRole('region', { name: 'Rule client-apart-from-server' }).getByRole('button')).toHaveText([
    /^trpc\.ts → routers\/index\.ts/,
    /^trpc\.ts → trpc\.ts/,
  ])
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('a violation shows where it happens, and steps to the next one', async ({ page }) => {
  await page.getByRole('button', { name: /^Rules/ }).click()
  await page
    .getByRole('region', { name: 'Rule pages-use-services' })
    .getByRole('button', { name: /^accounts\/page\.tsx → fake-libs\.ts/ })
    .click()
  await expect(page.getByRole('dialog', { name: 'Architecture rules' })).toBeHidden()
  await expect(title(page)).toHaveText('pages-use-services')
  await expect(inspector(page)).toContainText('broken rule')
  await expect(inspector(page)).toContainText('fake-libs.ts is outside what accounts/page.tsx may depend on.')
  await page.waitForFunction(() => window.__archrift.idle())
  expect(await page.evaluate(() => window.__archrift.scene().highlighted)).toBe(1)

  await inspector(page).getByRole('button', { name: 'Next violation' }).click()
  await expect(inspector(page)).toContainText('fake-libs.ts is outside what app/page.tsx may depend on.')
  await expect(inspector(page)).toContainText('2 of 2')

  // a step on the way selects that file; back returns to the violation
  await inspector(page).getByRole('button', { name: /^→ fake-libs\.ts/ }).click()
  await expect(title(page)).toHaveText('fake-libs.ts')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(title(page)).toHaveText('pages-use-services')
})

test('a broken limit shows the measure, and where: the file and the function', async ({ page }) => {
  await page.getByRole('button', { name: /^Rules/ }).click()
  await page.getByRole('region', { name: 'Rule short-pages' }).getByRole('button', { name: /^Home in app\/page\.tsx/ }).click()
  await expect(title(page)).toHaveText('short-pages')
  await expect(inspector(page)).toContainText('rule warning')
  await expect(inspector(page)).toContainText('Home in app/page.tsx: loc is 9, the rule allows at most 5.')
  const where = inspector(page).locator('section', { has: page.getByRole('heading', { name: 'Where' }) })
  await expect(where.getByRole('button')).toHaveText([/^app\/page\.tsxsrc\/app/, /^Homethe function/])

  await inspector(page).getByRole('button', { name: 'Next violation' }).click()
  await expect(inspector(page)).toContainText('Accounts in accounts/page.tsx: loc is 6, the rule allows at most 5.')
  await expect(inspector(page)).toContainText('2 of 2')

  await where.getByRole('button', { name: /the function/ }).click()
  await expect(title(page)).toHaveText('Accounts')
})

test('the city can be colored by violations', async ({ page }) => {
  await page.getByRole('button', { name: /^Rules/ }).click()
  await page.getByRole('button', { name: 'Color by violations' }).click()
  await expect.poll(() => page.evaluate(() => window.__archrift.state().options.colorBy)).toBe('violations')
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('breaks a rule (an error or a warning)')
  await expect(page.getByRole('combobox', { name: 'color' })).toHaveValue('violations')
})

test("a file's inspector lists the rules it breaks, from its side, and links to each", async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/app/page.tsx'))
  const section = inspector(page).locator('section.file-rules')
  await expect(section.getByRole('heading')).toHaveText('Breaks rules (2) · 1 error')
  await expect(section.getByRole('button')).toHaveText([/pages-use-services.*imports fake-libs\.ts/, /short-pages.*Home: loc 9 \(max 5\)/])

  // the other end sees both violations
  await page.evaluate(() => window.__archrift.select('f:src/lib/fake-libs.ts'))
  await expect(section.getByRole('button')).toHaveText([/pages-use-services.*accounts\/page\.tsx imports it/, /pages-use-services.*app\/page\.tsx imports it/])
  await section.getByRole('button').first().click()
  await expect(title(page)).toHaveText('pages-use-services')
  await expect(inspector(page)).toContainText('fake-libs.ts is outside what accounts/page.tsx may depend on.')

  // a file that breaks nothing has no such section
  await page.evaluate(() => window.__archrift.select('f:src/local/db.ts'))
  await expect(title(page)).toHaveText('db.ts')
  await expect(section).toHaveCount(0)
})

test('edges → violations draws only the dependencies that break a rule, and a selection keeps to its own', async ({ page }) => {
  await page.getByRole('combobox', { name: 'edges' }).selectOption('violations')
  await page.waitForFunction(() => window.__archrift.idle())
  await expect(page).toHaveURL(/edges=violations/)
  // the pages' two imports of fake-libs, the tRPC client's two imports from the server
  expect(await page.evaluate(() => window.__archrift.scene().arcs)).toBe(4)
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('only the dependencies that break a rule (4)')
  // a file selected: the violations stay (its own brighter), and none of its ordinary dependencies are drawn
  await page.evaluate(() => window.__archrift.select('f:src/client/trpc.ts'))
  await page.waitForFunction(() => window.__archrift.idle())
  const s = await page.evaluate(() => window.__archrift.scene())
  expect(s.arcs).toBe(4)
  expect(s.highlighted).toBe(0)
})
