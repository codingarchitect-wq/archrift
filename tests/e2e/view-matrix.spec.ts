import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The Matrix view (src/viewer/views/matrix): a dependency structure matrix with digital rain.
const settle = async (page: Page) => {
  await page.waitForFunction(() => window.__archrift.idle() && !window.__archrift.state().task)
  await page.waitForTimeout(100)
}
const scene = (page: Page) => page.evaluate(() => window.__archrift.scene())
const matrix = async (page: Page) => (await scene(page)).decoration as Record<string, number>
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const legend = (page: Page) => page.getByRole('complementary', { name: 'Matrix legend' })

/** Distinct dependencies between visible files, as the viewer's filters see them (tests and packages hidden). */
const filePairs = (page: Page) =>
  page.evaluate(() => {
    const s = window.__archrift.state() as unknown as {
      world: { graph: { nodes: { id: string; kind: string; tags?: string[] }[]; edges: { source: string; target: string; kind: string; targets: string[] }[] } }
      options: { target: string }
    }
    const files = new Set(s.world.graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test')).map(n => n.id))
    const pairs = new Set<string>()
    for (const e of s.world.graph.edges)
      if (e.kind !== 'mocks' && e.kind !== 'co-changes' && e.targets.includes(s.options.target) && e.source !== e.target && files.has(e.source) && files.has(e.target))
        pairs.add(`${e.source}\u0000${e.target}`)
    return { files: files.size, pairs: pairs.size }
  })

/** Where the cell of a row and a column is on screen: the column's and the row's crossings on the diagonal. */
const cellAt = async (page: Page, row: string, col: string) => {
  const [r, c] = await page.evaluate(([a, b]) => [a, b].map(id => window.__archrift.screenPosition(`matrix-crossing:${id}`)), [row, col])
  return { x: c!.x, y: r!.y }
}

let errors: string[] = []
test.beforeEach(({ page }) => {
  errors = []
  page.on('pageerror', e => errors.push(e.message))
})
test.afterEach(() => expect(errors).toEqual([]))

test.describe('on the fullstack fixture', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(serverUrl('fullstack'))
    await page.waitForFunction(() => window.__archrift?.ready())
    await settle(page)
  })

  test('the toolbar switches to the matrix: a strip per file, a cell per dependency, rain down every column', async ({ page }) => {
    await page.getByRole('button', { name: 'Matrix', exact: true }).click()
    await expect.poll(async () => (await scene(page)).view).toBe('matrix')
    await settle(page)
    const { files, pairs } = await filePairs(page)
    const s = await scene(page)
    expect(s.objects.building).toBe(files)
    expect(s.arcs).toBe(0)
    const d = await matrix(page)
    expect(d.rows).toBe(files)
    expect(d.cells).toBe(pairs)
    expect(d.rainColumns).toBe(files)
    expect(d.rain).toBe(1)
    // the config's rules: an error rule broken twice, a warning twice
    expect([d.violation, d.warning]).toEqual([2, 2])
    await expect(legend(page)).toContainText(`${pairs} dependencies`)
    await expect(page.locator('.minimap')).toBeHidden()
    expect(page.url()).toContain('view=matrix')
  })

  test('hovering a cell names both ends; clicking it selects its row, and the camera stays', async ({ page }) => {
    await page.evaluate(() => window.__archrift.setOptions({ view: 'matrix' }))
    await settle(page)
    const at = await cellAt(page, 'f:src/app/page.tsx', 'f:src/lib/fake-libs.ts')
    await page.mouse.move(at.x, at.y)
    await expect(page.locator('.matrix-tip')).toContainText('src/app/page.tsx → src/lib/fake-libs.ts')
    await expect(page.locator('.matrix-tip')).toContainText('breaks pages-use-services')

    const before = await page.evaluate(() => window.__archrift.screenPosition('matrix-crossing:f:src/app/page.tsx'))
    await page.mouse.click(at.x, at.y)
    await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('page.tsx')
    expect(await page.evaluate(() => window.__archrift.state().selected)).toBe('f:src/app/page.tsx')
    await settle(page)
    expect((await matrix(page)).selectedRow).toBe(0) // the app layer comes first
    // the wall didn't move under the pointer
    const after = await page.evaluate(() => window.__archrift.screenPosition('matrix-crossing:f:src/app/page.tsx'))
    expect(Math.abs(after!.x - before!.x) + Math.abs(after!.y - before!.y)).toBeLessThan(2)
    // its column is labelled, and so are the columns of what it uses
    await expect(page.locator('.label.matrix-col.selected')).toHaveText('app/page.tsx')
    await expect(page.locator('.label.matrix-col.neighbor', { hasText: 'fake-libs.ts' })).toHaveCount(1)
  })

  test('the rain switches off and on, and stays off across views', async ({ page }) => {
    await page.evaluate(() => window.__archrift.setOptions({ view: 'matrix' }))
    await settle(page)
    const rain = page.getByRole('button', { name: 'rain', exact: true })
    await expect(rain).toHaveAttribute('aria-pressed', 'true')
    await rain.click()
    await expect(rain).toHaveAttribute('aria-pressed', 'false')
    expect(await matrix(page)).toMatchObject({ rain: 0, rainColumns: 0, drops: 0 })

    await page.getByRole('button', { name: 'City', exact: true }).click()
    await expect.poll(async () => (await scene(page)).view).toBe('city')
    expect((await scene(page)).decoration).toBeNull()
    await expect(legend(page)).toHaveCount(0)
    await expect(page.locator('.minimap')).toBeVisible()
    await expect(page.getByRole('button', { name: 'rain', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Matrix', exact: true }).click()
    await expect.poll(async () => (await scene(page)).view).toBe('matrix')
    expect((await matrix(page)).rain).toBe(0)
    await page.getByRole('button', { name: 'rain', exact: true }).click()
    expect((await matrix(page)).rainColumns).toBe((await matrix(page)).rows)
  })

  test('a selection from elsewhere lights its row and column; switching back to the city keeps it', async ({ page }) => {
    await page.evaluate(() => window.__archrift.setOptions({ view: 'matrix' }))
    await settle(page)
    await page.evaluate(() => window.__archrift.select('s:src/client/service.ts#CloudService'))
    await settle(page)
    const d = await matrix(page)
    expect(d.selectedRow).toBeGreaterThanOrEqual(0)
    await expect(page.locator('.label.matrix-col.selected')).toHaveText('client/service.ts')
    await page.getByRole('button', { name: 'City', exact: true }).click()
    await expect.poll(async () => (await scene(page)).view).toBe('city')
    expect(await page.evaluate(() => window.__archrift.state().selected)).toBe('s:src/client/service.ts#CloudService')
  })
})

test.describe('on plain-ts', () => {
  test('?view=matrix opens it, with the import cycle marked both ways', async ({ page }) => {
    await page.goto(`${serverUrl('plainTs')}?view=matrix`)
    await page.waitForFunction(() => window.__archrift?.ready())
    await settle(page)
    const { files, pairs } = await filePairs(page)
    const s = await scene(page)
    expect(s.view).toBe('matrix')
    expect(s.objects.building).toBe(files)
    expect((await matrix(page)).cells).toBe(pairs)
    expect((await matrix(page)).cycle).toBe(2)
    await expect(page.getByRole('button', { name: 'Matrix', exact: true })).toHaveAttribute('aria-pressed', 'true')

    await page.evaluate(() => window.__archrift.select('f:src/util.ts'))
    await settle(page)
    expect((await matrix(page)).selectedRow).toBeGreaterThanOrEqual(0)
    await expect(page.locator('.label.matrix-col.selected')).toHaveText('util.ts')
  })

  test.describe('with reduced motion', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } })

    test('the rain starts off', async ({ page }) => {
      await page.goto(`${serverUrl('plainTs')}?view=matrix`)
      await page.waitForFunction(() => window.__archrift?.ready())
      await settle(page)
      await expect(page.getByRole('button', { name: 'rain', exact: true })).toHaveAttribute('aria-pressed', 'false')
      expect(await matrix(page)).toMatchObject({ rain: 0, rainColumns: 0 })
    })
  })
})

test('on a repository with history, the rain follows recent churn', async ({ page }) => {
  await page.goto(`${serverUrl('history')}?view=matrix`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await settle(page)
  await expect(legend(page)).toContainText('rain: lines changed recently (churn)')
  const d = await matrix(page)
  // busier columns get more drops
  expect(d.drops).toBeGreaterThan(d.rows)
})

test.describe('in watch mode', () => {
  const file = path.resolve(import.meta.dirname, '../../out/e2e/watch/repo/src/shapes.ts')
  let original = ''
  test.afterEach(async () => {
    if (original) fs.writeFileSync(file, original)
    original = ''
    await new Promise(r => setTimeout(r, 1500)) // let the server catch up before the next test loads
  })

  test('saving a file sends rain down its column', async ({ page }) => {
    await page.goto(`${serverUrl('watch')}?view=matrix`)
    await page.waitForFunction(() => window.__archrift?.ready())
    await settle(page)
    expect((await matrix(page)).bursts).toBe(0)
    original = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, `${original}\nexport const extra = 1\n`)
    await expect(page.getByRole('status', { name: 'Live updates' })).toContainText('updated', { timeout: 15_000 })
    await expect.poll(async () => (await matrix(page)).bursts).toBeGreaterThanOrEqual(1)
  })
})
