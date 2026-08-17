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
  const dispose = registerKnowledgeWeb(ctx, '/knowledge', '/knowledge-api/v1')
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
  assert.match(html, /name="dsh-knowledge-api" content="\/knowledge-api\/v1"/)
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
  assert.match(application, /app-sidebar-resizer/)
  assert.match(application, /调整栏宽/)
  assert.match(application, /知识库二级栏/)
  assert.match(application, /隐藏主导航栏/)
  assert.match(application, /显示知识库栏/)
  assert.match(application, /隐藏文档列表栏/)
  assert.match(application, /data-sidebar-hidden/)
  assert.match(application, /data-library-hidden/)

  const stylesheet = await fetch(`${base}/knowledge/styles.css`)
  assert.equal(stylesheet.status, 200)
  const styles = await stylesheet.text()
  assert.match(styles, /data-sidebar-hidden="true"/)
  assert.match(styles, /data-document-list-hidden="true"/)
  assert.match(application, /aria-valuenow/)
  const shellSource = application.slice(application.indexOf('function renderShell()'), application.indexOf('function renderSidebar()'))
  assert.doesNotMatch(shellSource, /新建知识库|新建知识/)

  const missing = await fetch(`${base}/knowledge/not-found.js`)
  assert.equal(missing.status, 404)
  const post = await fetch(`${base}/knowledge`, { method: 'POST' })
  assert.equal(post.status, 405)
})
