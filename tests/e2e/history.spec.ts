import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// tests/helpers/history-repo.ts: six commits from 2026-01-05 to 2026-06-01; a.ts and b.ts change
// together without importing each other, b.ts moves to lib/, d.ts arrives in May. Snapshots:
// 2026-01-05 (start), 2026-02-02 (a and b) and 2026-04-06 (move b into lib).
const URL = serverUrl('history')

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const buildings = (page: Page) => page.evaluate(() => window.__archrift.scene().objects.building)
const idle = (page: Page) => page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)

test.beforeEach(async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
})

test('the history panel sums up the log and ranks hotspots', async ({ page }) => {
  await page.getByRole('button', { name: /^History/ }).click()
  const panel = page.getByRole('dialog', { name: 'Git history' })
  await expect(panel).toContainText('6 commits by 1 author, 2026-01-05 to 2026-06-01')
  const hotspots = panel.getByRole('region', { name: 'Hotspots' }).getByRole('button')
  await expect(hotspots.first()).toContainText('1. a.ts')
  await expect(hotspots.first()).toContainText('8 lines changed × complexity 21')
  await panel.getByRole('button', { name: 'Hotspots', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__archrift.state().options.colorBy)).toBe('hotspot')
  await hotspots.first().click()
  await expect(title(page)).toHaveText('a.ts')
})

test('a file shows its history and the files that change with it', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/a.ts'))
  await expect(inspector(page).locator('dl.git')).toContainText('commits5')
  await expect(inspector(page).locator('dl.git')).toContainText('last change2026-05-04')
  const co = inspector(page).locator('section.co-changes')
  await expect(co.getByRole('heading')).toHaveText('Changes together with (1)')
  await expect(co.getByRole('button', { name: /b\.ts/ })).toContainText('no dependency')
  await expect(co.getByRole('button', { name: /b\.ts/ })).toContainText('5 commits together · 100%')
  await idle(page)
  const before = await page.evaluate(() => window.__archrift.scene().highlighted)
  await co.getByLabel('show as arcs').check()
  await idle(page)
  expect(await page.evaluate(() => window.__archrift.scene().highlighted)).toBe(before + 1)
  await co.getByRole('button', { name: /b\.ts/ }).click()
  await expect(title(page)).toHaveText('b.ts')
})

test('the timeline moves the city through the snapshots and back to now', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/d.ts'))
  await idle(page)
  expect(await buildings(page)).toBe(4) // a, c, d, lib/b
  await page.getByRole('button', { name: /^History/ }).click()
  await page.getByRole('button', { name: 'Open the timeline (3 snapshots)' }).click()
  const timeline = page.getByRole('group', { name: 'Timeline' })
  await expect(timeline).toContainText('now')
  const slider = timeline.getByRole('slider', { name: 'Point in time' })
  await expect(slider).toBeEnabled()

  await slider.focus()
  await page.keyboard.press('Home')
  await expect(timeline).toContainText('2026-01-05')
  await expect(timeline).toContainText('start')
  await idle(page)
  expect(await buildings(page)).toBe(3) // a, b, c
  // d.ts didn't exist yet
  await expect(inspector(page)).toContainText('Not there yet on 2026-01-05')

  // at the move, b.ts is in lib/; the change colors compare with the previous snapshot
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(timeline).toContainText('move b into lib')
  await idle(page)
  expect(await page.evaluate(() => window.__archrift.state().options.at)).toMatch(/^[0-9a-f]{40}$/)
  await page.evaluate(() => window.__archrift.select('f:src/lib/b.ts'))
  await expect(title(page)).toHaveText('b.ts')

  await page.keyboard.press('Escape')
  await timeline.getByRole('button', { name: 'Close timeline' }).click()
  await expect(timeline).toBeHidden()
  await idle(page)
  expect(await buildings(page)).toBe(4)
  expect(await page.evaluate(() => window.__archrift.state().options.at)).toBe('')
})

test('a link keeps the point in time', async ({ page }) => {
  const sha = await page.evaluate(async () => (await (await fetch('/api/snapshots')).json())[0].sha as string)
  await page.goto(`${URL}?timeline=true&at=${sha}`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await expect(page.getByRole('group', { name: 'Timeline' })).toContainText('2026-01-05')
  await idle(page)
  expect(await buildings(page)).toBe(3)
})
