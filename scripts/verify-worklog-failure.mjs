import { build } from 'esbuild'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { defaults, dayOf } from '../worklog/domain.js'
import { handler } from '../worklog/http.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const store = new Store(':memory:'); store.configure({ ...defaults, enabled: true, provider: 'test', model: 'test' })
const day = dayOf(Date.now(), defaults.timezone)
for (let i = 0; i < 42; i++) store.note(day, `来源 ${i}：已经完成独立任务并核验`, '/项目/' + '长目录'.repeat(40))
store.save(day, '# 原有日报\n原文保留', 0, [], false)
store.enqueue(day)
const worker = new Worker(store, { async *stream() { yield { type: 'text-delta', text: '# 新草稿\n事项 <img src=x onerror=alert(1)> [依据:R999]' } } })
await worker.tick()
const api = handler(store, worker, () => undefined)
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Workspace} from './worklog/ui/Workspace.jsx'; createRoot(document.getElementById('root')).render(<Workspace embedded />);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' })
const css = await readFile('worklog/client.css', 'utf8') + '\n' + await readFile('worklog/web-embedded.css', 'utf8')
const requests = []
const server = createServer((req, res) => {
  if (req.url.startsWith('/worklog-control/')) { requests.push(req.url); return api(req, res) }
  if (req.url === '/fixture.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].text)
  if (req.url === '/fixture.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(css)
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const output = await mkdtemp(join(tmpdir(), 'worklog-failure-browser-')), errors = []
try {
  for (const [width, height] of [[375, 900], [900, 375], [1280, 900]]) for (const dark of [false, true]) {
    requests.length = 0
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(dark => { document.body.toggleAttribute('data-ds-dark-theme', dark); document.body.style.background = dark ? '#25282c' : '#f5f6f7' }, dark)
    await page.getByRole('heading', { name: '原有日报', exact: true }).waitFor()
    assert.ok(!requests.some(url => url.includes('/failure?')), 'details load only on demand')
    await page.getByRole('button', { name: '查看失败详情', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '整理失败详情', exact: true })
    await dialog.getByRole('heading', { name: '第 2 行 · 编号不存在' }).waitFor()
    assert.equal(await dialog.locator('img').count(), 0, 'untrusted snippets are text')
    assert.ok(await dialog.locator('pre').textContent().then(text => text.includes('R999')))
    await dialog.locator('summary').click()
    assert.equal(await dialog.locator('.wl-failure-sources button').count(), 30)
    await dialog.getByRole('button', { name: '下一页', exact: true }).click()
    await dialog.getByText('第 2 页', { exact: true }).waitFor()
    assert.equal(await dialog.locator('.wl-failure-sources button').count(), 12)
    await dialog.locator('.wl-failure-sources button').first().click()
    await page.getByRole('heading', { name: '用户需求', exact: true }).waitFor()
    await page.getByRole('dialog', { name: '工作记录 · 查看依据', exact: true }).getByRole('button', { name: '关闭弹窗', exact: true }).click()
    assert.equal(await dialog.isVisible(), true)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow')
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), 'no dialog overflow')
    await page.screenshot({ path: join(output, `${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '查看失败详情', exact: true }).click()
    await dialog.waitFor()
    await page.mouse.click(1, 1)
    await dialog.waitFor({ state: 'hidden' })
    console.log(JSON.stringify({ width, height, dark, passed: true }))
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ cases: 6, output, errors: 0 }))
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker.close(); store.close() }
