// Real DOM + isolated database. Never mutates the installed profile.
// KNOWLEDGE_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/verify-stepper.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeApi, LOCAL_MANAGEMENT_API_PREFIX } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = await mkdtemp(join(tmpdir(), 'knowledge-stepper-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const routes = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, { authMode: 'same-origin',
  service: { current: () => ({ publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' }) },
})
registerKnowledgeWeb(ctx, '/knowledge', LOCAL_MANAGEMENT_API_PREFIX, 'same-origin')
let attempts = 0
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === `${LOCAL_MANAGEMENT_API_PREFIX}/knowledge-bases`) {
    attempts++
    if (attempts === 1) {
      await delay(400)
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: '测试服务暂不可用，请重试' }))
      return
    }
  }
  const route = routes.find(route => req.url.split('?')[0] === route.path || req.url.startsWith(route.path + '/'))
  if (route) void route.handler(req, res)
  else if (req.url.startsWith('/knowledge-control/v1/models')) {
    res.setHeader('content-type', 'application/json'); res.end('{"providers":[]}')
  } else { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/knowledge/`)
  await page.getByRole('button', { name: '知识库与挂载', exact: true }).click()
  const open = page.getByRole('button', { name: '+ 创建知识库', exact: true })
  await open.click()
  const dialog = page.getByRole('dialog')
  const next = dialog.getByRole('button', { name: '继续', exact: true })
  await next.click()
  assert.match(await dialog.locator('[aria-current="step"]').innerText(), /基本信息/)
  await dialog.getByRole('button', { name: '第 3 步：确认创建', exact: true }).click()
  assert.match(await dialog.locator('[aria-current="step"]').innerText(), /基本信息/, 'step indicator cannot bypass validation')
  await dialog.getByLabel('名称', { exact: true }).fill('交互试用知识库')
  await dialog.getByLabel('所属分组', { exact: true }).fill('工作资料')
  await dialog.getByLabel('回写匹配描述', { exact: true }).fill('项目确认的设计决定与发布规范')
  await page.keyboard.press('Escape')
  await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await dialog.isVisible(), true, 'dirty form survives Escape')
  await next.click()
  await dialog.getByLabel('提取要求', { exact: true }).fill('只保存已经确认的结论')
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: '主动（更积极沉淀）', exact: true }).click()
  await dialog.getByRole('button', { name: '上一步', exact: true }).click()
  assert.equal(await dialog.getByLabel('名称', { exact: true }).inputValue(), '交互试用知识库')
  await next.click()
  assert.equal(await dialog.getByLabel('提取要求', { exact: true }).inputValue(), '只保存已经确认的结论')
  // A required select on a hidden step must be revealed before reporting invalidity.
  await dialog.getByRole('checkbox').check()
  await next.click()
  assert.match(await dialog.locator('[aria-current="step"]').innerText(), /收录规则/)
  await dialog.getByRole('checkbox').uncheck()
  await next.click()
  assert.match(await dialog.locator('.dialog-step-review').innerText(), /主动/)
  assert.equal(attempts, 0, 'navigation must never create data')
  for (const [width, height] of [[1280, 850], [390, 844], [812, 375]]) {
    await page.setViewportSize({ width, height })
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
      await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))) })
      assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `no modal overflow ${width}`)
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1)
      const footer = await dialog.locator('.dialog-footer').boundingBox()
      assert.ok(footer.y + footer.height <= bounds.y + bounds.height, 'footer is reachable without scrolling the page')
      await page.screenshot({ path: join(root, `review-${width}-${colorScheme}.png`) })
    }
  }
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await dialog.getByRole('button', { name: '上一步', exact: true }).click()
  assert.equal(await dialog.locator('.dialog-step-glider').evaluate(el => getComputedStyle(el).transitionDuration), '0s')
  assert.equal(await dialog.evaluate(el => el.getAnimations({ subtree: true }).length), 0)
  await next.click()
  const create = dialog.getByRole('button', { name: '创建', exact: true })
  await create.click()
  assert.equal(await dialog.getAttribute('aria-busy'), 'true')
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
  assert.equal(await dialog.getByRole('button', { name: '上一步', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  await create.waitFor()
  assert.equal(await dialog.isVisible(), true, 'failure preserves form')
  assert.equal(await create.isEnabled(), true)
  assert.match(await dialog.innerText(), /交互试用知识库/)
  await create.focus()
  await page.keyboard.press('Tab')
  assert.equal(await dialog.getByRole('button', { name: '关闭对话框', exact: true }).evaluate(el => el === document.activeElement), true)
  await create.click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(attempts, 2)
  assert.equal((await provider.listKnowledgeBases()).filter(base => base.name === '交互试用知识库').length, 1)
  // Single-purpose editing stays direct; it must not acquire artificial steps.
  const card = page.locator('.base-card').filter({ hasText: '交互试用知识库' })
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  assert.equal(await dialog.locator('.dialog-steps').count(), 0)
  assert.equal(await page.locator('.sheet-backdrop, .dialog.sheet').count(), 0, 'legacy editor uses the centered shell')
  assert.equal(await dialog.getByLabel('提取要求', { exact: true }).inputValue(), '只保存已经确认的结论')
  for (const [width, height] of [[1280, 850], [390, 844], [812, 375]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const bounds = await dialog.boundingBox()
    await page.screenshot({ path: join(root, `centered-editor-${width}.png`) })
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - width / 2) < 2, `editor horizontally centered ${width}: ${JSON.stringify(bounds)}`)
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - height / 2) < 2, `editor vertically centered ${height}: ${JSON.stringify(bounds)}`)
    const footer = await dialog.locator('.dialog-footer').boundingBox()
    assert.ok(footer.y + footer.height <= height, 'long-form save actions remain visible')
  }
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  for (const [width, height] of [[1280, 850], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.getByRole('button', { name: '重命名分组 工作资料', exact: true }).click()
    const bounds = await dialog.boundingBox()
    assert.ok(bounds.height < 340, `short form does not reserve empty space: ${bounds.height}`)
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - height / 2) < 2)
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - width / 2) < 2)
    await page.screenshot({ path: join(root, `compact-dialog-${width}.png`) })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  }
  await page.setViewportSize({ width: 1280, height: 850 })
  // Normal-motion close is interruptible and cleans up after its short exit.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await open.click()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'))
  assert.equal(await open.evaluate(el => el === document.activeElement), true)
  assert.deepEqual(errors, [])
  console.log(`PASS: validation, back/skip, preserved values, select, failure/retry, busy, focus, responsive, light/dark, reduced motion. Screenshots: ${root}`)
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await provider.close() }
