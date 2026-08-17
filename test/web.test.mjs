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
  assert.match(html, /src="\/knowledge\/app\.js"/)

  const script = await fetch(`${base}/knowledge/app.js`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type'), /text\/javascript/)
  const application = await script.text()
  assert.match(application, /sessionStorage/)
  assert.match(application, /api\('documents'\)/)
  assert.match(application, /knowledge-library-column/)
  assert.match(application, /document-list-column/)
  assert.match(application, /markdown-document/)
  assert.match(application, /column-resizer/)
  assert.match(application, /aria-valuenow/)

  const missing = await fetch(`${base}/knowledge/not-found.js`)
  assert.equal(missing.status, 404)
  const post = await fetch(`${base}/knowledge`, { method: 'POST' })
  assert.equal(post.status, 405)
})
