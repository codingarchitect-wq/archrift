import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'

// `archrift export html`: the viewer and the fullstack fixture in one file, opened
// from disk with every request but the file itself failed. The static viewer
// comes from `npm run build` (playwright.config.ts runs it before the servers).
const OUT = path.resolve('out/e2e/export')
const VIEWS = path.join(OUT, 'views')
const PLAIN = path.join(OUT, 'fullstack.html')
const WITH_SOURCE = path.join(OUT, 'fullstack-source.html')

const exportHtml = (...args: string[]) =>
  execFileSync(process.execPath, ['src/cli/main.ts', 'export', 'html', 'fixtures/fullstack', '--no-history', '--no-cache', '--views', VIEWS, '--quiet', ...args], { encoding: 'utf8' })

test.beforeAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(VIEWS, { recursive: true })
  fs.writeFileSync(path.join(VIEWS, 'pages.json'), JSON.stringify({ name: 'Requests', state: { options: { view: 'transit' }, selected: null } }))
  exportHtml('--view', 'wheel', '--out', PLAIN)
  exportHtml('--source', '--out', WITH_SOURCE)
})

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(100)
}

let problems: string[] = []

/** Opens an exported file the way a reader would: from disk, with no network (any request but the file fails, and counts). */
async function open(page: Page, file: string) {
  problems = []
  const url = pathToFileURL(file).href
  page.on('pageerror', e => problems.push(`page error: ${e.message}`))
  page.on('console', m => void (m.type() === 'error' && problems.push(`console: ${m.text()}`)))
  await page.route('**/*', route => {
    const asked = route.request().url()
    if (asked.split(/[?#]/)[0] === url) return route.continue()
    problems.push(`request: ${asked}`)
    return route.abort()
  })
  // the first-visit hint has been seen (a page from disk has an origin of its own)
  await page.addInitScript(() => localStorage.setItem('archrift.hint.seen', '1'))
  await page.goto(url)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
}

test.afterEach(() => expect(problems).toEqual([]))

test('opens from disk on the view it was exported with; another view, search, the inspector and Impact work offline', async ({ page }) => {
  await open(page, PLAIN)
  expect(new URL(page.url()).search).toBe('?view=wheel')
  await expect(page.getByRole('button', { name: 'Wheel', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await scene(page)).toMatchObject({ view: 'wheel', objects: { building: 14 } })
  await expect(page).toHaveTitle(/^fullstack · archrift$/)

  // another view: the galaxy's layout runs in a worker inlined in the file
  await page.getByRole('button', { name: 'Galaxy', exact: true }).click()
  await settle(page)
  expect(await scene(page)).toMatchObject({ view: 'galaxy', shape: 'sphere', objects: { building: 14 } })
  expect(new URL(page.url()).search).toBe('?view=galaxy')

  // search finds a symbol; the inspector shows it, with what uses it
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('getAccounts')
  await expect(page.getByRole('option', { name: /getAccounts/ }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(title(page)).toHaveText('getAccounts')
  await expect(inspector(page).getByRole('button', { name: /^CloudService/ }).first()).toBeVisible()
  await expect(inspector(page).getByRole('link', { name: 'Open in VS Code' })).toHaveCount(0)

  // a file's details: its symbols, and Impact over its users
  await page.evaluate(() => window.__archrift.select('f:src/client/service.ts'))
  await expect(title(page)).toHaveText('service.ts')
  await expect(inspector(page).getByRole('button', { name: /^CloudService/ })).toBeVisible()
  await inspector(page).getByRole('button', { name: 'Impact' }).click()
  await expect(inspector(page).getByRole('region', { name: 'Focus' })).toContainText('used by 2 directly or not')
  expect(new URL(page.url()).hash).toBe(`#n=${encodeURIComponent('f:src/client/service.ts')}`)

  // the source isn't in this export: the panel says so
  await inspector(page).getByRole('button', { name: 'View source' }).first().click()
  await expect(page.getByRole('region', { name: 'Source' })).toContainText("The source isn't in this export")
})

test("every view on the toolbar draws from the file, menus' views too", async ({ page }) => {
  await open(page, PLAIN)
  const shown = async () => {
    await settle(page)
    const view = new URL(page.url()).searchParams.get('view') ?? 'city'
    expect((await scene(page)).view).toBe(view)
    return view
  }
  const seen = new Set<string>()
  const toolbar = page.getByRole('group', { name: 'View' })
  for (const button of await toolbar.getByRole('button').all()) {
    if ((await button.getAttribute('aria-haspopup')) !== 'menu') {
      await button.click()
      seen.add(await shown())
      continue
    }
    const items = (await button.click(), page.getByRole('menuitemradio'))
    const count = await items.count()
    await page.keyboard.press('Escape')
    for (let i = 0; i < count; i++) {
      await button.click()
      await page.getByRole('menuitemradio').nth(i).click()
      seen.add(await shown())
    }
  }
  expect(seen.size).toBeGreaterThanOrEqual(12) // City, Layers, Galaxy and the plug-ins
})

test('find path, rules and saved views work; saving views and switching projects are not offered', async ({ page }) => {
  await open(page, PLAIN)
  await page.evaluate(() => window.__archrift.select('f:src/app/(shop)/accounts/page.tsx'))
  await expect(title(page)).toHaveText('page.tsx')
  await inspector(page).getByRole('button', { name: 'Find path…' }).click()
  await page.evaluate(() => window.__archrift.select('f:src/client/trpc.ts'))
  await expect(page.getByRole('region', { name: 'Path' })).toContainText('reaches trpc.ts in 2 steps')

  await page.getByRole('button', { name: /^Rules/ }).click()
  await page.getByRole('region', { name: 'Rule pages-use-services' }).getByRole('button', { name: /^accounts\/page\.tsx → fake-libs\.ts/ }).click()
  await expect(title(page)).toHaveText('pages-use-services')
  await expect(inspector(page)).toContainText('fake-libs.ts is outside what accounts/page.tsx may depend on.')

  await page.getByRole('button', { name: /^Saved views/ }).click()
  const menu = page.getByRole('dialog', { name: 'Saved views' })
  await expect(menu).toContainText('This page is an export')
  await expect(menu.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await expect(menu.getByRole('textbox', { name: 'View name' })).toHaveCount(0)
  await expect(menu.getByRole('button', { name: /^Delete view/ })).toHaveCount(0)
  await menu.getByRole('button', { name: /^Requests/ }).click()
  await settle(page)
  expect((await scene(page)).view).toBe('transit')

  await expect(page.getByRole('button', { name: /^Project:/ })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Live updates' })).toHaveCount(0)
})

test('with --source, the source panel shows a file, highlighted', async ({ page }) => {
  await open(page, WITH_SOURCE)
  expect(new URL(page.url()).search).toBe('') // exported without --view: the City
  expect((await scene(page)).view).toBe('city')
  await page.evaluate(() => window.__archrift.select('s:src/client/service.ts#CloudService'))
  await expect(title(page)).toHaveText('CloudService')
  await inspector(page).getByRole('button', { name: 'View source' }).first().click()
  const source = page.getByRole('region', { name: 'Source' })
  await expect(source).toContainText('export class CloudService')
  await expect(source).toContainText('return trpc.accounts.list.query()')
  await expect(source.locator('.code span[style]').first()).toBeVisible() // shiki's tokens, from the module the file carries
})
