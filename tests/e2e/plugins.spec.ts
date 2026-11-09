import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The fullstack fixture: tRPC-shaped routers, a Prisma schema, Dexie, a React context, Next.js pages, a test.
const URL = serverUrl('fullstack')

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })

test.beforeEach(async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
})

test('a client call leads to the procedure, the procedure to the model it queries', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('s:src/client/service.ts#CloudService.getAccounts'))
  const out = inspector(page).locator('section.out')
  await expect(out.locator('.ref-group').first()).toContainText('rpc-call')
  await out.getByRole('button', { name: /^accountsRouter\.list/ }).click()
  await expect(title(page)).toHaveText('list')
  await expect(inspector(page)).toContainText('rpc:accounts.list')
  await inspector(page).locator('section.out').getByRole('button', { name: /^Account\b/ }).click()
  await expect(title(page)).toHaveText('Account')
  await expect(inspector(page)).toContainText('model')
  await expect(inspector(page).locator('section.in')).toContainText('accountsRouter.create')
})

test('a file shows the tests that reach it', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/lib/fake-libs.ts'))
  const tested = inspector(page).locator('section').filter({ hasText: /^Tested by/ })
  await expect(tested).toContainText('Tested by (1)')
  await expect(tested).toContainText('service.test.ts')
  await expect(tested).toContainText('through 2 files')
})

test('search finds procedures by their tRPC path and pages by route', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('accounts.create')
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('accountsRouter.create')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('/api/health')
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('route.ts')
})
