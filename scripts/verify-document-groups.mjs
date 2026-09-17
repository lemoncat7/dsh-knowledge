// Isolated real UI and API. Never changes user data.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeApi, LOCAL_MANAGEMENT_API_PREFIX } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
const { chromium } = await import(pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href)
const root = await mkdtemp(join(tmpdir(), 'knowledge-document-groups-ui-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const routes = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, { authMode: 'same-origin', service: { current: () => ({ publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' }) } })
registerKnowledgeWeb(ctx, '/knowledge', LOCAL_MANAGEMENT_API_PREFIX, 'same-origin')
const server = createServer((req, res) => {
  const route = routes.find(route => req.url.split('?')[0] === route.path || req.url.startsWith(route.path + '/'))
  if (route) void route.handler(req, res)
  else if (req.url.startsWith('/knowledge-control/v1/models')) { res.setHeader('content-type', 'application/json'); res.end('{"providers":[]}') }
  else { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = await provider.createKnowledgeBase({ name: '产品团队知识库', description: '分组交互验证', defaultTags: [], extractionInstructions: '' })
const draft = { knowledgeBaseId: base.id, group: '部署运维', title: '发布后的健康检查', body: '## 检查服务\n\n验证服务状态，再确认版本。', type: 'procedure', tags: ['deployment'], scope: { kind: 'global' }, confidence: .9 }
const a = await provider.create(draft)
await provider.create({ ...draft, title: 'CI 构建约定' })
await provider.create({ ...draft, group: '项目规范', title: '代码评审约定' })
const old = await provider.create({ ...draft, title: '历史排查记录' }); await provider.assignDocumentGroup(base.id, [old.id], '')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
let activePage
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: 'reduce' })
  activePage = page; page.setDefaultTimeout(12_000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/knowledge/`)
  const baseButton = page.locator('.note-tree-base').filter({ hasText: base.name })
  if (await baseButton.getAttribute('aria-expanded') !== 'true') await baseButton.click()
  const group = page.locator('.document-tree-group[data-document-group="部署运维"]')
  await group.locator('.note-tree-document').first().waitFor()
  assert.equal(await group.locator('.note-tree-document').count(), 2)
  await group.locator('.document-group-toggle').click(); assert.equal(await group.locator('.note-tree-document').count(), 0)
  await group.locator('.document-group-toggle').focus(); await page.keyboard.press('Enter')
  assert.equal(await group.locator('.note-tree-document').count(), 2)
  await page.getByRole('button', { name: '整理分组', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: '历史排查记录', exact: true }).check()
  await dialog.locator('select[aria-label="文档分组"]').selectOption('部署运维', { force: true })
  await dialog.getByRole('button', { name: '应用分组', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' }); assert.equal((await provider.get(old.id)).group, '部署运维')
  await page.getByRole('button', { name: '新建文档', exact: true }).first().click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '开始编写' }).click()
  await dialog.getByRole('alert').filter({ hasText: '请选择' }).waitFor()
  await dialog.locator('select[aria-label="文档分组"]').selectOption('项目规范', { force: true })
  await dialog.getByRole('button', { name: '开始编写' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByLabel('文档标题', { exact: true }).fill('分组必填验证')
  await page.locator('.knowledge-live-editor .tiptap').fill('这个文档属于已有的项目规范分组。')
  await page.getByRole('button', { name: '创建文档', exact: true }).click()
  await page.getByText('已保存', { exact: true }).waitFor()
  assert.equal((await provider.list({ knowledgeBaseId: base.id, limit: 20 })).items.find(item => item.title === '分组必填验证').group, '项目规范')
  for (const width of [1280, 375, 812]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 850 })
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate(theme => { document.documentElement.dataset.colorScheme = theme }, theme)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await page.screenshot({ path: join(root, `document-groups-${width}-${theme}.png`), fullPage: true })
  }
  assert.deepEqual(errors, [])
  console.log(`PASS document groups, required field, keyboard, batch assignment, save, responsive themes: ${root}`)
} catch (error) {
  console.error(error)
  if (activePage) { console.error((await activePage.locator('body').innerText()).slice(0, 6000)); await activePage.screenshot({ path: join(root, 'failed.png') }) }
  throw error
} finally { await browser.close(); await provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
