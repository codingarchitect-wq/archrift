import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// `serve --watch` on a copy of plain-ts (out/e2e/watch/repo): the tests edit it and put it back
const URL = serverUrl('watch')
const REPO = path.resolve(import.meta.dirname, '../../out/e2e/watch/repo')
const originals = new Map<string, string>()

const edit = (rel: string, change: (text: string) => string) => {
  const file = path.join(REPO, rel)
  if (!originals.has(file)) originals.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, change(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''))
}

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const buildings = (page: Page) => page.evaluate(() => window.__archrift.scene().objects.building)
const version = (page: Page) => page.evaluate(() => (window.__archrift.state() as unknown as { version: number }).version)

test.beforeEach(async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
})

test.afterEach(async () => {
  for (const [file, text] of originals) {
    if (text) fs.writeFileSync(file, text)
    else fs.rmSync(file, { force: true })
  }
  originals.clear()
  await new Promise(r => setTimeout(r, 1500)) // let the server catch up before the next test loads
})

test('saving a file updates the open file and the city, keeping the selection', async ({ page }) => {
  await expect(page.getByRole('status', { name: 'Live updates' })).toContainText('watching')
  await page.evaluate(() => window.__archrift.select('f:src/util.ts'))
  const symbols = inspector(page).locator('section').filter({ hasText: /^Symbols/ })
  await expect(symbols.getByRole('heading')).toHaveText('Symbols (5)')
  const before = await version(page)

  edit('src/util.ts', t => `${t}\nexport function twice(n: number) {\n  return n * 2\n}\n`)
  await expect(page.getByRole('status', { name: 'Live updates' })).toContainText('updated', { timeout: 15_000 })
  expect(await version(page)).toBe(before + 1)
  await expect(symbols.getByRole('heading')).toHaveText('Symbols (6)')
  await expect(symbols.getByRole('button', { name: /^twice/ })).toBeVisible()
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBe('f:src/util.ts')
})

test('a new file rises as a building and a deleted one sinks', async ({ page }) => {
  await page.waitForFunction(() => window.__archrift.idle())
  const start = await buildings(page)
  edit('src/extra.ts', () => "import { round } from './util'\nexport const r = round(2.345)\n")
  await expect.poll(() => buildings(page), { timeout: 15_000 }).toBe(start + 1)
  await page.evaluate(() => window.__archrift.select('f:src/extra.ts'))
  await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('extra.ts')

  fs.rmSync(path.join(REPO, 'src/extra.ts'))
  await expect.poll(() => buildings(page), { timeout: 15_000 }).toBe(start)
})
