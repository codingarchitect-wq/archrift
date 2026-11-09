import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// `serve fixtures/plain-ts fixtures/fullstack` with its own project list (playwright.config.ts)
const URL = serverUrl('projects')
const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures')

// asked outside the page: switching the project reloads it, which would cut an evaluate short
const info = async (page: Page) => (await (await page.request.get(`${URL}api/info`)).json()) as { name: string; project: string }
const ready = (page: Page) => page.waitForFunction(() => window.__archrift?.ready() && window.__archrift.idle(), null, { timeout: 60_000 })

// every test starts on plain-ts
test.beforeEach(async ({ page }) => {
  await page.goto(URL)
  await ready(page)
  if ((await info(page)).project !== 'plain-ts') {
    await page.evaluate(() => fetch('/api/projects/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"plain-ts"}' }))
    await expect.poll(async () => (await info(page)).project, { timeout: 60_000 }).toBe('plain-ts')
    // the open page starts over on the project by itself: wait for that instead of racing it with a goto
    await page.waitForURL(/[?&]project=plain-ts/, { timeout: 60_000 })
    await ready(page)
  }
})

test('the project menu lists the projects and opens another one', async ({ page }) => {
  const menu = page.getByRole('button', { name: 'Project: plain-ts' })
  await expect(menu).toHaveText('plain-ts ▾')
  await menu.click()
  const panel = page.getByRole('dialog', { name: 'Projects' })
  await expect(panel.locator('li')).toHaveCount(2)
  await expect(panel.locator('li').first()).toContainText('plain-ts · open')
  await panel.getByRole('button', { name: /^fullstack/ }).click()

  // the page starts over on the other project, and says so in its address
  await page.waitForURL(/[?&]project=fullstack/, { timeout: 60_000 })
  await ready(page)
  await expect(page.getByRole('button', { name: 'Project: fullstack' })).toBeVisible()
  await page.evaluate(() => window.__archrift.select('f:src/server/routers/accounts.ts'))
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { level: 2 })).toHaveText('accounts.ts')
})

test('a folder can be added by its path, and removed again', async ({ page }) => {
  await page.getByRole('button', { name: 'Project: plain-ts' }).click()
  const panel = page.getByRole('dialog', { name: 'Projects' })
  const folder = panel.getByLabel('Project folder')
  await folder.fill(path.join(FIXTURES, 'nowhere'))
  await folder.press('Enter')
  await expect(panel.locator('.error')).toContainText('not a folder')

  await folder.fill(path.join(FIXTURES, 'js-only'))
  await panel.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(panel.locator('li')).toHaveCount(3)
  await expect(panel.locator('li').last()).toContainText('not analyzed yet')
  await panel.getByRole('button', { name: 'Remove js-only' }).click()
  await expect(panel.locator('li')).toHaveCount(2)
  // the open project has nothing to remove it with
  await expect(panel.getByRole('button', { name: 'Remove plain-ts' })).toHaveCount(0)
})

test('a link to another project of the list opens it', async ({ page }) => {
  await page.goto(`${URL}?project=fullstack`)
  await page.waitForFunction(() => new URLSearchParams(location.search).get('project') === 'fullstack' && window.__archrift?.ready(), null, { timeout: 60_000 })
  await expect.poll(async () => (await info(page)).project, { timeout: 60_000 }).toBe('fullstack')
  await ready(page)
  await expect(page.getByRole('button', { name: 'Project: fullstack' })).toBeVisible()
})
