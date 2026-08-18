import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { registerKnowledgeWeb } from '../lib/web.js'

test('management console serves a secured same-origin application', async (t) => {
  let route
  const ctx = {
    webServer: {
      register(value) {
        route = value
        return () => { route = undefined }
      },
    },
    get() { return undefined },
  }
  const dispose = registerKnowledgeWeb(ctx, '/knowledge', '/knowledge-local/v1', 'same-origin')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/knowledge')
  const server = createServer((req, res) => void route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    dispose()
    await new Promise(resolve => server.close(resolve))
  })

  const index = await fetch(`${base}/knowledge`)
  assert.equal(index.status, 200)
  assert.equal(index.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'self'/)
  const html = await index.text()
  assert.match(html, /name="dsh-knowledge-api" content="\/knowledge-local\/v1"/)
  assert.match(html, /name="dsh-knowledge-auth-mode" content="same-origin"/)
  assert.match(html, /src="\/knowledge\/app\.js\?v=[a-f0-9]{12}"/)
  assert.match(html, /href="\/knowledge\/styles\.css\?v=[a-f0-9]{12}"/)
  assert.equal(index.headers.get('cache-control'), 'no-store')

  const script = await fetch(`${base}/knowledge/app.js`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type'), /text\/javascript/)
  assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  const application = await script.text()
  assert.match(application, /sessionStorage/)
  assert.match(application, /api\('documents'\)/)
  assert.match(application, /knowledge-library-column/)
  assert.match(application, /document-list-column/)
  assert.match(application, /markdown-document/)
  assert.match(application, /column-resizer/)
  assert.match(application, /aria-valuetext/)
  assert.match(application, /document-column-controls/)
  assert.match(application, /显示文档栏位/)
  assert.match(application, /收起.*展开/)
  assert.doesNotMatch(application, /COLUMN_REOPEN_DISTANCE|collapseThreshold|data-collapsed/)
  assert.match(application, /app-sidebar-resizer/)
  assert.doesNotMatch(application, /视图设置|openLayoutEditor|layoutRangeField/)
  assert.match(application, /pane-toggle-button/)
  assert.match(application, /aria-pressed/)
  assert.match(application, /workspace-switcher/)
  assert.match(application, /knowledgeBaseQuery/)
  assert.match(application, /loading-skeleton/)
  assert.match(application, /data-sidebar-hidden/)
  assert.match(application, /data-library-hidden/)
  assert.match(application, /永久删除/)
  assert.match(application, /输入知识库名称确认/)
  assert.match(application, /x-dsh-knowledge-client/)
  assert.match(application, /远程知识库 API/)
  assert.match(application, /复制地址/)
  assert.match(application, /开启远程 API/)
  assert.match(application, /已撤销令牌已永久删除/)
  assert.match(application, /captureScrollPosition/)
  assert.match(application, /restoreScrollPosition/)
  assert.match(application, /data-scroll-key/)
  assert.match(application, /document-reader/)

  const stylesheet = await fetch(`${base}/knowledge/styles.css`)
  assert.equal(stylesheet.status, 200)
  const styles = await stylesheet.text()
  assert.match(styles, /data-sidebar-hidden="true"/)
  assert.match(styles, /data-document-list-hidden="true"/)
  assert.match(styles, /document-column-control\[aria-pressed="true"\]/)
  assert.match(application, /aria-valuenow/)
  const shellSource = application.slice(application.indexOf('function renderShell()'), application.indexOf('function renderSidebar()'))
  assert.doesNotMatch(shellSource, /新建知识库|新建知识/)
  const sidebarSource = application.slice(application.indexOf('function renderSidebar()'), application.indexOf('function renderCurrentView()'))
  assert.match(sidebarSource, /工作区/)
  assert.doesNotMatch(sidebarSource, /interfaceIcon|nav-icon/)

  const missing = await fetch(`${base}/knowledge/not-found.js`)
  assert.equal(missing.status, 404)
  const post = await fetch(`${base}/knowledge`, { method: 'POST' })
  assert.equal(post.status, 405)
})
