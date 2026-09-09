// Isolated outbox browser smoke test; never touches installed DSH data.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerWritebackControl } from '../lib/writeback/control.js'
import { WritebackQueue } from '../lib/writeback/queue.js'
import { registerWritebackLive } from '../lib/writeback/live-control.js'
const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const routes = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } } }
const queue = new WritebackQueue(':memory:', async () => { throw new Error('测试：模型暂不可用') })
queue.enqueue({ destination: 'local:fixture', snapshot: { sourceKey: 'ui:1', sessionId: 'ui', turn: 1, userText: 'question', assistantText: 'answer', userTextTruncated: false } })
registerWritebackControl(ctx, queue)
const disposeLive = registerWritebackLive(ctx, queue)
registerKnowledgeWeb(ctx, '/knowledge', '/knowledge-local/v1', 'same-origin')
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const route = routes.find(candidate => candidate.path === path || candidate.kind === 'prefix' && path.startsWith(candidate.path + '/'))
  if (route) route.handler(req, res)
  else res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/knowledge/?view=writeback`)
  await page.getByRole('button', { name: '取消回写', exact: true }).waitFor()
  assert.equal(await page.locator('.writeback-job time').count(), 1)
  for (const [width, height] of [[1280, 850], [375, 812], [768, 1024]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
    })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `overflow at ${width}`)
    assert.ok(await page.getByRole('button', { name: '取消回写', exact: true }).isVisible())
    if (width === 375) await page.screenshot({ path: '/tmp/knowledge-writeback-mobile.png', fullPage: true })
  }
  await page.getByRole('button', { name: '取消回写', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '取消回写', exact: true }).click()
  await page.locator('.writeback-job strong').filter({ hasText: '已取消' }).waitFor()
  // Without clicking refresh, a backend change must reach the mounted view.
  queue.completeEmpty('ui:2', 'ui')
  await page.locator('.writeback-job-key').filter({ hasText: 'ui:2' }).waitFor({ timeout: 3000 })
  assert.equal(await page.locator('.writeback-job-key').first().textContent(), 'ui:2')
  assert.deepEqual(errors, [])
  console.log('writeback UI: desktop/mobile/tablet, cancellation and no page errors passed')
} finally { await browser.close(); disposeLive(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await queue.close() }
