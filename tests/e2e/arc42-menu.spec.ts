import { expect, test } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The arc42 views share one toolbar button (ViewPlugin.group): a menu of the
// five sections, the one shown named on the button; its key steps through them.
const URL = serverUrl('fullstack')

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('one toolbar button holds the arc42 views, and its key steps through them', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  const views = page.getByRole('group', { name: 'View' })
  const arc42 = views.getByRole('button', { name: /^arc42/ })
  await expect(arc42).toHaveAttribute('aria-pressed', 'false')

  await arc42.click()
  const items = page.getByRole('menu', { name: 'arc42 views' }).getByRole('menuitemradio')
  await expect(items).toHaveText([/^§3 Context/, /^§5 Building blocks/, /^§6 Runtime/, /^§8 Crosscutting/, /^§11 Risks & debt/])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'arc42 views' })).toHaveCount(0)

  // the ninth toolbar entry: the first section, then the next one
  await page.locator('body').press('9')
  await expect(page).toHaveURL(/view=context/)
  await expect(arc42).toHaveAttribute('aria-pressed', 'true')
  await expect(arc42).toContainText('§3 Context')
  await page.locator('body').press('9')
  await expect(page).toHaveURL(/view=blocks/)
  await expect(arc42).toContainText('§5 Building blocks')

  await arc42.click()
  await expect(page.getByRole('menuitemradio', { name: /^§5 Building blocks/ })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitemradio', { name: /^§11 Risks & debt/ }).click()
  await expect(page).toHaveURL(/view=risks/)
  await page.locator('body').press('1')
  await expect(page).toHaveURL(/^[^?]*\/(\?(?!.*view=).*)?$/) // City is the default: no view in the URL
  await expect(arc42).toHaveAttribute('aria-pressed', 'false')
})

test('the toolbar’s grouping regroups the building blocks, and is gone where it means nothing', async ({ page }) => {
  await page.goto(`${URL}?view=blocks&group=layer`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await expect(page.locator('.label.a42-heading', { hasText: /^Level 1 · fullstack · by layer$/ })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'group' })).toHaveValue('layer')
  // a context's tower and a risk matrix don't group: no option for it there
  for (const view of ['context', 'risks']) {
    await page.evaluate(v => window.__archrift.setOptions({ view: v }), view)
    await expect(page.getByRole('combobox', { name: 'group' })).toHaveCount(0)
  }
  await page.evaluate(() => window.__archrift.setOptions({ view: 'crosscutting' }))
  await expect(page.getByRole('combobox', { name: 'group' })).toHaveValue('layer')
})
