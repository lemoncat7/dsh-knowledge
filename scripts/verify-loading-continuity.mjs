// Browser regression tests use a temporary local database, never production data.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeApi, LOCAL_MANAGEMENT_API_PREFIX } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = await mkdtemp(join(tmpdir(), 'knowledge-loading-continuity-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const pendingCandidate = await provider.propose({ action: 'create', reason: '角标测试', draft: {
  knowledgeBaseId: 'default', group: '测试', title: '待审核测试', body: '点击进入审核前不应获取正文。',
  type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .9,
} })
const routes = [], ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, { authMode: 'same-origin', service: { current: () => ({ publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' }) } })
registerKnowledgeWeb(ctx, '/knowledge', LOCAL_MANAGEMENT_API_PREFIX, 'same-origin')
const note = await provider.createNoteDocument('历史测试.md', null, '# 第一版\n\n旧内容。')
await provider.updateNoteContent(note.id, Buffer.from('# 第二版\n\n中间内容。'))
await provider.updateNoteContent(note.id, Buffer.from('# 第三版\n\n当前内容。'))
const server = createServer((req, res) => {
  const route = routes.find(r => req.url.split('?')[0] === r.path || req.url.startsWith(r.path + '/'))
  if (route) return void route.handler(req, res)
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"providers":[]}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/knowledge/`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: 'reduce' })
const errors = [], requests = []
page.on('pageerror', e => errors.push(e.message))
page.on('request', r => requests.push(new URL(r.url()).pathname))
const ready = view => page.locator(`.app-shell[data-view="${view}"][data-loading="false"]`).waitFor()
const nav = view => page.locator(`[data-nav-view="${view}"]`).click()
async function hold(pattern) {
  let release, started
  const wait = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const handler = async route => { started(); await wait; await route.continue().catch(() => {}) }
  await page.route(pattern, handler)
  return { entered: () => Promise.race([entered, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Request not observed: ' + pattern)), 10000); timer.unref() })]), async release() { release(); await page.unroute(pattern, handler) } }
}
async function openHistory() {
  await page.locator('.notes-document-more').click()
  await page.locator('[data-note-history]').click()
}
try {
  const slowCount = await hold('**/candidates/counts')
  await page.goto(base)
  await ready('entries')
  await slowCount.entered()
  assert.equal(requests.filter(path => path.endsWith('/candidates')).length, 0, 'initial load requests only counts, never the review list')
  assert.equal(requests.filter(path => path.includes('change-review')).length, 0, 'review UI remains lazy')
  const initialStage = await page.locator('.view-stage').elementHandle()
  const initialContent = await page.locator('.view-stage > *').first().elementHandle()
  await slowCount.release()
  await page.waitForFunction(() => document.querySelector('[data-review-pending-count]')?.textContent === '1')
  assert.ok(await initialStage.evaluate(el => el === document.querySelector('.view-stage')))
  assert.ok(await initialContent.evaluate(el => el.isConnected), 'background count must preserve the active page')
  await initialStage.dispose(); await initialContent.dispose()
  console.log('PASS: count prefetch does not block navigation, fetch list/review assets or remount content')
  await page.evaluate(() => {
    window.originalStage = document.querySelector('.view-stage')
    window.surfaces = ['.app-shell', '.sidebar', '.topbar', '.main', '.page'].map(selector => [selector, document.querySelector(selector)])
    window.notesButton = document.querySelector('[data-nav-view="notes"]')
    window.loadingSkeletons = 0
    new MutationObserver(events => {
      for (const event of events) for (const node of event.addedNodes) {
        if (node.nodeType === 1) window.loadingSkeletons += Number(node.matches('.loading-skeleton')) + node.querySelectorAll('.loading-skeleton').length
      }
    }).observe(document.querySelector('#app'), { childList: true, subtree: true })
  })
  const slow = await hold('**/notes?*')
  const immediate = await page.evaluate(async () => {
    const start = performance.now()
    window.notesButton.click()
    await new Promise(requestAnimationFrame)
    return { elapsed: performance.now() - start, view: document.querySelector('.app-shell').dataset.view,
      active: window.notesButton.getAttribute('aria-current'), title: document.querySelector('.topbar h1').textContent }
  })
  assert.equal(immediate.view, 'notes', 'route must switch on the next frame, before data returns')
  assert.equal(immediate.active, 'page')
  assert.equal(immediate.title, '笔记文档')
  await slow.entered()
  assert.equal(await page.evaluate(() => window.originalStage === document.querySelector('.view-stage')), true)
  assert.equal(await page.locator('.view-stage').getAttribute('aria-busy'), 'true')
  assert.equal(await page.locator('.route-placeholder').count(), 1)
  assert.equal(await page.evaluate(() => window.surfaces.every(([selector, node]) => node === document.querySelector(selector))), true)
  await page.locator('.route-pending-label').waitFor()
  assert.equal(await page.locator('[data-nav-view="notes"]').getAttribute('aria-busy'), 'true')
  await slow.release(); await ready('notes')
  assert.equal(await page.locator('.view-stage').evaluate(n => n.inert), false)
  assert.equal(await page.locator('.view-stage').getAttribute('aria-busy'), 'false')
  assert.equal(await page.evaluate(() => window.surfaces.every(([selector, node]) => node === document.querySelector(selector))), true)
  assert.equal(await page.evaluate(() => window.notesButton === document.querySelector('[data-nav-view="notes"]')), true)
  assert.equal(await page.evaluate(() => window.loadingSkeletons), 0)
  console.log('PASS: next-frame navigation before data, stable surfaces/buttons, content-only update:', JSON.stringify(immediate))

  for (const view of ['entries', 'bases', 'candidates', 'tokens', 'notes']) { await nav(view); await ready(view) }
  assert.equal(await page.locator('[data-review-pending-count]').textContent(), '1')
  await provider.review(pendingCandidate.id, { decision: 'reject' })
  await nav('candidates'); await ready('candidates')
  assert.equal(await page.locator('[data-review-pending-count]').textContent(), '0', 'loaded review counts replace prefetched counts, including zero')
  await nav('notes'); await ready('notes')
  assert.equal(await page.evaluate(() => window.surfaces.every(([selector, node]) => node === document.querySelector(selector))), true)
  assert.equal(await page.evaluate(() => window.loadingSkeletons), 0)
  const stale = await hold('**/notes/shares')
  await nav('shares'); await stale.entered()
  await nav('entries'); await ready('entries')
  await stale.release()
  await page.waitForTimeout(80)
  assert.equal(await page.locator('.app-shell').getAttribute('data-view'), 'entries')
  assert.equal(await page.locator('.route-pending-label').count(), 0)
  console.log('PASS: first route visits and rapid switching do not flash or revive stale routes')

  const fail = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture unavailable"}' })
  await page.route('**/tokens', fail)
  await nav('tokens'); await ready('tokens'); await page.locator('.error-state').waitFor()
  await page.unroute('**/tokens', fail)
  await page.locator('.error-state').getByRole('button', { name: '重试' }).click()
  await ready('tokens')
  assert.equal(await page.locator('.error-state').count(), 0)
  console.log('PASS: route failure recovers without leaving retained content inert')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await nav('entries'); await ready('entries')
  await nav('tokens'); await ready('tokens')
  const motion = await page.locator('.view-stage').evaluate(node => node.getAnimations().map(animation => ({
    duration: animation.effect.getTiming().duration,
    opacity: animation.effect.getKeyframes().map(frame => Number(frame.opacity)),
  })))
  assert.ok(motion.length <= 1, 'rapid switching must not accumulate content animations')
  for (const animation of motion) {
    assert.equal(animation.duration, 120)
    assert.ok(animation.opacity.every(value => value >= .9), 'content must not fade out to a blank page')
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await nav('notes'); await ready('notes')
  assert.equal(await page.locator('.view-stage').evaluate(node => node.getAnimations().length), 0)
  console.log('PASS: short content-only reveal, interruptible and disabled for reduced motion')

  await page.goto(base + `?view=notes&noteId=${note.id}`); await ready('notes')
  await page.locator('.ProseMirror').waitFor()
  const currentReadsBefore = requests.filter(p => p.endsWith('/versions/3/content')).length
  const versions = await hold('**/versions?*')
  await openHistory(); await versions.entered()
  const dialog = page.locator('.note-history-dialog')
  const pendingBox = await dialog.boundingBox()
  await page.locator('.note-history-pending').getByText('正在读取页面历史…').waitFor()
  await versions.release()
  await page.locator('.note-history-content').getByText('第三版', { exact: true }).waitFor()
  const loadedBox = await dialog.boundingBox()
  assert.ok(Math.abs(pendingBox.width - loadedBox.width) < 1 && Math.abs(pendingBox.height - loadedBox.height) < 1, JSON.stringify({pendingBox, loadedBox, styles: await dialog.evaluate(n => ({height:getComputedStyle(n).height, width:getComputedStyle(n).width, classes:n.className}))}))
  assert.equal(requests.filter(p => p.endsWith('/versions/3/content')).length, currentReadsBefore)
  console.log('PASS: history opens at final size and reuses already loaded current content')

  const old = await hold('**/versions/1/content')
  await page.evaluate(() => { window.historyBody = document.querySelector('.note-history-content').firstChild })
  await page.locator('[data-note-version="1"]').click(); await old.entered()
  assert.equal(await page.evaluate(() => window.historyBody === document.querySelector('.note-history-content').firstChild), true)
  await page.locator('.note-history-status').getByText('正在读取版本 1…').waitFor()
  assert.equal(await dialog.getByRole('button', { name: '当前版本', exact: true }).isDisabled(), true)
  await old.release()
  await page.locator('.note-history-content').getByText('第一版', { exact: true }).waitFor()
  await page.locator('[data-note-version="3"]').click()
  await page.locator('.note-history-content').getByText('第三版', { exact: true }).waitFor()
  assert.equal(await page.locator('.note-history-status:visible').count(), 0)
  console.log('PASS: historical selection keeps existing content, prevents incorrect restore and uses cache')

  await page.route('**/versions/2/content', fail)
  await page.locator('[data-note-version="2"]').click()
  await page.locator('.note-history-status').getByText('无法读取版本 2', { exact: false }).waitFor()
  assert.equal(await page.locator('.note-history-content').getByText('第三版', { exact: true }).count(), 1)
  await page.unroute('**/versions/2/content', fail)
  const racing = await hold('**/versions/2/content')
  await page.locator('[data-note-version="2"]').click(); await racing.entered()
  await page.locator('[data-note-version="1"]').click()
  await racing.release()
  await page.locator('.note-history-content').getByText('第一版', { exact: true }).waitFor()
  await page.locator('[data-note-version="2"]').click()
  await page.locator('.note-history-content').getByText('第二版', { exact: true }).waitFor()
  console.log('PASS: failed history keeps previous content, retry works and stale reads are ignored')

  for (const [width, height, scheme, motion] of [[1280, 850, 'light', 'no-preference'], [375, 812, 'dark', 'reduce'], [812, 375, 'dark', 'reduce']]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: scheme, reducedMotion: motion })
    const box = await dialog.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height + 1)
    const content = page.locator('.note-history-content')
    assert.ok((await content.boundingBox()).height > 50, 'history text must remain reachable in short viewports')
    await content.getByText('中间内容。', { exact: true }).scrollIntoViewIfNeeded()
    const textBox = await content.getByText('中间内容。', { exact: true }).boundingBox()
    const footer = await dialog.locator('.dialog-footer').boundingBox()
    assert.ok(textBox.y >= box.y && textBox.y + textBox.height <= footer.y)
    await page.screenshot({ path: join(root, `history-${width}.png`), animations: 'disabled' })
  }
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click()
  const closing = await hold('**/versions?*')
  await openHistory(); await closing.entered()
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await closing.release(); await page.waitForTimeout(220)
  assert.equal(await page.locator('.note-history-dialog').count(), 0)

  await page.route('**/versions?*', fail)
  await openHistory()
  await dialog.getByRole('button', { name: '重试', exact: true }).waitFor()
  await page.evaluate(() => { window.failedHistoryDialog = document.querySelector('.note-history-dialog') })
  await page.unroute('**/versions?*', fail)
  const retrying = await hold('**/versions?*')
  await dialog.getByRole('button', { name: '重试', exact: true }).click(); await retrying.entered()
  const retryBox = await dialog.boundingBox()
  assert.equal(await page.evaluate(() => window.failedHistoryDialog === document.querySelector('.note-history-dialog')), true)
  assert.equal(await page.locator('.note-history-dialog').count(), 1)
  await retrying.release()
  await dialog.locator('.note-history-content').getByText('第三版', { exact: true }).waitFor()
  const retryLoadedBox = await dialog.boundingBox()
  assert.ok(Math.abs(retryBox.height - retryLoadedBox.height) < 1)
  console.log('PASS: history failure retries in the same stable dialog without replaying entrance animation')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ verified: true, browserErrors: 0, screenshots: root }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await provider.close()
}
