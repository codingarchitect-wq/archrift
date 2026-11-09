import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// Group by feature on the fullstack fixture: its pages make two features, accounts (/accounts, /accounts/[id],
// with the client service, the tRPC routers and the schema they reach) and home (/); /api/health is no feature.
const URL = serverUrl('fullstack')

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(150)
}
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('group by feature: the features become the districts, and a feature shows the routes it was found from', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  const group = page.getByRole('combobox', { name: 'group' })
  await expect(group.locator('option', { hasText: 'by feature' })).toHaveCount(1)
  await group.selectOption('feature')
  await settle(page)
  await expect(page).toHaveURL(/group=feature/)
  // the groups the city is built from, by the files' feature tags
  type Viewer = { world: { node(id: string): { tags?: string[] } | undefined } }
  const groupOf = (file: string) =>
    page.evaluate(f => ((window.__archrift.state() as unknown as Viewer).world.node(f)?.tags ?? []).filter((t: string) => t.startsWith('feature')), file)
  expect(await groupOf('f:src/server/routers/accounts.ts')).toEqual(['feature:accounts'])
  expect(await groupOf('f:src/app/page.tsx')).toEqual(['feature:home'])
  await expect(page.locator('.label.group', { hasText: /^accounts$/ })).toBeVisible()

  await page.evaluate(() => window.__archrift.select('feature:accounts'))
  await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('accounts')
  await expect(inspector(page).locator('.badge').first()).toHaveText('feature')
  await expect(inspector(page)).toContainText('/accounts · /accounts/[id]')
  await expect(inspector(page)).toContainText('routers')

  // the building block view's level 1 holds the features
  await page.evaluate(() => window.__archrift.setOptions({ view: 'blocks' }))
  await settle(page)
  await expect(page.locator('.label.a42-heading', { hasText: /^Level 1 · fullstack · by feature$/ })).toBeVisible()
})
