import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The Terrain view (src/viewer/views/terrain): the City's regions as a heightfield, files as
// hidden boxes on the ground, picked through the surface.

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(100)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const height = (page: Page) => page.getByRole('combobox', { name: 'height' })

/** The visible file with the highest metric: its peak is the highest, so nothing hides its summit from the camera. */
const hardest = (page: Page, metric: string) =>
  page.evaluate(metric => {
    const s = window.__archrift.state() as unknown as { world: { graph: { nodes: { id: string; kind: string; name: string; tags?: string[]; metrics?: Record<string, number> }[] } } }
    const files = s.world.graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test'))
    files.sort((a, b) => (b.metrics?.[metric] ?? 0) - (a.metrics?.[metric] ?? 0) || (a.id < b.id ? -1 : 1))
    return { id: files[0].id, name: files[0].name }
  }, metric)

let errors: string[] = []
test.beforeEach(({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the toolbar switches to the terrain: hidden file boxes on a heightfield with named peaks', async ({ page }) => {
  await page.goto(serverUrl('plainTs'))
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const city = await scene(page)
  await page.getByRole('button', { name: 'Terrain', exact: true }).click()
  await settle(page)
  expect(page.url()).toContain('view=terrain')
  const s = await scene(page)
  expect(s.view).toBe('terrain')
  // one box per file (and folder), as in the City, but the engine doesn't draw them
  expect(s.objects.building).toBe(city.objects.building)
  expect(s.objects.district).toBe(city.objects.district)
  expect(s.decoration).toMatchObject({ grid: 96, files: city.objects.building, metric: 0, boxesHidden: 1 })
  expect(s.decoration!.peaks).toBeGreaterThan(0)
  expect(s.arcs).toBeGreaterThan(0) // routed over the ground
  await expect(page.locator('.label.peak').first()).toContainText('▲')
  await expect(height(page)).toHaveValue('complexity')
})

test('clicking the ground over a file selects that file', async ({ page }) => {
  await page.goto(`${serverUrl('plainTs')}?view=terrain`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const peak = await hardest(page, 'complexity')
  const pos = await page.evaluate(id => window.__archrift.screenPosition(id), peak.id)
  expect(pos).not.toBeNull()
  // a little below the summit: the ray meets the slope facing the camera, still in the file's cell
  await page.mouse.click(pos!.x, pos!.y + 4)
  await expect(title(page)).toHaveText(peak.name)
  await settle(page)
  const s = await scene(page)
  expect(s.highlighted).toBeGreaterThan(0) // its dependencies, over the ground
  expect(s.objects.floor).toBeUndefined() // files don't open into floors here
  expect(s.decoration!.files).toBeGreaterThan(0) // still the terrain after the camera flew there
})

test('the height select raises the ground by another metric; churn and hotspots need a git history', async ({ page }) => {
  await page.goto(`${serverUrl('fullstack')}?view=terrain`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await expect(height(page).locator('option')).toHaveText(['complexity', 'lines']) // served with --no-history
  await height(page).selectOption('lines')
  await settle(page)
  const s = await scene(page)
  expect(s.decoration).toMatchObject({ metric: 3 })
  // the longest file is the highest peak now, and named
  const longest = await hardest(page, 'loc')
  await expect(page.locator('.label.peak').first()).toHaveText(`▲ ${longest.name}`)
  const pos = await page.evaluate(id => window.__archrift.screenPosition(id), longest.id)
  await page.mouse.click(pos!.x, pos!.y + 4)
  await expect(title(page)).toHaveText(longest.name)
})

test('with a history: churn raises the ground, and the timeline changes it in place', async ({ page }) => {
  await page.goto(`${serverUrl('history')}?view=terrain`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await expect(height(page).locator('option')).toHaveText(['complexity', 'churn', 'hotspots', 'lines'])
  await height(page).selectOption('churn')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ metric: 1, files: 4 }) // a, c, d, lib/b
  const box = (id: string) => page.evaluate(id => window.__archrift.screenPosition(id), id)
  const before = await box('f:src/a.ts')

  // back to the first snapshot: d.ts and lib/b.ts weren't there yet; the rest stay where they are
  const first = await page.evaluate(() => (window.__archrift.state() as unknown as { snapshots: { sha: string }[] }).snapshots[0].sha)
  await page.evaluate(at => window.__archrift.setOptions({ timeline: true, at }), first)
  await expect.poll(async () => (await scene(page)).decoration?.files).toBeLessThan(4)
  await settle(page)
  const s = await scene(page)
  expect(s.view).toBe('terrain')
  expect(s.objects.building).toBe(s.decoration!.files)
  const then = await box('f:src/a.ts')
  expect(Math.abs(then!.x - before!.x)).toBeLessThan(40) // same footprint; only its height may change
})

test('switching back to the City removes the terrain', async ({ page }) => {
  await page.goto(`${serverUrl('plainTs')}?view=terrain`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  expect((await scene(page)).decoration).not.toBeNull()
  await page.evaluate(() => window.__archrift.select('f:src/util.ts'))
  await settle(page)
  await page.getByRole('button', { name: 'City', exact: true }).click()
  await settle(page)
  const s = await scene(page)
  expect(s).toMatchObject({ view: 'city', decoration: null })
  expect(s.objects.floor).toBeGreaterThan(0) // the City opens the selected file again
  await expect(height(page)).toHaveCount(0)
  await expect(title(page)).toHaveText('util.ts')
})
