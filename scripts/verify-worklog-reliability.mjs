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
const previousDay = dayOf(Date.now() - 86400000, defaults.timezone)
store.note(previousDay, '前一天独立来源，不能混入当天', '/工作项目')
for (let i = 0; i < 65; i++) store.note(day, `工作素材 ${i} 独立关键词${i} ` + '内容'.repeat(2000), '/工作项目')
const first = store.records(day)[0]
store.save(day, `# 示例日报\n成果 [依据:${first.id}]`, 0)
store.save(day, `# 示例日报\n更新成果 [依据:${first.id}]`, 1)
const worker = new Worker(store, {}, async () => '# 整理完成')
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
const output = await mkdtemp(join(tmpdir(), 'worklog-reliability-browser-')), errors = []
try {
  for (const [width, height] of [[375, 900], [900, 375], [1280, 900]]) for (const dark of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(dark => { document.body.toggleAttribute('data-ds-dark-theme', dark); document.body.style.background = dark ? '#25282c' : '#f5f6f7' }, dark)
    await page.getByRole('heading', { name: '示例日报', exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelectorAll('.wl-source-row').length === 30 && document.querySelector('.wl-evidence').getAttribute('aria-busy') === 'false')
    assert.equal(requests.some(url => url.includes('/day?')), false, 'no full-day bodies requested')
    assert.equal(await page.locator('.wl-source-range').count(), 0, 'no second date selector in sources')
    const sourceRequests = requests.filter(url => url.startsWith('/worklog-control/v1/sources?'))
    assert.ok(sourceRequests.length > 0)
    assert.ok(sourceRequests.every(url => {
      const query = new URL(url, 'http://localhost').searchParams
      return query.get('day') === day && !query.has('from') && !query.has('to')
    }), 'source requests are scoped to selected day')
    await page.getByRole('link', { name: '查看依据' }).click()
    await page.getByRole('heading', { name: '用户需求' }).waitFor()
    assert.ok(requests.some(url => url.includes('/source?id=')))
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.wl-source-pages').textContent.includes('第 2 页') && document.querySelector('.wl-evidence').getAttribute('aria-busy') === 'false')
    await page.getByRole('checkbox', { name: '选择本页来源', exact: true }).check()
    await page.getByRole('button', { name: '批量排除', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.wl-evidence>header').textContent.includes('纳入 35 条'))
    await page.waitForFunction(() => document.querySelector('.wl-evidence').getAttribute('aria-busy') === 'false')
    await page.getByRole('checkbox', { name: '选择本页来源', exact: true }).check()
    await page.getByRole('button', { name: '重新纳入', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.wl-evidence>header').textContent.includes('纳入 65 条'))
    await page.getByRole('searchbox', { name: '搜索内容' }).fill('独立关键词64')
    await page.waitForFunction(() => document.querySelectorAll('.wl-source-row').length === 1 && document.querySelector('.wl-evidence').getAttribute('aria-busy') === 'false')
    await page.locator('.wl-more summary').click()
    await page.getByRole('button', { name: '历史版本', exact: true }).click()
    await page.getByRole('button', { name: /版本 1/ }).click()
    await page.getByRole('button', { name: '作为编辑草稿' }).waitFor()
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow')
    await page.screenshot({ path: join(output, `${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true })
    if (width === 375) await page.getByRole('button', { name: '日期', exact: true }).click()
    await page.getByLabel('选择日报日期', { exact: true }).filter({ visible: true }).fill(previousDay)
    await page.waitForFunction(day => document.querySelector('.wl-heading h2')?.textContent === day && document.querySelectorAll('.wl-source-row').length === 1 && document.querySelector('.wl-evidence')?.getAttribute('aria-busy') === 'false', previousDay)
    await page.locator('.wl-source-open').click()
    await page.getByText('前一天独立来源，不能混入当天', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    requests.length = 0
    console.log(JSON.stringify({ width, dark, passed: true })); await page.close()
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ cases: 6, output, errors: 0 }))
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker.close(); store.close() }
