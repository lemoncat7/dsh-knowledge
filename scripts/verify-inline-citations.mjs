import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { assertCitationLayout } from './citation-layout-check.mjs'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { KnowledgeHandleCodec } from '../lib/retrieval.js'
import { citationMarkdown } from '../lib/knowledge-citations.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeActivityControl } from '../lib/activity-control.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const provider = new LocalKnowledgeProvider(':memory:')
const draft = { knowledgeBaseId: 'default', group: '测试', title: '部署 (验证) [记录]', body: '# 操作手册\n\n' + Array.from({ length: 35 }, (_, i) => `## 验证步骤 ${i + 1}\n\n服务启动后仍需检查**业务功能**，不能只凭进程存在就判断部署成功。\n\n`).join(''), type: 'lesson', tags: [], scope: { kind: 'global' }, confidence: .9 }
const entry = await provider.create(draft)
const mount = { targetKind: 'session', targetId: 'citation-session', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'none', includeTags: [], excludeTags: [], extractionInstructions: '' }
await provider.upsertMount(mount)
const sourceKey = () => 'a'.repeat(64)
const codec = new KnowledgeHandleCodec(Buffer.alloc(32, 7), sourceKey)
const citation = codec.citation({ session: { id: 'citation-session', header: {} } }, entry, 58, 60)
const markdown = `服务启动成功不代表业务验证通过。（来源：${citationMarkdown(citation)}）`
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { MarkdownText, MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives';
  import { installCitationLinks } from './lib/citation-links.js';
  window.fileCalls = 0;
  installCitationLinks(ref => { location.href = '/knowledge/?citation=' + encodeURIComponent(JSON.stringify(ref)); });
  createRoot(document.getElementById('fixture')).render(<MarkdownDelegateProvider openFile={() => { window.fileCalls++; }}>
    <MarkdownText text={${JSON.stringify(markdown)}} labels={{code:{copyLabel:'复制',copiedLabel:'已复制'},footnotes:'来源'}} />
  </MarkdownDelegateProvider>);
`, resolveDir: process.cwd(), loader: 'tsx' }, outfile: '/tmp/citation-fixture.js', nodePaths: process.env.DSH_TEST_NODE_MODULES?.split(':') || [], bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
const routes = [], ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, '/api', { authMode: 'same-origin' })
registerKnowledgeWeb(ctx, '/knowledge', '/api', 'same-origin')
registerKnowledgeActivityControl(ctx, provider, { sourceKey })
const server = createServer((req, res) => {
  if (req.url.startsWith('/knowledge-control/v1/activity/citation')) citationRequests++
  if (req.url === '/fixture') { res.setHeader('content-type', 'text/html'); return res.end('<link rel="stylesheet" href="/fixture.css"><div id="fixture"></div><script src="/fixture.js"></script>') }
  if (req.url === '/fixture.js' || req.url === '/fixture.css') {
    const ext = req.url.endsWith('.js') ? '.js' : '.css'
    res.setHeader('content-type', ext === '.js' ? 'text/javascript' : 'text/css')
    return res.end(bundle.outputFiles.find(file => file.path.endsWith(ext))?.contents)
  }
  const route = [...routes].sort((a, b) => b.path.length - a.path.length).find(route => req.url.startsWith(route.path))
  if (route) void route.handler(req, res)
  else { res.writeHead(404); res.end() }
})
let citationRequests = 0
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}), args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(origin + '/fixture')
  const link = page.getByRole('button', { name: /第 58–60 行/ })
  await link.waitFor()
  assert.match(await page.locator('#fixture').textContent(), /。\（来源：.*第 58–60 行.*\）/)
  await page.screenshot({ path: '/tmp/knowledge-inline-citation.png' })
  assert.equal(citationRequests, 0, 'No eager citation fetches')
  await link.hover()
  await page.getByRole('tooltip').getByText(/验证步骤|服务启动后/).waitFor()
  assert.equal(citationRequests, 1)
  assert.ok((await page.getByRole('tooltip').innerText()).length < 600)
  await page.screenshot({ path: '/tmp/knowledge-citation-hover.png' })
  await page.keyboard.press('Escape')
  await page.getByRole('tooltip').waitFor({ state: 'detached' })
  await link.focus()
  await page.keyboard.press('Enter')
  await page.locator('.is-citation-target').first().waitFor()
  assert.equal(await page.locator('.app-shell').getAttribute('data-view'), 'entries')
  assert.ok(await page.locator('[data-source-start]').count() > 35, 'Full original document, not an excerpt page')
  await page.waitForFunction(() => document.activeElement?.classList.contains('is-citation-target'))
  assert.notEqual(await page.locator('.is-citation-target').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
  assert.ok(await page.locator('.note-editor-scroll').evaluate(el => el.scrollTop) > 100)
  assert.equal(await page.locator('.citation-workspace').count(), 0)
  await page.screenshot({ path: '/tmp/knowledge-citation-source.png' })
  await assertCitationLayout(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: '/tmp/knowledge-citation-mobile.png' })
  await assertCitationLayout(page)
  await page.setViewportSize({ width: 844, height: 390 })
  await assertCitationLayout(page)
  await page.goto(origin + '/knowledge/cite/' + encodeURIComponent(JSON.stringify(citation)))
  await page.locator('.is-citation-target').first().waitFor()
  const mapping = await page.locator('.is-citation-target').evaluateAll(nodes => nodes.map(n => ({ start: Number(n.dataset.sourceStart), end: Number(n.dataset.sourceEnd) })))
  assert.ok(mapping.every(r => r.start <= 60 && r.end >= 58))
  const safe = await page.evaluate(() => window.DshKnowledgeMarkdown.renderMarkdownSource('<section data-source-start="999" onclick="alert(1)">safe</section>\n\n<script>alert(1)</script>'))
  assert.ok(!safe.includes('data-source-start="999"') && !safe.includes('onclick=') && !safe.includes('<script'))
  const blocks = await page.evaluate(() => {
    const node = document.createElement('div')
    node.innerHTML = window.DshKnowledgeMarkdown.renderMarkdownSource('# 标题\r\n\r\n重复\r\n\r\n重复\r\n\r\n```txt\r\n# 不是标题\r\n```\r\n\r\n[文档][ref]\r\n\r\n[ref]: https://example.com\r\n')
    return [...node.children].map(block => ({ start: Number(block.dataset.sourceStart), end: Number(block.dataset.sourceEnd), text: block.textContent.trim(), link: block.querySelector('a')?.getAttribute('href') }))
  })
  assert.deepEqual(blocks.map(b => [b.start, b.end]), [[1, 1], [3, 3], [5, 5], [7, 9], [11, 11]])
  assert.equal(blocks.at(-1).link, 'https://example.com')
  const response = await page.request.get(`${origin}/knowledge-control/v1/activity/citation?sessionId=citation-session&citation=${encodeURIComponent(JSON.stringify(citation))}`)
  assert.equal(response.status(), 401, 'control route requires browser-client header')
  const cross = await page.request.get(`${origin}/knowledge-control/v1/activity/citation?sessionId=citation-session&citation=${encodeURIComponent(JSON.stringify(citation))}`, { headers: { 'x-dsh-knowledge-client': 'conversation-web', origin: 'https://evil.test' } })
  assert.equal(cross.status(), 403)
  await provider.update(entry.id, { ...draft, body: '新增前言\n' + draft.body })
  await page.reload()
  await page.getByText(/来源引用的是 v1.*v2/).waitFor()
  assert.equal(await page.locator('.is-citation-target').count(), 0, 'never highlight stale offsets')
  assert.deepEqual(errors, [])
  console.log('Inline citations passed: lazy hover, Escape, full-document navigation, exact paragraph mapping, safe HTML, keyboard focus, bounded scroll, responsive layout and stale-version rejection.')
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await provider.close()
}
