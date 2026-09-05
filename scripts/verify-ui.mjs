// Optional real-browser regression checks. Uses isolated SQLite/files, never a live profile.
// KNOWLEDGE_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/verify-ui.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeApi, LOCAL_MANAGEMENT_API_PREFIX } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/knowledge/?view=notes&noteId=${note.id}`)
  await page.locator('.notes-document-title').waitFor({ timeout: 10000 }).catch(async error => {
    console.error({ errors, body: (await page.locator('body').innerText()).slice(0, 4000) })
    throw error
  })
  await page.locator('.ProseMirror').waitFor()
  for (const [width, height, scheme] of [[1280, 850, 'light'], [375, 812, 'light'], [1024, 768, 'dark']]) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal page overflow')
    if (width === 375) assert.equal(await page.locator('.notes-editor-outline').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(244, 244, 244)', 'mobile outline must occlude the document')
    await page.screenshot({ path: join(root, `notes-${width}-${scheme}.png`) })
  }
  await page.setViewportSize({ width: 375, height: 812 })
  await page.evaluate(() => { window.originalEditor = document.querySelector('.ProseMirror') })
  const menu = page.locator('.topbar button[aria-expanded]')
  await menu.click()
  await page.locator('.app-sidebar-scrim').click({ position: { x: 350, y: 300 } })
  assert.equal(await page.evaluate(() => window.originalEditor === document.querySelector('.ProseMirror')), true, 'navigation destroyed the editor')

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
  console.log(JSON.stringify({ result: 'passed', screenshots: root, checks: ['desktop/mobile/tablet', 'light/dark', 'no horizontal overflow', 'menu preserves editor', 'select keyboard/reset/validation/dynamic options/form data'] }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await provider.close()
}
