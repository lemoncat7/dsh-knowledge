// Real browser + real API against an isolated temporary database, never user data.
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
const { chromium } = await import(pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href)
const root = await mkdtemp(join(tmpdir(), 'knowledge-drag-review-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const routes = [], ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, { authMode: 'same-origin', service: { current: () => ({ publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' }) } })
registerKnowledgeWeb(ctx, '/knowledge', LOCAL_MANAGEMENT_API_PREFIX, 'same-origin')
const server = createServer((req, res) => {
  const route = routes.find(r => req.url.split('?')[0] === r.path || req.url.startsWith(r.path + '/'))
  if (route) return void route.handler(req, res)
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"providers":[]}')
})
const library = name => provider.createKnowledgeBase({ name, description: '', defaultTags: [], extractionInstructions: '' })
const one = await library('第一知识库'), two = await library('第二知识库')
const draft = { knowledgeBaseId: one.id, group: '分组甲', title: '拖动文档', body: '测试正文', type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: .9 }
const entry = await provider.create(draft)
await provider.create({ ...draft, title: '甲组保留文档' })
await provider.create({ ...draft, group: '分组乙', title: '保留文档' })
await provider.create({ ...draft, knowledgeBaseId: two.id, group: '第二库分组', title: '另一个库文档' })
for (let i = 0; i < 12; i++) await provider.propose({ action: 'create', draft: { ...draft, title: `待审核 ${i}`, body: '长内容用于确认审核页面正文独立滚动。\n\n'.repeat(12) }, reason: '隔离测试' })
const folder = await provider.createNoteFolder('目标目录')
const nested = await provider.createNoteFolder('子目录', folder.id)
const sibling = await provider.createNoteDocument('目录内文档.md', folder.id, '内容')
const child = await provider.createNoteDocument('子目录内容.md', nested.id, '内容')
const note = await provider.createNoteDocument('可移动.md', null, '内容')
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}/knowledge/`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(12000)
const errors = []; page.on('pageerror', e => errors.push(e.message))
page.on('response', async response => {
  if (response.status() >= 400 || response.request().method() === 'POST') console.log('API', response.status(), response.url(), await response.text().catch(() => ''))
})
const ready = view => page.locator(`.app-shell[data-view="${view}"][data-loading="false"]`).waitFor()
const base = id => page.locator(`.note-tree-group[data-base-id="${id}"]`)
const group = (id, name) => base(id).locator(`.document-tree-group[data-document-group="${name}"]`)
const documentRow = () => page.locator('.note-tree-document').filter({ hasText: '拖动文档' })
const tree = id => page.locator(`.notes-tree-item[data-note-id="${id}"]`)
async function expandBase(id) {
  const button = base(id).locator('.note-tree-base')
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  await base(id).locator('.document-group-toggle').first().waitFor()
  for (const toggle of await base(id).locator('.document-group-toggle').all()) {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  }
  await base(id).locator('.note-tree-document').first().waitFor()
}
async function waitNote(parentId) {
  for (let i = 0; i < 100 && (await provider.getNote(note.id))?.parentId !== parentId; i++) await delay(50)
  assert.equal((await provider.getNote(note.id)).parentId, parentId)
}
async function syntheticDrop(source, target, clearState = false) {
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: transfer })
  if (clearState) await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await target.dispatchEvent('dragover', { dataTransfer: transfer })
  assert.equal(await target.getAttribute('data-drop-region'), 'true')
  assert.match(await target.getAttribute('data-drop-label'), /松开以移入/)
  assert.equal(await target.evaluate(node => getComputedStyle(node, '::after').pointerEvents), 'none')
  assert.equal(await target.evaluate(node => getComputedStyle(node, '::after').backgroundColor), 'rgba(255, 255, 255, 0.22)')
  await page.screenshot({ path: join(root, 'drop-group-region.png') })
  await target.dispatchEvent('drop', { dataTransfer: transfer })
  await transfer.dispose()
}
try {
  await page.goto(origin); await ready('entries'); await expandBase(one.id); await expandBase(two.id)
  const toggle = group(one.id, '分组甲').locator('.document-group-toggle')
  const arrow = toggle.locator('.tree-disclosure')
  const opened = await arrow.evaluate(n => getComputedStyle(n).transform)
  await toggle.click()
  await page.evaluate(() => {
    window.dragEvents = []
    for (const name of ['dragstart', 'dragover', 'drop', 'dragend']) window.addEventListener(name, event => {
      window.dragEvents.push({ name, target: event.target.className, types: [...event.dataTransfer.types], value: event.dataTransfer.getData('application/x-dsh-knowledge-document-id') })
    }, true)
  })
  assert.notEqual(await arrow.evaluate(n => getComputedStyle(n).transform), opened)
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  await toggle.click()
  await documentRow().dragTo(group(one.id, '分组乙').locator('.document-group-toggle'))
  await group(one.id, '分组乙').locator('.note-tree-document').filter({ hasText: '拖动文档' }).waitFor()
  assert.equal((await provider.get(entry.id)).group, '分组乙')
  // Global blur/drag recovery must not discard the actual DataTransfer payload.
  await syntheticDrop(documentRow(), group(one.id, '分组甲'), true)
  await group(one.id, '分组甲').locator('.note-tree-document').filter({ hasText: '拖动文档' }).waitFor()
  assert.equal((await provider.get(entry.id)).group, '分组甲')
  assert.equal(await page.locator('.toast.error').count(), 0)
  await documentRow().dragTo(group(two.id, '第二库分组').locator('.document-group-toggle'))
  await page.locator('.toast.error').waitFor()
  assert.equal((await provider.get(entry.id)).knowledgeBaseId, one.id)
  await page.mouse.move(0, 0)
  await page.locator('.toast.error').waitFor({ state: 'detached', timeout: 11000 })
  await documentRow().dragTo(base(two.id).locator('.note-tree-base'))
  await base(two.id).locator('.note-tree-document').filter({ hasText: '拖动文档' }).waitFor()
  assert.equal((await provider.get(entry.id)).knowledgeBaseId, two.id)
  console.log('PASS native drag: same-library group, cross-library rejection/expiry, library move, recovery payload, disclosure')

  await page.goto(origin + '?view=notes'); await ready('notes')
  await tree(note.id).dragTo(page.locator(`.notes-file-row[data-note-id="${folder.id}"]`))
  await waitNote(folder.id)
  await tree(folder.id).locator('.notes-tree-row').click()
  await tree(note.id).waitFor()
  // Expanded directory region (a file row inside it), not only its heading.
  await tree(note.id).dragTo(page.locator('.notes-tree'), { targetPosition: { x: 12, y: 550 } })
  await waitNote(null)
  await tree(note.id).dragTo(tree(sibling.id))
  await waitNote(folder.id)
  await tree(nested.id).locator('.notes-tree-row').click(); await tree(child.id).waitFor()
  await tree(note.id).dragTo(tree(child.id))
  await waitNote(nested.id)
  // Current directory content whitespace moves into that directory.
  await tree(folder.id).locator('.notes-tree-row').click()
  if (!await tree(note.id).isVisible()) await tree(folder.id).locator('.notes-tree-row').click()
  await tree(note.id).dragTo(page.locator('.notes-content.is-folder'), { targetPosition: { x: 500, y: 450 } })
  await waitNote(folder.id)
  await page.getByRole('button', { name: '会话指令', exact: true }).click()
  const guide = page.getByRole('dialog')
  assert.match(await guide.innerText(), /一份完整预览，一次确认/)
  assert.doesNotMatch(await guide.innerText(), /授权也不会从上一轮延续/)
  await guide.getByRole('button', { name: '知道了' }).click()
  const upload = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['external upload'], '拖放导入.txt', { type: 'text/plain' }))
    return transfer
  })
  await tree(nested.id).dispatchEvent('dragover', { dataTransfer: upload })
  await tree(nested.id).dispatchEvent('drop', { dataTransfer: upload })
  await upload.dispose()
  for (let i = 0; i < 100 && !(await provider.listNotes({ parentId: nested.id })).some(n => n.name === '拖放导入.txt'); i++) await delay(50)
  assert.ok((await provider.listNotes({ parentId: nested.id })).some(n => n.name === '拖放导入.txt'))
  console.log('PASS notes: list folder, tree whitespace, expanded region, nearest nested folder, content area, updated guide')
  console.log('PASS external file drag still imports into the target directory')

  await page.locator('[data-nav-view="candidates"]').click(); await ready('candidates')
  for (const [width, height] of [[1440, 900], [390, 844], [812, 375]]) {
    await page.setViewportSize({ width, height })
    const layout = await page.evaluate(() => {
      const main = document.querySelector('.main'), content = document.querySelector('.page'), header = document.querySelector('.topbar')
      content.scrollTop = 700
      return { top: content.getBoundingClientRect().top, bottom: header.getBoundingClientRect().bottom,
        scroll: content.scrollTop, mainScroll: main.scrollTop, overflow: getComputedStyle(content).overflowY, width: document.documentElement.scrollWidth }
    })
    assert.ok(layout.top >= layout.bottom - 1, JSON.stringify(layout))
    assert.ok(layout.scroll > 0, JSON.stringify(layout))
    assert.equal(layout.mainScroll, 0)
    assert.equal(layout.overflow, 'auto')
    assert.ok(layout.width <= width + 1)
    await page.screenshot({ path: join(root, `review-${width}.png`) })
  }
  assert.deepEqual(errors, [])
  console.log(`PASS review independent scrolling at desktop/mobile/landscape: ${root}`)
} catch (error) {
  console.error(error)
  console.error('Page errors:', errors)
  console.error(await page.evaluate(() => window.dragEvents).catch(() => []))
  await page.screenshot({ path: join(root, 'failed.png') }).catch(() => {})
  console.error('Artifacts:', root)
  throw error
} finally { await browser.close(); await provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
