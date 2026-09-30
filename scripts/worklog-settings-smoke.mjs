import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { Store } from '../worklog/store.js'
import { handler } from '../worklog/http.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const store = new Store(':memory:')
const serve = handler(store, {}, () => undefined, async () => [{ id: 'test', models: [{ id: 'test', name: '测试模型' }] }])
const bundle = await build({ stdin: { contents: `
  import React from 'react'; import { createRoot } from 'react-dom/client';
  import { Settings } from './worklog/ui/Settings.jsx'; import { api } from './worklog/ui/api.js';
  const root = createRoot(document.getElementById('root'));
  const state = await api('/state');
  root.render(<section className="dsh-worklog wl-dialog-content"><Settings state={state} currentProject="/fixture/project" save={async config => { await api('/settings', config); document.getElementById('saved').textContent = '已保存'; }} /></section>);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' })
const css = await readFile('worklog/client.css', 'utf8') + '\n' + await readFile('worklog/web-embedded.css', 'utf8') + '\n#root{max-width:720px;margin:auto}.wl-dialog-content label:not(.wl-check){display:grid;gap:8px;margin:16px 0}body{margin:0}'
const server = createServer((req, res) => {
  if (req.url.startsWith('/worklog-control/')) return serve(req, res)
  if (req.url === '/fixture.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].text)
  if (req.url === '/fixture.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(css)
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><p id="saved" role="status"></p><script type="module" src="/fixture.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  assert.equal(await page.getByLabel('每日定时整理', { exact: true }).isChecked(), false)
  assert.equal(await page.getByLabel('每日整理时间', { exact: true }).count(), 0)
  await page.getByLabel('每日定时整理', { exact: true }).check()
  await page.getByLabel('每日整理时间', { exact: true }).fill('21:30')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByText('已保存', { exact: true }).waitFor()
  assert.equal(store.config().scheduleEnabled, true); assert.equal(store.config().scheduleTime, '21:30')
  await page.reload()
  assert.equal(await page.getByLabel('每日定时整理', { exact: true }).isChecked(), true)
  assert.equal(await page.getByLabel('每日整理时间', { exact: true }).inputValue(), '21:30')
  for (const [width, height, dark] of [[1280,900,false], [375,812,false], [812,375,true]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(dark => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, dark)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.getByLabel('每日整理时间', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/worklog-schedule-${width}.png`, fullPage: true })
  }
  await page.getByLabel('每日定时整理', { exact: true }).uncheck()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByText('已保存', { exact: true }).waitFor()
  assert.equal(store.config().scheduleEnabled, false)
  assert.deepEqual(errors, [])
  console.log('Schedule settings passed: opt-in, time save/reload, disable, mobile/landscape/dark, no overflow or page errors')
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close() }
