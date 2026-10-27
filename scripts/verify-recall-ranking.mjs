import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { registerKnowledgeWeb } from '../lib/web.js'
import { assertRecallScrollLayout } from './recall-layout-check.mjs'
import { assertRecallRowHover } from './recall-hover-check.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const provider = new LocalKnowledgeProvider(':memory:')
const draft = { knowledgeBaseId: 'default', group: '回归测试', title: '部署规范', body: '完整正文不应随排行列表加载。', type: 'lesson', tags: [], scope: { kind: 'global' }, confidence: .9 }
for (let i = 0; i < 35; i++) await provider.create({ ...draft, title: `部署规范 ${String(i).padStart(2, '0')}` })
const routes = [], calls = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, '/api', { authMode: 'same-origin' })
registerKnowledgeWeb(ctx, '/knowledge', '/api', 'same-origin')
const server = createServer((req, res) => {
  calls.push({ path: req.url, method: req.method })
  const route = routes.find(route => req.url.startsWith(route.path))
  if (route) void route.handler(req, res)
  else { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}), args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/knowledge/')
  await page.locator('[data-nav-view="recall"]').waitFor()
  assert.equal(calls.some(call => call.path.startsWith('/api/recall')), false, 'ranking must remain lazy')
  await page.locator('[data-nav-view="recall"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-recall-id]').length === 30)
  assert.equal(await page.locator('select[aria-label="排行排序"]').inputValue(), 'score')
  await page.locator('[data-recall-id]').first().getByRole('button', { name: /综合得分构成/ }).click()
  await page.getByText('防踩坑价值（最多 20 分）：0.00', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' })
  assert.equal(calls.some(call => /\/api\/documents\//.test(call.path)), false, 'ranking must not load document bodies')
  assert.match(await page.locator('.list-load-footer').textContent(), /30 \/ 35/)
  await assertRecallScrollLayout(page)
  await assertRecallRowHover(page)
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-recall-id]').length === 35)
  const row = page.locator('[data-recall-id]').first(), id = await row.getAttribute('data-recall-id')
  await row.getByRole('button', { name: /召回设置/ }).click()
  await page.keyboard.press('Escape')
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' })
  await row.getByRole('button', { name: /召回设置/ }).click()
  // Use the underlying native select: production decorates it accessibly.
  await page.locator('.dialog select[aria-label="召回优先级"]').selectOption('2', { force: true })
  await page.locator('.dialog').getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' })
  assert.equal(provider.recallRanking.list().items.find(item => item.id === id).priority, 2)
  await page.locator(`[data-recall-id="${id}"]`).getByRole('button', { name: '记一次踩坑' }).click()
  await page.getByRole('textbox', { name: '踩坑原因' }).fill('独立发生：误删持久卷导致返工')
  await page.locator('.dialog').getByRole('button', { name: '记录', exact: true }).click()
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' })
  assert.equal(provider.recallRanking.list().items.find(item => item.id === id).friction, 10)
  await page.getByRole('status').filter({ hasText: '当前范围 1 篇有有效踩坑记录' }).waitFor()
  await page.getByRole('button', { name: '查看踩坑排行', exact: true }).click()
  await page.waitForFunction(id => document.querySelector('[data-recall-id]')?.getAttribute('data-recall-id') === id && document.querySelector('.recall-workspace')?.getAttribute('aria-busy') === 'false', id)
  assert.equal(await page.locator('select[aria-label="排行排序"]').inputValue(), 'friction')
  assert.equal(await page.getByRole('button', { name: '查看踩坑排行', exact: true }).isVisible(), false)
  assert.match(await page.locator(`[data-recall-id="${id}"]`).textContent(), /1 次踩坑/)
  await page.locator(`[data-recall-id="${id}"]`).getByRole('button', { name: /摩擦记录/ }).click()
  await page.getByText('独立发生：误删持久卷导致返工', { exact: true }).waitFor()
  await page.getByRole('button', { name: '撤销误记' }).click()
  await page.getByRole('textbox', { name: '撤销原因' }).fill('测试误记')
  await page.getByRole('button', { name: '确认撤销', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 1)
  assert.equal(provider.recallRanking.list().items.find(item => item.id === id).friction, 0)
  await page.getByRole('status').filter({ hasText: '当前范围 0 篇有有效踩坑记录' }).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' })
  await page.locator('[data-recall-id] input[type="checkbox"]').first().check()
  await page.locator('.recall-bulk').getByRole('button', { name: '较高', exact: true }).click()
  await page.locator('.recall-bulk').waitFor({ state: 'hidden' })
  await page.locator('[data-recall-id]').first().hover()
  await page.screenshot({ path: '/tmp/knowledge-recall-desktop.png', fullPage: false })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await assertRecallRowHover(page)
  await assertRecallScrollLayout(page)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: '/tmp/knowledge-recall-mobile.png', fullPage: false })
  await page.setViewportSize({ width: 844, height: 390 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await assertRecallScrollLayout(page)
  // New clients remain usable against a pre-summary central service.
  await page.route('**/api/recall?*', async route => {
    const response = await route.fetch()
    const data = await response.json()
    delete data.incidentDocuments
    await route.fulfill({ response, json: data })
  })
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.recall-workspace')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.recall-summary [role="status"]')?.textContent.includes('当前范围'))
  assert.equal(await page.getByRole('button', { name: '查看踩坑排行', exact: true }).isVisible(), false)
  assert.deepEqual(errors, [])
  console.log('Recall UI passed: lazy entry, pagination, preferences, incident, retraction, bulk action, Escape, mobile layout.')
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await provider.close()
}
