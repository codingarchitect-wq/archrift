import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// Classes on the plain-ts fixture: its one family, the interface Shape, the abstract Base implementing it
// and Circle extending Base (cards 0, 1 and 2); its folder src adds the type Point and the enum Unit.
const URL = serverUrl('plainTs')
const CIRCLE = 's:src/shapes.ts#Circle'

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task && window.__archrift.scene().view === 'classes')
  await page.waitForTimeout(200)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const at = async (page: Page, id: string) => {
  const p = await page.evaluate(id => window.__archrift.screenPosition(id), id)
  expect(p, id).not.toBeNull()
  return p!
}
const selected = (page: Page) => page.evaluate(() => window.__archrift.state().selected)
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })
const legend = (page: Page) => page.getByRole('complementary', { name: 'Legend' })
const views = (page: Page) => page.getByRole('group', { name: 'View' })
const label = (page: Page, css: string, text: string | RegExp) => page.locator(css, { hasText: text }).filter({ visible: true })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the Diagrams menu opens the biggest family as a class diagram, and City brings the city back', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: /^Diagrams/ }).click()
  await page.getByRole('menuitemradio', { name: /^Classes/ }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=classes/)
  await expect(views(page).getByRole('button', { name: /^Diagrams · Classes/ })).toHaveAttribute('aria-pressed', 'true')
  const s = await scene(page)
  expect(s.arcs).toBe(0)
  expect(s.objects.building).toBe(3)
  expect(s.decoration).toMatchObject({ boards: 1, cards: 3, types: 3, links: 2, extends: 1, implements: 1, associations: 0, outside: 0, focused: 0 })
  expect(s.decoration!.glyphs).toBeGreaterThan(60)
  await expect(page.getByRole('button', { name: 'Family: Shape ▾' })).toBeVisible()
  await expect(label(page, '.label.a42-heading', 'Shape · 3 types')).toBeVisible()
  await expect(legend(page)).toContainText('Shape: 3 types, 1 extends, 1 implements, 0 associations')

  await views(page).getByRole('button', { name: 'City' }).click()
  await page.waitForFunction(() => window.__archrift.idle() && window.__archrift.scene().view === 'city')
  expect((await scene(page)).decoration).toBeNull()
  await expect(page.getByRole('button', { name: /^Family:/ })).toHaveCount(0)
})

test('a card selects its type and lights its relatives; a member row selects the member', async ({ page }) => {
  await page.goto(`${URL}?view=classes`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)

  // the title band (where the card's title label is anchored)
  const band = await at(page, 'classes:title:2')
  await page.mouse.click(band.x, band.y)
  await expect(title(page)).toHaveText('Circle')
  await settle(page)
  // Circle and the Base it extends; the interface further up fades
  expect((await scene(page)).decoration).toMatchObject({ focused: 2, focusLinks: 1, opened: 0 })

  // between the band and the card's middle: its first property's row
  const middle = await at(page, 'classes:card:2')
  await page.mouse.click(band.x, (band.y + middle.y) / 2)
  await expect.poll(() => selected(page)).toMatch(/^s:src\/shapes\.ts#Circle\./)
  await settle(page)
  // a member stands for its type: the same card stays in focus
  expect((await scene(page)).decoration).toMatchObject({ focused: 2 })

  // Escape clears the selection
  await page.keyboard.press('Escape')
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ focused: 0 })
})

test('folder mode shows the types of the selected one’s folder; a family picked shows that family', async ({ page }) => {
  await page.goto(`${URL}?view=classes`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await page.evaluate(id => window.__archrift.select(id), CIRCLE)
  await settle(page)

  await page.getByRole('group', { name: 'Class diagram of' }).getByRole('button', { name: 'folder' }).click()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Folder: src ▾' })).toBeVisible()
  // Base and Circle (shapes.ts), Shape, the type Point and the enum Unit (types.ts)
  expect((await scene(page)).decoration).toMatchObject({ cards: 5, links: 2, focused: 2 })
  await expect(label(page, '.label.a42-heading', 'src · 5 types')).toBeVisible()

  await page.getByRole('button', { name: 'Folder: src ▾' }).click()
  await expect(page.getByRole('menu', { name: 'Folders' }).getByRole('menuitemradio', { name: /^src\s*5 types$/ })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('group', { name: 'Class diagram of' }).getByRole('button', { name: 'family' }).click()
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ cards: 3 })
  await page.getByRole('button', { name: 'Family: Shape ▾' }).click()
  await page.getByRole('menuitemradio', { name: /^Shape/ }).click()
  await settle(page)
  expect((await scene(page)).decoration).toMatchObject({ cards: 3, focused: 2 })
})
