import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { registerWritebackControl } from '../lib/writeback/control.js'
import { WritebackQueue } from '../lib/writeback/queue.js'

test('outbox control validates same-origin client, pagination and actions without exposing snapshots', async t => {
  const queue = new WritebackQueue(':memory:', async () => { throw new Error('not configured') })
  let route
  registerWritebackControl({ webServer: { register(value) { route = value; return () => {} } } }, queue)
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await queue.close() })
  const url = `http://127.0.0.1:${server.address().port}/knowledge-control/v1/writeback-jobs`
  const headers = { 'x-dsh-knowledge-client': 'management-web' }
  queue.enqueue({ destination: 'remote:https://secret-token@example.invalid', snapshot: { sourceKey: 's:1', sessionId: 's', turn: 1, userText: 'private conversation', assistantText: 'private answer', userTextTruncated: false } })
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://untrusted.invalid' } })).status, 403)
  assert.equal((await fetch(`${url}?offset=-1`, { headers })).status, 400)
  const listed = await (await fetch(url, { headers })).json()
  assert.equal(listed.total, 1)
  assert.doesNotMatch(JSON.stringify(listed), /private conversation|private answer|secret-token/)
  assert.equal((await fetch(`${url}?action=delete&sourceKey=s:1`, { method: 'POST', headers })).status, 400)
  assert.equal((await fetch(`${url}?action=cancel&sourceKey=missing`, { method: 'POST', headers })).status, 404)
  const cancelled = await (await fetch(`${url}?action=cancel&sourceKey=s:1`, { method: 'POST', headers })).json()
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await (await fetch(`${url}?action=retry&sourceKey=s:1`, { method: 'POST', headers })).json()).status, 'cancelled')
})
