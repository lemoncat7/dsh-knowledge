// Isolated real API. Held requests prove dependency ordering, not just fast localhost timing.
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
const root = await mkdtemp(join(tmpdir(), 'knowledge-document-open-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const routes = [], ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, { authMode: 'same-origin', service: { current: () => ({ publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' }) } })
registerKnowledgeWeb(ctx, '/knowledge', LOCAL_MANAGEMENT_API_PREFIX, 'same-origin')
const entry = await provider.create({ knowledgeBaseId: 'default', group: '测试', title: '打开测试', body: '# 正文\n\n正文不等待关联笔记。', type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: .9 })
const note = await provider.createNoteDocument('并行读取.md', null, '# 第一版\n\n旧内容')
const parent = await provider.createNoteFolder('祖先目录')
const nested = await provider.createNoteFolder('尚未加载的目录', parent.id)
const deep = await provider.createNoteDocument('深层文档.md', nested.id, '# 深层正文\n\n路径不挡正文')
const server = createServer((req, res) => {
  const route = routes.find(r => req.url.split('?')[0] === r.path || req.url.startsWith(r.path + '/'))
  if (route) return void route.handler(req, res)
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"providers":[]}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}/knowledge/`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const errors = []
async function hold(page, pattern) {
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const handler = async route => { started(); await gate; await route.continue().catch(() => {}) }
  await page.route(pattern, handler)
  return {
    entered: () => Promise.race([entered, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Not started in parallel: ' + pattern)), 5000); timer.unref() })]),
    async release() { release(); await page.unroute(pattern, handler) },
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(origin)
  await page.locator('.note-tree-base').first().click()
  await page.locator('.document-group-toggle').click()
  const data = await hold(page, `**/entries/${entry.id}`)
  const refs = await hold(page, `**/entries/${entry.id}/note-references`)
  const runtime = await hold(page, '**/note-editor.js*')
  await page.locator(`[data-document-id="${entry.id}"]`).click()
  await Promise.all([data.entered(), refs.entered(), runtime.entered()])
  await runtime.release(); await data.release()
  await page.locator('.knowledge-live-editor .tiptap').waitFor()
  assert.match(await page.locator('.document-reference-bar').innerText(), /正在读取/)
  await page.locator('.knowledge-live-editor .tiptap').fill('未保存的草稿')
  await page.evaluate(() => { window.editorBeforeReferences = document.querySelector('.tiptap') })
  await refs.release()
  await page.getByText('这篇知识还没有关联笔记', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.editorBeforeReferences === document.querySelector('.tiptap')), true)
  assert.equal((await page.locator('.tiptap').innerText()).trim(), '未保存的草稿')
  console.log('PASS editor download starts before data; slow references do not block body or remount unsaved editor')
  await page.close()

  const notes = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  notes.on('pageerror', e => errors.push(e.message))
  await notes.goto(origin + '?view=notes')
  const row = notes.locator(`.notes-tree-item[data-note-id="${note.id}"] .notes-tree-row`)
  await row.waitFor()
  // Simulate another writer updating after the directory was loaded.
  await provider.updateNoteContent(note.id, Buffer.from('# 第二版\n\n最新的正文'))
  const metadata = await hold(notes, `**/notes/${note.id}`)
  const version = await hold(notes, `**/notes/${note.id}/versions/1/content`)
  const editor = await hold(notes, '**/note-editor.js*')
  await row.click()
  await Promise.all([metadata.entered(), version.entered(), editor.entered()])
  await version.release(); await editor.release(); await metadata.release()
  await notes.locator('.tiptap').getByText('最新的正文', { exact: true }).waitFor()
  assert.doesNotMatch(await notes.locator('.tiptap').innerText(), /旧内容/)
  console.log('PASS note metadata, version content and editor load concurrently; stale directory version is revalidated')
  await notes.locator('.notes-search input').fill('深层文档')
  const found = notes.locator('.notes-search-row').filter({ hasText: '深层文档' })
  await found.waitFor()
  const ancestry = await hold(notes, `**/notes/${nested.id}`)
  await found.click(); await ancestry.entered()
  await notes.locator('.tiptap').getByText('路径不挡正文', { exact: true }).waitFor()
  await notes.getByText('正在读取路径…', { exact: true }).waitFor()
  await notes.evaluate(() => { window.editorBeforePath = document.querySelector('.tiptap') })
  await ancestry.release()
  await notes.locator('.notes-document-toolbar').getByRole('button', { name: '尚未加载的目录', exact: true }).waitFor()
  assert.equal(await notes.evaluate(() => window.editorBeforePath === document.querySelector('.tiptap')), true)
  console.log('PASS slow ancestry lookup cannot delay or remount note body')
  await notes.close()
  assert.deepEqual(errors, [])
} finally { await browser.close(); await provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
