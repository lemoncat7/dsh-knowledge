import { build } from 'esbuild'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { JournalService } from '../worklog/service.js'
import { defaults, dayOf } from '../worklog/domain.js'
import { handler } from '../worklog/http.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const dir = await mkdtemp(join(tmpdir(), 'journal-browser-'))
const provider = new LocalKnowledgeProvider(join(dir, 'knowledge.sqlite'))
const token = provider.createApiToken('browser-fixture', ['admin']).token
const center = new Store(':memory:'), local = new Store(':memory:')
center.configure({ ...defaults, provider: 'central', model: 'test' })
local.configure({ ...defaults, enabled: true, scope: 'all' })
const day = dayOf(Date.now(), defaults.timezone)
center.note(day, '中央素材'); center.save(day, '# 中央日报', 0)
local.note(day, '本地旧记录'); local.save(day, '# 原本地日报', 0)
const cw = new Worker(center, {}, async () => '# 测试日报')
const central = new JournalService(center, cw, async () => [{ id: 'central', models: [{ id: 'test', name: '中央测试模型' }] }])
let centralHandler, available = true
registerKnowledgeApi({ get() {}, webServer: { register(route) { centralHandler = route.handler; return () => {} } } }, provider, '/knowledge-api/v1', { worklog: (...args) => central.serveCentral(...args) })
const centralServer = createServer((req, res) => available ? centralHandler(req, res) : res.writeHead(503).end('offline'))
await new Promise(resolve => centralServer.listen(0, '127.0.0.1', resolve))
const connection = { backend: 'remote', remoteUrl: `http://127.0.0.1:${centralServer.address().port}/knowledge-api/v1`, remoteToken: token, remoteTimeoutMs: 1000 }
const lw = new Worker(local, {}, async () => { throw new Error('Local generation must never run') })
const client = new JournalService(local, lw, async () => [], () => connection)
const clientHandler = handler(local, lw, () => undefined, undefined, (...args) => client.browser(...args))
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Workspace} from './worklog/ui/Workspace.jsx'; createRoot(document.getElementById('root')).render(<Workspace embedded currentProject="/browser/project" />);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' })
const css = await readFile('worklog/client.css', 'utf8') + '\n' + await readFile('worklog/web-embedded.css', 'utf8')
const server = createServer((req, res) => {
  if (req.url.startsWith('/worklog-control/')) return clientHandler(req, res)
  if (req.url === '/fixture.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].text)
  if (req.url === '/fixture.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(css)
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('heading', { name: '中央日报', exact: true }).waitFor()
  await page.getByRole('button', { name: '采集设置', exact: true }).click()
  await page.getByLabel('日报整理模型', { exact: true }).selectOption(JSON.stringify(['central', 'test']))
  await page.getByLabel('每日定时整理', { exact: true }).check()
  await page.getByLabel('每日整理时间', { exact: true }).fill('22:15')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(center.config().scheduleTime, '22:15'); assert.equal(local.config().scheduleEnabled, false)
  await page.getByRole('button', { name: '迁移本地历史', exact: true }).click()
  await page.getByRole('button', { name: '确认上传历史', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await client.outbox.running
  assert.equal(center.records(day).length, 2); assert.equal(center.report(day).markdown, '# 中央日报')
  assert.equal(center.detail(day).history.length, 1)
  for (const [width, height] of [[375,812],[812,375]]) {
    await page.setViewportSize({ width, height })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
  available = false
  await page.reload()
  await page.getByRole('button', { name: '采集设置', exact: true }).click()
  await page.getByText('中央暂不可用，中央配置不能读取或修改；本机采集仍可单独保存。').waitFor()
  await page.getByLabel('启用工作素材采集').uncheck()
  await page.getByRole('button', { name: '仅保存本机采集', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(local.config().enabled, false)
  available = true
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await page.getByRole('heading', { name: '中央日报', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  await page.screenshot({ path: '/tmp/worklog-central-browser.png', fullPage: true })
  console.log('Central journal UI passed: shared settings, local collection, migration, offline control/recovery, responsive layout')
} finally {
  await browser.close(); await client.close(); await central.close(); local.close(); center.close()
  for (const instance of [server, centralServer]) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)) }
  await provider.close(); await rm(dir, { recursive: true, force: true })
}
