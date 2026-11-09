import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(100)
}
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
})
test.afterEach(() => expect(errors).toEqual([]))

test('clicking a building selects its file, opens its floors and draws its references', async ({ page }) => {
  const pos = await page.evaluate(() => window.__archrift.screenPosition('f:src/util.ts'))
  expect(pos).not.toBeNull()
  await page.mouse.click(pos!.x, pos!.y + 2)
  await expect(title(page)).toHaveText('util.ts')
  await settle(page)
  const scene = await page.evaluate(() => window.__archrift.scene())
  expect(scene.objects.floor).toBe(5) // round, parse, clamp, unused, onlyTested
  expect(scene.highlighted).toBeGreaterThan(0)
  await expect(inspector(page).getByRole('button', { name: /^clamp/ })).toBeVisible()

  // a floor is clickable too
  const floor = await page.evaluate(() => window.__archrift.screenPosition('s:src/util.ts#clamp'))
  await page.mouse.click(floor!.x, floor!.y - 1)
  await expect(title(page)).toHaveText('clamp')
})

test('search, follow a reference, and come back', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('makeCircle')
  await expect(page.getByRole('option', { name: /makeCircle/ }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(title(page)).toHaveText('makeCircle')

  // Referenced by → calls → main
  await inspector(page).getByRole('button', { name: /^main\b/ }).click()
  await expect(title(page)).toHaveText('main')
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toContainText('app.ts')

  await page.getByRole('button', { name: 'Back' }).click()
  await expect(title(page)).toHaveText('makeCircle')
  await page.getByRole('button', { name: 'Forward' }).click()
  await expect(title(page)).toHaveText('main')
})

test('interfaces show who implements them, member by member', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('s:src/types.ts#Shape'))
  await expect(title(page)).toHaveText('Shape')
  const implementedBy = inspector(page).locator('section.in')
  await expect(implementedBy).toContainText('implements')
  // Base implements Shape and, through its members, area and name
  await expect(implementedBy.getByRole('button', { name: /^Base\b/ })).toContainText('via area, name')
  await implementedBy.getByRole('button', { name: /^Base\b/ }).click()
  await expect(title(page)).toHaveText('Base')
})

test('reference sites and symbol source open in the source panel, highlighted', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('s:src/shapes.ts#Circle'))
  await expect(title(page)).toHaveText('Circle')
  // who instantiates Circle, and where
  const instantiates = inspector(page).locator('section.in .ref-group').filter({ has: page.getByRole('heading', { name: /^instantiates/ }) })
  await instantiates.getByRole('button', { name: 'Show places' }).click()
  await instantiates.getByRole('button', { name: 'shapes.ts:32' }).click()
  const source = page.getByRole('region', { name: 'Source' })
  await expect(source.locator('.line.focus')).toContainText('return new Circle(r)')

  await inspector(page).getByRole('button', { name: 'View source' }).click()
  await expect(source).toContainText('export class Circle extends Base')
  await expect(source.locator('.code span[style]').first()).toBeVisible() // Shiki tokens
  await page.getByRole('button', { name: 'Close source' }).click()
  await expect(source).toHaveCount(0)
})

test('breadcrumbs move up to a directory', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('s:src/util.ts#round'))
  await page.getByRole('navigation', { name: 'Breadcrumbs' }).getByRole('button', { name: 'src', exact: true }).click()
  await expect(title(page)).toHaveText('src')
  await expect(inspector(page)).toContainText('Contents (9)')
})

test('a link with a node in its hash opens on that node', async ({ page }) => {
  await page.goto(`/#n=${encodeURIComponent('s:src/lazy.ts#load')}`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await expect(title(page)).toHaveText('load')
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBe('s:src/lazy.ts#load')
})

test('selecting a test file shows the hidden tests', async ({ page }) => {
  await expect(page.getByRole('checkbox', { name: 'tests' })).not.toBeChecked()
  await page.evaluate(() => window.__archrift.select('f:tests/shapes.test.ts'))
  await expect(title(page)).toHaveText('shapes.test.ts')
  await expect(page.getByRole('checkbox', { name: 'tests' })).toBeChecked()
})

test('switches between City, Layers and Galaxy, keeping the selection', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('s:src/shapes.ts#makeCircle'))
  await settle(page)
  const scene = () => page.evaluate(() => window.__archrift.scene())

  await page.getByRole('button', { name: 'Layers' }).click()
  await settle(page)
  let s = await scene()
  expect(s.view).toBe('layers')
  expect(s.objects.plane).toBeGreaterThan(0)
  expect(s.highlighted).toBeGreaterThan(0)
  // no layers configured in this fixture: levels come from the dependencies
  await expect(page.getByRole('combobox', { name: 'layers' })).toHaveValue('auto')
  await expect(title(page)).toHaveText('makeCircle')

  await page.keyboard.press('3')
  await settle(page)
  s = await scene()
  expect(s).toMatchObject({ view: 'galaxy', shape: 'sphere' })
  expect(s.objects.floor).toBe(3) // Base, Circle, makeCircle as moons of shapes.ts
  expect(s.highlighted).toBeGreaterThan(0)

  // a star can be clicked
  const star = await page.evaluate(() => window.__archrift.screenPosition('f:src/lazy.ts'))
  await page.mouse.click(star!.x, star!.y)
  await expect(title(page)).toHaveText('lazy.ts')

  await page.keyboard.press('1')
  await settle(page)
  expect(await scene()).toMatchObject({ view: 'city', shape: 'box' })
  await expect(title(page)).toHaveText('lazy.ts')
})

test('filters hide files and live in the URL', async ({ page }) => {
  const buildings = () => page.evaluate(() => window.__archrift.scene().objects.building)
  const before = await buildings()
  await page.getByRole('button', { name: /^Filters/ }).click()
  const hide = page.getByLabel('Hide files matching (globs)')
  await hide.fill('src/cycle-*.ts')
  await hide.press('Enter')
  await settle(page)
  expect(await buildings()).toBe(before - 2)
  expect(page.url()).toContain('hide=src%2Fcycle-*.ts')
  await page.reload()
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  expect(await buildings()).toBe(before - 2)
})

test('focus follows dependencies to a depth; impact follows everything that depends on it', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/util.ts'))
  await settle(page)
  const focus = inspector(page).getByRole('region', { name: 'Focus' })
  await expect(focus).toContainText('used by 3')
  await focus.getByRole('button', { name: 'Impact' }).click()
  await expect(focus.getByRole('button', { name: 'used by' })).toHaveAttribute('aria-pressed', 'true')
  await expect(focus.getByLabel('Focus depth')).toHaveValue('0')
  // util ← shapes ← index ← app: app reaches it through two steps as well
  await expect(focus).toContainText('used by 3 directly or not')
  expect(await page.evaluate(() => window.__archrift.scene().highlighted)).toBeGreaterThan(0)
})

test('the path finder shows how one file reaches another, either way round', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/app.ts'))
  await settle(page)
  await inspector(page).getByRole('button', { name: 'Find path…' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'pick where to' })).toBeVisible()
  await page.evaluate(() => window.__archrift.select('f:src/types.ts'))
  const panel = page.getByRole('region', { name: 'Path' })
  await expect(panel).toContainText('app.ts reaches types.ts in 2 steps')
  await expect(panel.locator('ol.path').first()).toContainText('app.ts')
  await panel.getByRole('button', { name: '⇄' }).click()
  await expect(panel).toContainText('types.ts doesn’t reach app.ts')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

test('a directory lists its import cycles and detected modules; both can be opened', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('d:src'))
  await settle(page)
  const cycles = inspector(page).locator('section.cycles')
  await expect(cycles).toContainText('Import cycles (1)')
  await cycles.getByRole('button', { name: /2 files in a cycle/ }).click()
  await expect(title(page)).toHaveText('2 files that import each other')
  await expect(inspector(page)).toContainText('cycle-a.ts')

  await page.evaluate(() => window.__archrift.select('d:src'))
  const modules = inspector(page).locator('section.modules')
  await expect(modules).toContainText('Detected modules')
  await modules.getByRole('button', { name: /^module 1/ }).click()
  await settle(page)
  await expect(title(page)).toHaveText('Module 1')
  expect(await page.evaluate(() => window.__archrift.state().options.groupBy)).toBe('community')
  expect(await page.evaluate(() => window.__archrift.scene().objects.district)).toBeGreaterThan(2)
})

test('a view can be saved and brought back', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('s:src/shapes.ts#Circle'))
  await page.getByRole('button', { name: 'Layers' }).click()
  await settle(page)
  await page.getByRole('button', { name: /^Saved views/ }).click()
  await page.getByLabel('View name').fill('Circle in layers')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Saved views' }).getByRole('button', { name: /^Circle in layers/ })).toBeVisible()

  await page.keyboard.press('Escape') // closes the menu, keeps the selection
  await expect(page.getByRole('dialog', { name: 'Saved views' })).toHaveCount(0)
  await expect(title(page)).toHaveText('Circle')
  await page.getByRole('button', { name: 'City' }).click()
  await page.evaluate(() => window.__archrift.select('f:src/app.ts'))
  await settle(page)
  await page.getByRole('button', { name: /^Saved views/ }).click()
  await page.getByRole('dialog', { name: 'Saved views' }).getByRole('button', { name: /^Circle in layers/ }).click()
  await settle(page)
  expect(await page.evaluate(() => window.__archrift.scene().view)).toBe('layers')
  await expect(title(page)).toHaveText('Circle')

  await page.getByRole('button', { name: /^Saved views/ }).click()
  await page.getByRole('button', { name: 'Delete view Circle in layers' }).click()
  await expect(page.getByRole('dialog', { name: 'Saved views' })).toContainText('No saved views yet.')
})

test("a selection shows only its own connections; everyone's come back when it's cleared", async ({ page }) => {
  const arcs = () => page.evaluate(() => window.__archrift.scene())
  expect((await arcs()).arcs).toBeGreaterThan(0) // nothing selected: everyone's dependencies
  await page.evaluate(() => window.__archrift.select('f:src/app.ts'))
  await settle(page)
  expect(await arcs()).toMatchObject({ arcs: 0 })
  expect((await arcs()).highlighted).toBeGreaterThan(0)
  // `all` keeps everyone's, selection or not
  await page.evaluate(() => window.__archrift.setOptions({ edges: 'all' }))
  await settle(page)
  expect((await arcs()).arcs).toBeGreaterThan(0)
  await page.evaluate(() => window.__archrift.setOptions({ edges: 'auto' }))
  await page.keyboard.press('Escape')
  await settle(page)
  expect((await arcs()).arcs).toBeGreaterThan(0)
})

test('scrolling zooms toward the pointer: what is under it stays under it', async ({ page }) => {
  // a building off the middle of the screen
  const before = await page.evaluate(() => window.__archrift.screenPosition('f:src/shapes.ts'))
  expect(before).not.toBeNull()
  const middle = { x: 1400 / 2, y: 880 / 2 }
  expect(Math.hypot(before!.x - middle.x, before!.y - middle.y)).toBeGreaterThan(40)
  await page.mouse.move(before!.x, before!.y)
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(60)
  }
  await settle(page)
  const after = await page.evaluate(() => window.__archrift.screenPosition('f:src/shapes.ts'))
  // zooming toward the middle would push it outward, away from the pointer
  expect(Math.hypot(after!.x - before!.x, after!.y - before!.y)).toBeLessThan(25)
})
