// Optional real-browser regression checks. Uses isolated SQLite/files, never a live profile.
// KNOWLEDGE_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/verify-ui.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeApi, LOCAL_MANAGEMENT_API_PREFIX } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { knowledgeDesignCss } from '../lib/design-tokens.js'

const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = await mkdtemp(join(tmpdir(), 'knowledge-ui-regression-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const routes = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, {
  authMode: 'same-origin',
  service: { current: () => ({ publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' }) },
})
registerKnowledgeWeb(ctx, '/knowledge', LOCAL_MANAGEMENT_API_PREFIX, 'same-origin')
const server = createServer((req, res) => {
  const route = routes.find(route => req.url.split('?')[0] === route.path || req.url.startsWith(route.path + '/'))
  if (route) void route.handler(req, res)
  else if (req.url.startsWith('/knowledge-control/v1/models')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ providers: [] }))
  } else { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const headers = { 'x-dsh-knowledge-client': 'management-web', 'content-type': 'text/markdown' }
const noteResponse = await fetch(`${base}${LOCAL_MANAGEMENT_API_PREFIX}/notes/files?name=UI-regression.md`, {
  method: 'POST', headers, body: '# 页面验证\n\n正文保留检查。\n\n## 标题定位\n\n' + '较长内容用于布局检查。\n\n'.repeat(60),
})
assert.equal(noteResponse.status, 201)
const note = await noteResponse.json()
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  await verifyMaterialParity(browser, root)
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/knowledge/?view=notes&noteId=${note.id}`)
  await page.locator('.notes-document-title').waitFor({ timeout: 10000 }).catch(async error => {
    console.error({ errors, body: (await page.locator('body').innerText()).slice(0, 4000) })
    throw error
  })
  await page.locator('.ProseMirror').waitFor()
  // Exercise ordinary motion, not only the accessibility override.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => { window.resizeEditor = document.querySelector('.ProseMirror') })
  const resize = page.getByRole('separator', { name: '调整主导航栏宽度' })
  await resize.focus()
  await page.keyboard.press('Home')
  assert.equal(await resize.getAttribute('aria-valuenow'), '190')
  const handleBox = await resize.boundingBox()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 72, handleBox.y + 40, { steps: 12 })
  await page.mouse.up()
  assert.equal(await resize.getAttribute('aria-valuenow'), '262')
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-resizing-columns')), false)
  assert.equal(await page.locator('.app-shell').evaluate(node => getComputedStyle(node).transitionProperty), 'all')
  assert.equal(await page.locator('.app-shell').evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  assert.equal(await page.evaluate(() => window.resizeEditor === document.querySelector('.ProseMirror')), true, 'resize destroyed editor')
  for (const [width, height, scheme] of [[1280, 850, 'light'], [320, 740, 'light'], [375, 812, 'light'], [768, 1024, 'light'], [1024, 768, 'dark'], [812, 375, 'dark']]) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal page overflow')
    if (width === 375) assert.equal(await page.locator('.notes-editor-outline').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(244, 244, 244)', 'mobile outline must occlude the document')
    const toolbar = page.locator('.notes-document-toolbar')
    for (const selector of ['[data-note-save-state]', '[data-note-save]', '[data-note-outline]', '.notes-document-more > summary']) {
      const bounds = await toolbar.locator(selector).boundingBox()
      if (bounds && bounds.x + bounds.width > width) {
        await page.screenshot({ path: join(root, 'toolbar-overflow.png') })
      }
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `${width}: ${selector} clipped ${JSON.stringify(bounds)}`)
    }
    assert.equal(await toolbar.locator(':scope > .notes-document-actions > .button').count(), 2, 'secondary actions escaped overflow')
    const more = toolbar.locator('.notes-document-more > summary')
    await page.evaluate(() => { window.menuEditor = document.querySelector('.ProseMirror') })
    await more.click()
    const popup = toolbar.getByRole('menu')
    assert.deepEqual(await popup.getByRole('menuitem').allTextContents(), ['查找', '页面历史', '下载', '创建分享', '复制引用', '重命名', '查看已分享'])
    const popupBounds = await popup.boundingBox()
    const popupMaterial = await popup.evaluate(node => {
      const style = getComputedStyle(node)
      return { background: style.backgroundColor, filter: style.backdropFilter }
    })
    assert.equal(popupMaterial.background, width <= 760
      ? scheme === 'dark' ? 'rgb(29, 38, 40)' : 'rgb(232, 234, 236)'
      : scheme === 'dark' ? 'rgba(29, 38, 40, 0.98)' : 'rgba(232, 234, 236, 0.98)')
    assert.equal(popupMaterial.filter === 'none', width <= 760)
    assert.ok(popupBounds.x >= 0 && popupBounds.x + popupBounds.width <= width + 1 && popupBounds.y + popupBounds.height <= height + 1, `${width}: menu outside viewport`)
    assert.equal(await popup.getByRole('menuitem').first().evaluate(node => {
      const bounds = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    }), true, `${width}: outline or editor covers the document menu`)
    await page.screenshot({ path: join(root, `document-menu-${width}-${scheme}.png`) })
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '查看已分享')
    await page.keyboard.press('Escape')
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.evaluate(() => window.menuEditor === document.querySelector('.ProseMirror')), true, 'menu rebuilt editor')
    await page.screenshot({ path: join(root, `notes-${width}-${scheme}.png`) })
  }
  await page.setViewportSize({ width: 375, height: 812 })
  const noteMore = page.locator('.notes-document-more > summary')
  await noteMore.click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await noteMore.getAttribute('aria-expanded'), 'false')
  await noteMore.click()
  await page.locator('.topbar h1').click()
  assert.equal(await noteMore.getAttribute('aria-expanded'), 'false', 'outside click did not dismiss menu')
  await page.evaluate(() => { window.originalEditor = document.querySelector('.ProseMirror') })
  const menu = page.locator('.topbar button[aria-expanded]')
  await menu.click()
  await page.locator('.app-sidebar-scrim').click({ position: { x: 350, y: 300 } })
  assert.equal(await page.evaluate(() => window.originalEditor === document.querySelector('.ProseMirror')), true, 'navigation destroyed the editor')
  await verifyKnowledgeActions(browser)
  await verifyRestrainedMotion(page)

  // Exercise the shared select with real form semantics and keyboard focus.
  await page.evaluate(async () => {
    const form = document.createElement('form')
    form.id = 'ui-select-fixture'
    form.innerHTML = '<label>目标库<select class="select" required name="base"><option value="">请选择</option><option value="a">Alpha</option><option value="b">Beta</option></select></label><button type="reset">重置</button><button type="button">后续操作</button>'
    document.body.replaceChildren(form)
    window.changes = 0
    form.addEventListener('change', () => window.changes++)
  })
  const combo = page.getByRole('combobox')
  await combo.waitFor()
  await combo.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('select').inputValue(), 'b')
  assert.equal(await page.evaluate(() => window.changes), 1)
  await page.evaluate(() => { document.querySelector('select').value = 'a' })
  assert.match(await combo.textContent(), /Alpha/)
  await combo.click()
  await page.keyboard.press('Escape')
  assert.equal(await combo.getAttribute('aria-expanded'), 'false')
  await page.getByRole('button', { name: '重置', exact: true }).click()
  assert.equal(await page.locator('select').inputValue(), '')
  assert.equal(await page.evaluate(() => document.querySelector('form').reportValidity()), false)
  assert.equal(await combo.getAttribute('aria-invalid'), 'true')
  await page.evaluate(() => { document.querySelector('select').append(new Option('Gamma', 'g')) })
  await combo.click()
  await page.getByRole('option', { name: 'Gamma', exact: true }).click()
  assert.equal(await page.evaluate(() => new FormData(document.querySelector('form')).get('base')), 'g')
  await page.evaluate(() => { document.querySelector('select').disabled = true })
  assert.equal(await combo.isDisabled(), true)
  await page.evaluate(() => {
    const inspector = document.createElement('footer')
    inspector.className = 'note-inspector'
    inspector.style.width = '570px'
    inspector.innerHTML = '<label><span>类型</span><select class="note-meta-select"><option>偏好</option></select></label><label class="note-tags-field"><span>标签</span><input value="项目, 工作流, 资料"></label><span class="note-format-hint">Markdown · Ctrl/⌘ S 保存</span>'
    document.body.append(inspector)
  })
  await page.locator('.note-inspector .knowledge-select-trigger').waitFor()
  assert.equal(await page.locator('.note-inspector label > span').first().evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap')
  await page.evaluate(async () => {
    const ui = await import('/knowledge/ui-primitives.js')
    const { createDialogPresenter } = await import('/knowledge/dialogs.js')
    const dialogs = createDialogPresenter({ ...ui, showToast() {}, friendlyError: error => error.message })
    const body = ui.element('form', {}, ui.element('label', {}, '权限范围', ui.element('select', { class: 'select' }, ui.element('option', { value: 'read' }, '只读'))))
    dialogs.openModal({ title: '测试对话框', body })
    window.openNestedDialog = () => dialogs.openModal({ title: '子对话框', body: ui.element('p', {}, '子窗口') })
  })
  await page.getByRole('dialog').getByRole('combobox').click()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 1, 'Escape on listbox should not close dialog')
  await page.evaluate(() => window.openNestedDialog())
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 1, 'Escape should close only the top dialog')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', screenshots: root, checks: ['desktop/mobile/tablet portrait and landscape', 'light/dark material parity', 'no horizontal overflow', 'consistent document action groups', 'menu hit targets above outline', 'menu keyboard/outside dismissal/dialog action', 'menu and resize preserve editor', 'pointer and keyboard resize', 'stable hover bounds and shadows', 'static skeleton/reduced motion', 'select keyboard/reset/validation/dynamic options/form data'] }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await provider.close()
}

async function verifyKnowledgeActions(browser) {
  await provider.createKnowledgeBase({ name: '移动目标', description: '', defaultTags: [], extractionInstructions: '' })
  await provider.create({ knowledgeBaseId: 'default', title: '工具栏检查', body: '只使用隔离测试数据。', type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: 1 })
  const [document] = await provider.listDocuments('default')
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: 'reduce' })
  try {
    await page.goto(`${base}/knowledge/?view=entries&knowledgeBaseId=default&documentId=${document.id}`)
    const toolbar = page.locator('.note-editor-toolbar')
    await toolbar.locator('.notes-document-more').waitFor()
    for (const width of [1280, 1024, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 850 })
      const trigger = toolbar.locator('.notes-document-more > summary')
      const bounds = await trigger.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${width}: knowledge actions clipped`)
      await trigger.click()
      assert.deepEqual(await toolbar.getByRole('menuitem').allTextContents(), ['移动到…', '标记结束', '删除文档'])
      await page.keyboard.press('Escape')
    }
  } finally { await page.close() }
}

async function verifyRestrainedMotion(page) {
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    document.body.innerHTML = `<main style="padding:30px;display:grid;gap:12px">
      <button class="button">操作</button><article class="base-card">知识库</article>
      <article class="knowledge-card">知识卡片</article><article class="metric">统计</article>
      <button class="note-tree-document" aria-current="page">知识文档</button>
      <div class="notes-tree-item" data-selected="true"><button class="notes-tree-row">笔记</button><div class="notes-row-actions"><button class="button tiny">下载</button></div></div>
      <div class="loading-skeleton"><span class="skeleton-phase">正在加载</span><div class="skeleton-line skeleton-title"></div><div class="skeleton-block"></div></div>
      <div class="route-progress"><span style="--route-progress:.4"></span></div>
      </main>`
  })
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const selector of ['.button', '.base-card', '.knowledge-card', '.metric', '.note-tree-document', '.notes-tree-item']) {
      const node = page.locator(selector).first()
      await page.mouse.move(0, 0)
      const before = await node.boundingBox()
      const shadow = await node.evaluate(node => getComputedStyle(node).boxShadow)
      await node.hover()
      await page.waitForTimeout(200)
      assert.deepEqual(await node.boundingBox(), before, `${scheme}: ${selector} moves on hover`)
      assert.equal(await node.evaluate(node => getComputedStyle(node).boxShadow), shadow, `${selector} grows a shadow`)
    }
  }
  await page.locator('.notes-tree-row').focus()
  assert.equal(await page.locator('.notes-row-actions').evaluate(node => getComputedStyle(node).pointerEvents), 'auto', 'row actions must work with keyboard focus')
  assert.equal(await page.locator('.skeleton-line').evaluate(node => getComputedStyle(node, '::after').content), 'none')
  assert.equal(await page.locator('.skeleton-block').evaluate(node => getComputedStyle(node, '::after').animationName), 'none')
  assert.equal(await page.locator('.route-progress span').evaluate(node => getComputedStyle(node).transitionProperty), 'transform')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.skeleton-phase').evaluate(node => getComputedStyle(node, '::before').animationName), 'none')
}

async function verifyMaterialParity(browser, outputDirectory) {
  const [clientCss, activityCss, workspaceCss] = await Promise.all([
    readFile(new URL('../src/client.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/knowledge-activity.css', import.meta.url), 'utf8'),
    readFile(new URL('../web/styles.css', import.meta.url), 'utf8'),
  ])
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setContent(`<style>${knowledgeDesignCss('.dsh-knowledge-activity-panel', 'body[data-ds-dark-theme] .dsh-knowledge-activity-panel', false)}${clientCss}${activityCss}
      body{margin:0;padding:24px;background:#e6e8ea}.comparison{height:690px;display:grid;grid-template-columns:1fr 1fr;gap:24px}iframe{width:100%;height:100%;border:0}
      </style><div class="comparison"><section class="dsh-knowledge-activity-panel">
      <header class="dsh-knowledge-activity-header">会话知识库</header><nav class="dsh-knowledge-activity-tabs"><button class="is-active">知识文档</button><button>笔记文档</button></nav>
      <div class="dsh-knowledge-activity-browser"><form class="dsh-knowledge-activity-search"><input placeholder="搜索已挂载知识…"></form><div class="dsh-knowledge-activity-list-heading"><strong>项目资料</strong></div><button class="dsh-knowledge-activity-row">右栏 · 中性玻璃材质</button></div>
      </section><iframe></iframe></div>`)
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame()
    await frame.setContent(`<html data-dsh-embed-mode="embedded"><head><style>${knowledgeDesignCss()}${workspaceCss}</style></head><body><main class="main" style="margin:0;width:100%;height:690px"><header class="topbar">完整工作区</header><div style="padding:16px"><input class="input" placeholder="搜索文档…"><p>完整工作区 · 中性玻璃材质</p></div></main></body></html>`)
    const material = node => {
      const css = getComputedStyle(node)
      return { background: css.backgroundColor, filter: css.backdropFilter, color: css.color }
    }
    for (const scheme of ['light', 'dark']) {
      await page.evaluate(scheme => {
        document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')
        document.body.style.background = scheme === 'dark' ? '#182022' : '#e6e8ea'
      }, scheme)
      await frame.evaluate(scheme => { document.documentElement.dataset.colorScheme = scheme }, scheme)
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const activity = await page.locator('.dsh-knowledge-activity-panel').evaluate(material)
      const workspace = await frame.locator('.main').evaluate(material)
      assert.deepEqual(activity, workspace, `${scheme}: activity and workspace material differ`)
      assert.equal(await page.locator('.dsh-knowledge-activity-header').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)')
      assert.equal(await page.locator('.dsh-knowledge-activity-tabs').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)')
      const control = await page.locator('.dsh-knowledge-activity-search').evaluate(node => getComputedStyle(node).backgroundColor)
      assert.equal(control, await frame.locator('.input').evaluate(node => getComputedStyle(node).backgroundColor))
      await page.screenshot({ path: join(outputDirectory, `material-${scheme}.png`) })
    }
  } finally { await page.close() }
}
