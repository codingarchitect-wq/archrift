import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// plain-ts as a project with words written for it (src, util.ts, a stale entry
// for shapes.ts), a change in progress (util.ts grew an export, extra.ts is new,
// with the agent's note) and Ask answered by tests/fixtures/fake-claude.mjs.
const URL = serverUrl('ask')

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })

test.beforeEach(async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
})

test('the inspector, the tooltip and search show what was written; the toolbar labels with it', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/util.ts'))
  await expect(title(page)).toHaveText('util.ts')
  const words = inspector(page).getByLabel('Description')
  await expect(words).toContainText('Helpers')
  await expect(words).toContainText('Small sums the shapes need: parsing and clamping numbers.')

  // written before shapes.ts's exports were what they are: marked stale
  await page.evaluate(() => window.__archrift.select('f:src/shapes.ts'))
  await expect(title(page)).toHaveText('shapes.ts')
  await expect(inspector(page).getByLabel('Description')).toContainText('check it still fits')

  // search finds a file by the words written about it
  await page.getByRole('searchbox', { name: 'Search' }).fill('clamping numbers')
  await expect(page.getByRole('option').first()).toContainText('“Small sums the shapes need')

  // labels: the code's names, then the described ones
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__archrift.select('d:src'))
  await expect(page.locator('.labels .selected').filter({ visible: true })).toHaveText('src')
  await page.getByRole('checkbox', { name: 'described names' }).check()
  await expect(page.locator('.labels .selected').filter({ visible: true })).toHaveText('Shape code')
  expect(await page.evaluate(() => window.__archrift.state().options.names)).toBe('described')
})

test('Changes lights the change in progress, lists what the diff finds and why each file changed', async ({ page }) => {
  await page.getByRole('button', { name: /^Changes/ }).click()
  await expect(title(page)).toHaveText('Changes')
  await expect(inspector(page)).toContainText('2 files since HEAD')
  await expect(inspector(page)).toContainText('Unit circles')
  await expect(inspector(page)).toContainText('Asked: Let callers make a unit circle')
  await expect(inspector(page).locator('section').filter({ hasText: /^New \(1\)/ })).toContainText('extra.ts')
  await expect(inspector(page)).toContainText('Makes the unit circle the request asked for.')
  await expect(page.getByRole('button', { name: /^Changes/ }).locator('.count')).toHaveText('2')
  expect(await page.evaluate(() => window.__archrift.state().options.colorBy)).toBe('changes')
  await expect(page.getByRole('complementary', { name: 'Legend' })).toContainText('the diff warns')

  // the arcs: the dependencies among the changed files (extra.ts uses util.ts), or every one they have
  const drawn = () => page.evaluate(() => window.__archrift.scene().highlighted)
  const edges = inspector(page).getByRole('group', { name: 'Edges' })
  await expect(edges.getByRole('radio', { name: 'only between the changed files' })).toBeChecked()
  await expect.poll(drawn).toBe(1)
  await edges.getByRole('radio', { name: 'to every file they use or are used by' }).check()
  await expect.poll(drawn).toBeGreaterThan(1)
  expect(await page.evaluate(() => window.__archrift.state().options.changeEdges)).toBe('all')
  // the toolbar's edges option still rules: none draws none
  await page.evaluate(() => window.__archrift.setOptions({ edges: 'none' }))
  await expect.poll(drawn).toBe(0)
  await page.evaluate(() => window.__archrift.setOptions({ edges: 'auto' }))
  await edges.getByRole('radio', { name: 'only between the changed files' }).check()
  await expect.poll(drawn).toBe(1)

  // a changed file's own inspector says how it changed, and why
  await inspector(page).getByRole('button', { name: /extra\.ts/ }).click()
  await expect(title(page)).toHaveText('extra.ts')
  await expect(inspector(page)).toContainText('new since HEAD')
  await expect(inspector(page)).toContainText('+3 −0')
  await expect(inspector(page)).toContainText('Unit circles: Makes the unit circle the request asked for.')
})

test('Changes compares the last commit, one commit, or everything since one, and back to the change in progress', async ({ page }) => {
  await page.getByRole('button', { name: /^Changes/ }).click()
  await expect(inspector(page)).toContainText('2 files since HEAD')
  const compare = inspector(page).getByRole('combobox', { name: 'Compare' })

  // the last commit: its one file, its message, no agent notes (they are about the change in progress)
  await compare.selectOption('last')
  await expect(inspector(page)).toContainText(/1 file from HEAD~1 \([0-9a-f]{8}\) to HEAD \([0-9a-f]{8}\)/)
  await expect(inspector(page).locator('.badge').first()).toHaveText('commits')
  const commits = inspector(page).locator('section').filter({ hasText: /^Commits \(1\)/ })
  await expect(commits).toContainText('Say what the app draws')
  await commits.getByText('Say what the app draws').click()
  await expect(commits).toContainText('A comment at the end of app.ts.')
  await expect(inspector(page).locator('section').filter({ hasText: /^Changed \(1\)/ })).toContainText('app.ts')
  await expect(inspector(page)).not.toContainText('Unit circles')
  await expect(inspector(page)).toContainText('The map shows the working tree')

  // everything since the first commit: that commit's change and the one in progress
  await compare.selectOption('since')
  const commit = inspector(page).getByRole('combobox', { name: 'Commit' })
  await expect(commit.locator('option')).toHaveText([/· Say what the app draws ·/, /· start ·/])
  await commit.selectOption({ label: (await commit.locator('option').nth(1).textContent())! })
  await expect(inspector(page)).toContainText(/3 files since [0-9a-f]{8}(?![0-9a-f])/)
  await expect(inspector(page).locator('section').filter({ hasText: /^Commits \(1\)/ })).toContainText('Say what the app draws')
  await expect(inspector(page).locator('.badge').first()).toHaveText('1 commit and the change in progress')
  await expect(inspector(page)).toContainText('Unit circles')

  // one commit: the first has no parent to compare with, so it isn't offered
  await compare.selectOption('commit')
  await expect(commit.locator('option')).toHaveText([/· Say what the app draws ·/])
  await expect(inspector(page)).toContainText(/1 file from [0-9a-f]{8}~1 \([0-9a-f]{8}\) to [0-9a-f]{8}(?![0-9a-f])/)

  await compare.selectOption('progress')
  await expect(inspector(page)).toContainText('2 files since HEAD')
  await expect(inspector(page)).toContainText('Unit circles')
})

test('Ask: a question about the selection, the agent’s steps, then the answer lit on the map', async ({ page }) => {
  await page.evaluate(() => window.__archrift.select('f:src/app.ts'))
  await inspector(page).getByRole('button', { name: 'Ask about this ›' }).click()
  const panel = page.getByRole('dialog', { name: 'Ask about the code' })
  await expect(panel).toContainText('About src/app.ts')
  await panel.getByRole('textbox', { name: 'Question' }).fill('How does it start?')
  await page.keyboard.press('Enter')
  await expect(panel).toBeHidden()

  await expect(title(page)).toHaveText('How the app starts')
  await expect(inspector(page)).toContainText('How does it start?')
  await expect(inspector(page).locator('section').filter({ hasText: /^Step by step/ }).getByRole('button')).toHaveText([/^1 src\/app\.tsmain runs/, /^2 makeCirclea circle is made/])
  await expect(inspector(page)).toContainText('Not on the map: src/nowhere.ts')
  // the cited file is a link to it
  await expect(inspector(page).locator('.ask-answer').getByRole('button', { name: 'src/app.ts' })).toBeVisible()
  // on the map: the walkthrough's two stops, numbered, one arc between them
  // (the label layer keeps its elements, hidden, for the next frame)
  await expect(page.locator('.labels .neighbor').filter({ visible: true })).toHaveText([/^1 · app\.ts$/, /^2 · shapes\.ts$/])
  await page.waitForFunction(() => window.__archrift.idle())
  // the walkthrough's arc is the one highlighted; no background arcs with an answer selected
  expect(await page.evaluate(() => window.__archrift.scene())).toMatchObject({ highlighted: 1, arcs: 0 })

  // a follow-up suggestion asks again
  await inspector(page).getByRole('button', { name: 'What else uses shapes?' }).click()
  await expect(inspector(page)).toContainText('What else uses shapes?')
  await expect(title(page)).toHaveText('How the app starts')
})
