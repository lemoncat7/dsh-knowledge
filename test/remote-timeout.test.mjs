import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { RemoteKnowledgeProvider, RemoteProviderError } from '../lib/remote-provider.js'

async function fixture(t, handler) {
  let calls = 0
  const server = createServer((req, res) => { calls++; handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const remote = new RemoteKnowledgeProvider({ url: `http://127.0.0.1:${server.address().port}/v1/`, token: 'PRIVATE_TOKEN', timeoutMs: 500 })
  return { remote, calls: () => calls }
}
function check(kind, phase) {
  return error => {
    assert.ok(error instanceof RemoteProviderError)
    assert.equal(error.status, 0)
    assert.equal(error.kind, kind)
    assert.equal(error.phase, phase)
    assert.doesNotMatch(error.message, /PRIVATE_|q=|127\.0\.0\.1/)
    if (kind === 'timeout') { assert.match(error.message, /500 ms/); assert.match(error.message, /请求超时/); assert.match(error.message, /无法据此确认服务端是否已完成/) }
    return true
  }
}
test('search header timeout names the operation and deadline without leaking the query or retrying', async t => {
  const { remote, calls } = await fixture(t, () => {})
  await assert.rejects(remote.search({ text: 'PRIVATE_QUERY', limit: 5 }), error => {
    check('timeout', 'headers')(error); assert.match(error.message, /search/); return true
  })
  assert.equal(calls(), 1)
})
test('timeouts while receiving JSON are classified instead of leaking a raw abort', async t => {
  const { remote, calls } = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('[') })
  await assert.rejects(remote.search({ text: 'PRIVATE_QUERY', limit: 5 }), check('timeout', 'body'))
  assert.equal(calls(), 1)
})
test('cancelled searches remain distinct from timeouts and never retry', async t => {
  const { remote, calls } = await fixture(t, () => {})
  await assert.rejects(remote.search({ text: 'PRIVATE_QUERY', limit: 5 }, AbortSignal.abort(new Error('PRIVATE_REASON'))), check('cancelled', 'headers'))
  assert.equal(calls(), 0)
})
test('HTTP failures retain their status and do not become timeouts', async t => {
  const { remote, calls } = await fixture(t, (_req, res) => res.writeHead(403).end('PRIVATE_UPSTREAM'))
  await assert.rejects(remote.search({ text: 'PRIVATE_QUERY', limit: 5 }), error => {
    assert.equal(error.status, 403); assert.equal(error.kind, undefined); assert.doesNotMatch(error.message, /PRIVATE_/); return true
  })
  assert.equal(calls(), 1)
})
test('write timeouts are reported as uncertain, with no automatic replay', async t => {
  const { remote, calls } = await fixture(t, req => req.resume())
  await assert.rejects(remote.updateSettings({ writebackPolicy: 'conservative' }), check('timeout', 'headers'))
  assert.equal(calls(), 1)
})
