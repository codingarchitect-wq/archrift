import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import './hooks.ts'
import { serverUrl } from './ports.ts'

// The kotlin-spring fixture: a Spring controller, service, repository and entity, Kafka topics resolved
// through application.yml, a database from the datasource URL, Avro schemas (docs/POLYGLOT.md).
const URL = serverUrl('kotlin')
const SVC = 'order-service/src/main/kotlin/com/acme/order'

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const title = (page: Page) => inspector(page).getByRole('heading', { level: 2 })

test('topics and databases stand beside the city without the packages toggle', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await expect(page.getByRole('checkbox', { name: 'packages' })).not.toBeChecked()
  // acme.orders, acme.payments and the acme-orders database; the JVM packages stay hidden
  await expect.poll(() => page.evaluate(() => window.__archrift.scene().objects.external)).toBe(3)
})

test('a topic says who publishes to it and who subscribes, and leads there', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await page.evaluate(() => window.__archrift.select('x:kafka:acme.payments'))
  await expect(title(page)).toHaveText('payments')
  await expect(inspector(page)).toContainText('Kafka topic · acme.local.payments')
  await expect(inspector(page).locator('section').filter({ hasText: /^Published by/ })).toContainText('OrderService.kt')
  const subscribed = inspector(page).locator('section').filter({ hasText: /^Subscribed by/ })
  await subscribed.getByRole('button', { name: /^PaymentListener\.kt/ }).click()
  await expect(title(page)).toHaveText('PaymentListener.kt')
})

test('a handler shows the route it serves; a database who queries it', async ({ page }) => {
  await page.goto(URL)
  await page.waitForFunction(() => window.__archrift?.ready())
  await page.evaluate(id => window.__archrift.select(id), `s:${SVC}/OrderController.kt#OrderController.list`)
  await expect(inspector(page)).toContainText('http:GET /v1/orders/{customer}')
  await page.evaluate(() => window.__archrift.select('x:db:mysql:acme-orders'))
  await expect(inspector(page)).toContainText('mysql: acme-orders')
  await expect(inspector(page).locator('section').filter({ hasText: /^Queried by/ })).toContainText('OrderRepository.kt')
})

test('a controller is a runtime scenario: its handlers down to the entity they write', async ({ page }) => {
  await page.goto(`${URL}?view=runtime`)
  await page.waitForFunction(() => window.__archrift?.ready())
  await expect(page.getByRole('button', { name: /^Scenario: \/v1\/orders/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__archrift.scene().decoration?.queries ?? 0), { timeout: 20_000 }).toBeGreaterThan(0)
  const d = await page.evaluate(() => window.__archrift.scene().decoration!)
  expect(d.server).toBeGreaterThan(0)
  expect(d.databases).toBeGreaterThan(0)
})
