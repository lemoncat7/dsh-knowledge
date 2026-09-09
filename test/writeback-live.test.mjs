import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { registerWritebackLive } from '../lib/writeback/live-control.js'
import { WritebackQueue } from '../lib/writeback/queue.js'

test('change channel validates origin, signals queue mutation and terminates on disposal', async t => {
  const queue = new WritebackQueue(':memory:', async () => ({ status: 'completed', summary: 'done', retryable: false }))
  let route
  const dispose = registerWritebackLive({ webServer: { register(value) { route = value; return () => {} } } }, queue)
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await queue.close() })
  const url = `http://127.0.0.1:${server.address().port}/knowledge-control/v1/writeback-changes`
  const headers = { 'x-dsh-knowledge-client': 'conversation-web' }
  assert.equal((await fetch(url)).status, 403)
  assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://foreign.invalid' } })).status, 403)
  const initial = await (await fetch(url, { headers })).json()
  const pending = fetch(`${url}?since=${encodeURIComponent(initial.revision)}`, { headers, signal: AbortSignal.timeout(1500) })
  await new Promise(resolve => setTimeout(resolve, 30))
  queue.completeEmpty('s:1', 's')
  const next = await (await pending).json()
  assert.notEqual(next.revision, initial.revision)
  const stopping = fetch(`${url}?since=${encodeURIComponent(next.revision)}`, { headers, signal: AbortSignal.timeout(1500) })
  await new Promise(resolve => setTimeout(resolve, 30))
  dispose()
  assert.equal((await stopping).status, 503)
})
