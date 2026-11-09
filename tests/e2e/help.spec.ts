import { expect, test } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

const URL = serverUrl('plainTs')

test.describe('a first visit', () => {
  // a fresh browser, without the hint already seen
  test.use({ storageState: { cookies: [], origins: [] } })

  test('shows how to get around until dismissed, then never again', async ({ page }) => {
    await page.goto(URL)
    await page.waitForFunction(() => window.__archrift?.ready())
    const hint = page.getByRole('note', { name: 'Getting started' })
    await expect(hint).toContainText('Drag to orbit')
    await hint.getByRole('button', { name: 'Got it' }).click()
    await expect(hint).toBeHidden()
    await page.reload()
    await page.waitForFunction(() => window.__archrift?.ready())
    await expect(hint).toBeHidden()
  })

  test('the hint goes away with the first selection', async ({ page }) => {
    await page.goto(URL)
    await page.waitForFunction(() => window.__archrift?.ready())
    await expect(page.getByRole('note', { name: 'Getting started' })).toBeVisible()
    await page.evaluate(() => window.__archrift.select('f:src/app.ts'))
    await expect(page.getByRole('note', { name: 'Getting started' })).toBeHidden()
  })
})

test('? opens the cheat sheet; Esc closes it without clearing the selection', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await expect(page.getByRole('note', { name: 'Getting started' })).toBeHidden()
  await page.evaluate(() => window.__archrift.select('f:src/app.ts'))
  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Getting around' })
  await expect(help).toContainText('City, Layers, Galaxy')
  await expect(help.getByRole('button', { name: 'Close help' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  expect(await page.evaluate(() => window.__archrift.state().selected)).toBe('f:src/app.ts')
  await page.getByRole('button', { name: 'Keyboard shortcuts and help' }).click()
  await expect(help).toBeVisible()
  await help.getByRole('button', { name: 'Close help' }).click()
  await expect(help).toBeHidden()
})
