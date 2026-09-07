import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'

async function serve(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/knowledge-api/v1/`
  return { url, remote: new RemoteKnowledgeProvider({ url, token: 'test', timeoutMs: 5000 }) }
}

const request = {
  text: '异常上报 nonStopCrypto NSC_5006 '.repeat(400), limit: 6,
  projectId: '/project/中文', knowledgeBaseIds: ['base-a', 'base-b'],
  includeTags: ['风险'], excludeTags: ['过时'], types: ['procedure'],
}

test('long Chinese search uses an authenticated POST and preserves all search fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-post-search-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const token = provider.createApiToken('read-only', ['read']).token
  let received
  provider.search = async input => { received = input; return [] }
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } } }, provider, '/knowledge-api/v1')
  const methods = []
  const { url } = await serve(t, (req, res) => { methods.push(req.method); void handler(req, res) })
  const remote = new RemoteKnowledgeProvider({ url, token, timeoutMs: 5000 })
  assert.deepEqual(await remote.search(request), [])
  assert.deepEqual(received, request)
  assert.deepEqual(methods, ['POST'])
  await remote.search({ ...request, text: '异常' })
  assert.deepEqual(methods, ['POST', 'GET'])
  assert.deepEqual(received, { ...request, text: '异常' })
  for (const body of [{ text: 42 }, { text: 'x', types: ['invalid'] }, { text: 'x', includeTags: 'x' }, { text: 'x', limit: 101 }, { text: 'x', projectId: {} }]) {
    const res = await fetch(url + 'search', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(res.status, 400)
    await res.arrayBuffer()
  }
  const denied = await fetch(url + 'search', { method: 'POST', body: JSON.stringify(request) })
  assert.equal(denied.status, 401)
  await denied.arrayBuffer()
})

for (const status of [404, 405, 501]) {
  test(`legacy server ${status}: bounded GET fallback retains scope and filters`, async (t) => {
    const calls = []
    const { remote } = await serve(t, (req, res) => {
      calls.push({ method: req.method, url: req.url })
      req.resume()
      if (req.method === 'POST') res.writeHead(status).end('<h1>Unsupported method</h1>')
      else res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
    })
    assert.deepEqual(await remote.search(request), [])
    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET'])
    assert.ok(Buffer.byteLength(calls[1].url) < 6000)
    const params = new URL(calls[1].url, 'http://local').searchParams
    assert.equal(params.get('projectId'), request.projectId)
    for (const [key, values] of [['knowledgeBaseId', request.knowledgeBaseIds], ['includeTag', request.includeTags], ['excludeTag', request.excludeTags], ['type', request.types]]) {
      assert.deepEqual(params.getAll(key), values)
    }
    assert.equal(params.get('limit'), '6')
    assert.match(params.get('q'), /NSC_5006/)
  })
}

for (const status of [400, 401, 403, 414, 431, 500]) {
  test(`HTTP ${status} does not retry or expose the query, including proxy HTML errors`, async (t) => {
    let calls = 0
    const { remote } = await serve(t, (req, res) => {
      calls++
      req.resume()
      res.writeHead(status).end(`<h1>Rejected ${req.url} PRIVATE_CONVERSATION</h1>`)
    })
    for (const text of ['PRIVATE_CONVERSATION', request.text]) {
      await assert.rejects(remote.search({ ...request, text }), error => {
        assert.equal(error.status, status)
        assert.match(error.message, new RegExp(`HTTP ${status} for search`))
        assert.doesNotMatch(error.message, /PRIVATE_CONVERSATION|q=|异常/)
        assert.ok(error.message.length < 200)
        return true
      })
    }
    assert.equal(calls, 2)
  })
}

test('legacy fallback refuses oversized filters instead of dropping the search scope', async (t) => {
  let calls = 0
  const { remote } = await serve(t, (req, res) => { calls++; req.resume(); res.writeHead(405).end() })
  await assert.rejects(remote.search({ ...request, projectId: '目录'.repeat(3000) }), /filters exceed/)
  assert.equal(calls, 1)
})

test('aborted searches never fall back', async (t) => {
  let calls = 0
  const { remote } = await serve(t, (req, res) => { calls++; res.end('[]') })
  await assert.rejects(remote.search(request, AbortSignal.abort()), /request failed/)
  assert.equal(calls, 0)
})
