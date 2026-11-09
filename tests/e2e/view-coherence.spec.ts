import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The Coherence view on the Kotlin fixture: order-service keeps its time in
// java.time (OrderClock) but stamps exports with a java.util.Date
// (LegacyStamp, which depends on OrderClock): one job, two ways in one block,
// a transition between them, and a migration half done.

const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(150)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const views = (page: Page) => page.getByRole('group', { name: 'View' })
const legend = (page: Page) => page.getByRole('complementary', { name: 'Legend' })
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test('the coherence view paints the city by the way each file does a job, and the report picks the job', async ({ page }) => {
  await page.goto(serverUrl('kotlin'))
  await page.waitForFunction(() => window.__archrift?.ready())
  await views(page).getByRole('button', { name: 'Coherence' }).click()
  await settle(page)
  await expect(page).toHaveURL(/view=coherence/)
  const s = await scene(page)
  expect(s.view).toBe('coherence')
  expect(s.objects.building).toBeGreaterThan(0)
  // all jobs: no transitions drawn, the heading counts the mixed jobs
  expect(s.decoration).toMatchObject({ transitions: 0, clouds: 0 })
  await expect(page.locator('.label.coh-heading')).toContainText('1 of 7 jobs are done more than one way inside a folder')
  await expect(legend(page)).toContainText('does every job the way its folder does')

  // the report: the mixed job first, its bar and how coherent it is within blocks
  const button = page.getByRole('button', { name: /^All jobs \d+ mixed ▾$/ })
  await expect(button).toContainText('1 mixed')
  await button.click()
  const report = page.getByRole('dialog', { name: 'Coherence report' })
  await expect(report).toContainText('A job is something code does that has several common solutions')
  await expect(report).toContainText('1 mixed · 0 one way per folder · 6 one way')
  await expect(report.locator('.coh-columns')).toContainText('same as folder')
  const rows = report.locator('.coh-list > li > .coh-row')
  await expect(rows.first()).toContainText('JVM · Dates')
  await expect(rows.first()).toContainText('50 %')
  await rows.first().click()
  await settle(page)

  // the job shown: its ways in the key, the transition between them drawn, the migration in the details
  await expect(page.getByRole('button', { name: /^JVM · Dates \d+ mixed ▾$/ })).toBeVisible()
  await expect(legend(page)).toContainText('java.time · 1')
  await expect(legend(page)).toContainText('java.util.Date / Calendar (legacy) · 1')
  await expect(legend(page)).toContainText('transition: a dependency between two ways')
  await expect.poll(async () => (await scene(page)).decoration?.transitions).toBe(1)
  expect((await scene(page)).arcs).toBe(0) // the automatic background arcs stay out of this view
  await expect(report).toContainText('Migration java.util.Date / Calendar → java.time: 50 % done, 1 file left')
  await expect(page.locator('.label.coh-heading')).toContainText('JVM · Dates: java.time 1 · java.util.Date / Calendar 1')

  // a file off its block's way selects its building
  await report.getByRole('button', { name: 'LegacyStamp.kt' }).click()
  await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('LegacyStamp.kt')
  await settle(page)
  // the selection keeps its transition: it touches LegacyStamp
  await expect.poll(async () => (await scene(page)).decoration?.transitions).toBe(1)
  // the toolbar's edges option: none hides it, selection keeps it (it's the selection's); this project has no rules to break
  const edges = page.getByRole('combobox', { name: 'edges' })
  await edges.selectOption('none')
  await expect.poll(async () => (await scene(page)).decoration?.transitions).toBe(0)
  await expect(legend(page)).not.toContainText('transition: a dependency between two ways')
  await edges.selectOption('selection')
  await expect.poll(async () => (await scene(page)).decoration?.transitions).toBe(1)
  await edges.selectOption('auto')
  await expect.poll(async () => (await scene(page)).decoration?.transitions).toBe(1)

  // back to all jobs (the report stays open while it's used), then to the city
  await report.getByRole('button', { name: /^All jobs/ }).click()
  await settle(page)
  await expect.poll(async () => (await scene(page)).decoration?.transitions).toBe(0)
  await views(page).getByRole('button', { name: 'City' }).click()
  await settle(page)
  const city = await scene(page)
  expect(city.view).toBe('city')
  expect(city.decoration).toBeNull()
  await expect(page.getByRole('button', { name: /^All jobs \d+ mixed ▾$/ })).toHaveCount(0)
})

test('a job of the tests says the tests are hidden, and shows them on request', async ({ page }) => {
  await page.goto(`${serverUrl('kotlin')}?view=coherence`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  const before = (await scene(page)).objects.building
  await page.getByRole('button', { name: /^All jobs \d+ mixed ▾$/ }).click()
  const report = page.getByRole('dialog', { name: 'Coherence report' })
  // the fixture's one test runs on JUnit 5: a job of the tests, done one way
  const row = report.locator('.coh-row', { hasText: 'JVM · Test framework' })
  await expect(row.locator('.coh-tag')).toHaveText('tests')
  await row.click()
  await settle(page)
  await expect(legend(page)).toContainText('JUnit 5 · 1')
  await expect(legend(page)).toContainText('a job of the tests, which are hidden')
  await legend(page).getByRole('button', { name: 'show tests' }).click()
  await settle(page)
  await expect(page.getByRole('checkbox', { name: 'tests' })).toBeChecked()
  await expect(legend(page)).not.toContainText('which are hidden')
  expect((await scene(page)).objects.building).toBe(before + 1)
})

test('clouds: one dot per file, a cloud per job done several ways, and a click opens it', async ({ page }) => {
  await page.goto(`${serverUrl('kotlin')}?view=coherence`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await page.getByRole('group', { name: 'Coherence as' }).getByRole('button', { name: 'Clouds' }).click()
  // the dots' places are worked out in a worker
  await expect.poll(async () => (await scene(page)).decoration?.clouds, { timeout: 15_000 }).toBe(1)
  await settle(page)
  // only the dates are done two ways: one cloud, every production file doing some job a dot in it
  const d = (await scene(page)).decoration!
  expect(d.dots).toBe(8)
  expect(d.crossings).toBe(1) // LegacyStamp (java.util.Date) → OrderClock (java.time)
  await expect(page.locator('.label.coh-heading')).toContainText('one dot per file, one cloud per job')
  await expect(page.locator('.label.coh-caption')).toContainText('JVM · Dates · 50 % same way')
  await expect(legend(page)).toContainText('colors gathered: coherent')
  // how to read a cloud, after the essay's legend
  await expect(legend(page)).toContainText('Dot a file doing some job')
  await expect(legend(page)).toContainText('Size its lines of code')
  await expect(legend(page)).toContainText('Color the way it does its cloud’s job')
  await expect(legend(page)).toContainText('Line one file depends on the other')

  // the toolbar's edges option picks the lines: none, the selection's (none without one), back to all
  const edges = page.getByRole('combobox', { name: 'edges' })
  await edges.selectOption('none')
  await expect.poll(async () => (await scene(page)).decoration).toMatchObject({ dots: 8, lines: 0, crossings: 0 })
  await expect(legend(page)).toContainText('Line none drawn (edges: none)')
  await edges.selectOption('selection')
  await expect(legend(page)).toContainText('none until a file is selected')
  expect((await scene(page)).decoration).toMatchObject({ lines: 0, crossings: 0 })
  await edges.selectOption('auto')
  await expect.poll(async () => (await scene(page)).decoration?.crossings).toBe(1)
  expect((await scene(page)).decoration?.lines).toBeGreaterThan(0)

  // by folder: every dot in its folder's color, the culprit ringed; back by way, no rings
  const paint = page.getByRole('group', { name: 'Color the dots' })
  await paint.getByRole('button', { name: 'by folder' }).click()
  await settle(page)
  await expect.poll(async () => (await scene(page)).decoration?.rings).toBe(1) // LegacyStamp: java.util.Date among java.time
  await expect(legend(page)).toContainText('does the job differently from its folder')
  await expect(legend(page)).toContainText('Color its folder')
  await expect(legend(page)).toContainText('order-service/src/main/kotlin/com/acme/order')
  await paint.getByRole('button', { name: 'by way' }).click()
  await settle(page)
  await expect.poll(async () => (await scene(page)).decoration?.rings).toBe(0)

  // a click on a dot opens its cloud and selects its file (a dot the toolbar or a panel doesn't cover)
  const files = ['LegacyStamp', 'OrderClock', 'OrderService', 'Order', 'OrderController', 'OrderRepository', 'PaymentListener', 'TopicProperties']
  const dot = await page.evaluate(names => {
    for (const name of names) {
      const p = window.__archrift.screenPosition(`f:order-service/src/main/kotlin/com/acme/order/${name}.kt`)
      if (p && document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS') return { name, ...p }
    }
    return null
  }, files)
  expect(dot).not.toBeNull()
  await page.mouse.click(dot!.x, dot!.y)
  await expect(page.getByRole('button', { name: /^JVM · Dates \d+ mixed ▾$/ })).toBeVisible()
  await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText(`${dot!.name}.kt`)
  await settle(page)
  // the job's cloud alone: its ways in the key, the same dots
  await expect(legend(page)).toContainText('java.util.Date / Calendar (legacy) · 1')
  await expect(legend(page)).toContainText('grey lines: dependencies within one way')
  await expect(legend(page)).toContainText('Color the way it does the job')
  expect((await scene(page)).decoration).toMatchObject({ clouds: 1, dots: 8, crossings: 1 })

  // × goes back to all jobs; City brings the buildings back
  await page.getByRole('button', { name: 'Back to all jobs' }).click()
  await expect(page.getByRole('button', { name: /^All jobs \d+ mixed ▾$/ })).toBeVisible()
  await page.getByRole('group', { name: 'Coherence as' }).getByRole('button', { name: 'City' }).click()
  await settle(page)
  await expect.poll(async () => (await scene(page)).decoration?.clouds).toBe(0)
  expect((await scene(page)).objects.building).toBeGreaterThan(0)
  await expect(legend(page)).toContainText('does every job the way its folder does')
  await expect(legend(page)).not.toContainText('its lines of code')
})
