import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { registerKnowledgeWeb } from '../lib/web.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const provider = new LocalKnowledgeProvider(':memory:')
const draft = { knowledgeBaseId: 'default', group: '回归测试', title: '索引测试', body: '# 运维\n\n可靠恢复', type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: .9 }
for (let i = 0; i < 33; i++) await provider.create({ ...draft, title: `索引测试 ${i}` })
provider.retrievalIndex.close()
provider.db.exec("UPDATE knowledge_passage_index SET state='failed',attempts=1,retry_at=9999999999999,error_code='INDEX_BUILD_FAILED'")
const routes = [], calls = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, '/api', { authMode: 'same-origin' })
registerKnowledgeWeb(ctx, '/knowledge', '/api', 'same-origin')
const server = createServer((req, res) => {
  calls.push(req.url)
  const route = routes.find(route => req.url.split('?')[0] === route.path || req.url.startsWith(route.path + '/'))
  if (route) return void route.handler(req, res)
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"providers":[]}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(origin + '/knowledge/')
  const trigger = page.locator('.retrieval-index-trigger')
  await trigger.filter({ hasText: '33 篇索引失败' }).waitFor()
  const search = await page.locator('.note-tree-search-wrap').boundingBox()
  const entry = await trigger.boundingBox()
  assert.ok(entry.y >= search.y + search.height)
  await trigger.click()
  await page.locator('.retrieval-index-item').nth(29).waitFor()
  assert.equal(await page.locator('.retrieval-index-item').count(), 30)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.retrieval-index-item').length === 3)
  await page.locator('.retrieval-index-item button').first().click()
  await page.waitForFunction(() => document.querySelector('.retrieval-index-summary')?.textContent.includes('待处理 1'))
  await page.getByRole('button', { name: '重试失败项', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.retrieval-index-summary')?.textContent.includes('失败 0'))
  await page.getByRole('button', { name: '待处理', exact: true }).click()
  await page.locator('.retrieval-index-item').nth(29).waitFor()
  await page.screenshot({ path: '/tmp/knowledge-index-ui-light.png' })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: '/tmp/knowledge-index-ui-dark.png' })
  await page.setViewportSize({ width: 375, height: 812 })
  assert.ok(await page.locator('.retrieval-index-dialog').evaluate(el => el.getBoundingClientRect().right <= innerWidth))
  await page.screenshot({ path: '/tmp/knowledge-index-ui-mobile.png' })
  await page.keyboard.press('Escape')
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.locator('[data-nav-view="notes"]').click()
  await page.locator('.app-shell[data-view="notes"][data-loading="false"]').waitFor()
  const requests = calls.filter(path => path.startsWith('/api/retrieval-index')).length
  await page.waitForTimeout(3500)
  assert.equal(calls.filter(path => path.startsWith('/api/retrieval-index')).length, requests, 'polling stops on route change')
  await page.route('**/api/retrieval-index?**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }))
  await page.locator('[data-nav-view="entries"]').click()
  await trigger.filter({ hasText: '索引状态暂不可用' }).waitFor()
  await trigger.click()
  await page.getByText('当前知识库服务尚不支持索引状态，请升级实际存储文档的服务。', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS real UI: placement, pagination, individual/bulk retry, light/dark/mobile, Escape, route cleanup and old-server fallback')
} finally {
  await browser.close(); await provider.close(); server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
