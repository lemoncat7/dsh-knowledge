// Real browser, isolated documents only. No live profile is accessed.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { registerKnowledgeWeb } from '../lib/web.js'

const { chromium } = await import(pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href)
const root = await mkdtemp(join(tmpdir(), 'knowledge-sync-browser-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const routes = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, '/knowledge-local/v1', { authMode: 'same-origin' })
registerKnowledgeWeb(ctx, '/knowledge', '/knowledge-local/v1', 'same-origin')
const server = createServer((req, res) => {
  const route = routes.find(r => req.url === r.path || req.url.startsWith(r.path + '/'))
  if (route) void route.handler(req, res)
  else { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/knowledge/`
const note = await provider.createNoteDocument('同步测试', null, '# 初始笔记\n\n原始正文')
const draft = { knowledgeBaseId: 'default', title: '知识同步测试', body: '原始知识正文', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 0.8 }
const entry = await provider.create(draft)
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  for (const kind of ['note', 'knowledge']) {
    const mutate = text => kind === 'note' ? provider.updateNoteContent(note.id, Buffer.from(text)) : provider.update(entry.id, { ...draft, body: text })
    await page.goto(kind === 'note' ? `${base}?view=notes&noteId=${note.id}` : `${base}?documentId=${entry.id}&knowledgeBaseId=default`)
    await page.locator('.ProseMirror').waitFor()
    await mutate('外部更新一')
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('外部更新一'), { timeout: 15000 })
    await page.locator('.ProseMirror').fill('本地未保存的修改')
    await page.evaluate(() => { window.originalEditor = document.querySelector('.ProseMirror'); document.activeElement.blur() })
    await mutate('外部更新二')
    await page.getByRole('button', { name: '查看并处理', exact: true }).waitFor({ timeout: 15000 })
    assert.equal(await page.locator('.ProseMirror').innerText(), '本地未保存的修改')
    assert.equal(await page.evaluate(() => window.originalEditor === document.querySelector('.ProseMirror')), true)
    await page.getByRole('button', { name: '查看并处理', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '文档有新版本' })
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('textbox', { name: '服务端最新正文' }).inputValue(), '外部更新二')
    assert.equal(await dialog.getByRole('textbox', { name: '合并后的正文' }).inputValue(), '本地未保存的修改')
    for (const [width, scheme] of [[1280, 'light'], [375, 'dark']]) {
      await page.setViewportSize({ width, height: 850 })
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await page.screenshot({ path: join(root, `${kind}-${scheme}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 850 })
    await dialog.getByRole('textbox', { name: '合并后的正文' }).fill('外部更新二\n\n本地未保存的修改')
    await dialog.getByRole('button', { name: '应用到草稿', exact: true }).click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.notes-save-state, .editor-save-status')].some(n => n.textContent === '已保存'))
    const actual = kind === 'note' ? (await provider.readNote(note.id)).content.toString() : (await provider.get(entry.id)).body
    assert.match(actual, /外部更新二[\s\S]*本地未保存的修改/)
    // A delayed save response must not mark newly typed content as saved.
    let release, entered
    const waiting = new Promise(resolve => { entered = resolve })
    const hold = new Promise(resolve => { release = resolve })
    let intercepted = false
    const intercept = async route => {
      if (route.request().method() !== 'PUT' || intercepted) return route.continue()
      intercepted = true
      const response = await route.fetch()
      entered()
      await hold
      await route.fulfill({ response })
    }
    await page.route('**/knowledge-local/v1/**', intercept)
    await page.locator('.ProseMirror').fill('提交时的正文')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await waiting
    await page.locator('.ProseMirror').fill('等待保存时继续输入')
    release()
    await page.waitForFunction(() => [...document.querySelectorAll('.notes-save-state, .editor-save-status')].some(n => n.textContent === '未保存'))
    assert.equal(await page.locator('.ProseMirror').innerText(), '等待保存时继续输入')
    await page.unroute('**/knowledge-local/v1/**', intercept)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.notes-save-state, .editor-save-status')].some(n => n.textContent === '已保存'))
    // Save before the next metadata poll: the server still rejects stale writes.
    await page.locator('.ProseMirror').fill('另一份本地修改')
    await mutate('服务端新版本三')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('dialog', { name: '文档有新版本' }).waitFor()
    const preserved = kind === 'note' ? (await provider.readNote(note.id)).content.toString() : (await provider.get(entry.id)).body
    assert.equal(preserved, '服务端新版本三')
    await page.getByRole('button', { name: '继续保留草稿', exact: true }).click()
    assert.equal(await page.locator('.ProseMirror').innerText(), '另一份本地修改')
  }
  assert.deepEqual(errors, [])
  console.log(`Document sync browser checks passed. Screenshots: ${root}`)
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await provider.close()
}
