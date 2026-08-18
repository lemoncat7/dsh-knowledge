import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { registerRemoteManagementProxy } from '../lib/management-proxy.js'

test('remote management proxy keeps credentials server-side and exposes a synthetic service view', async (t) => {
  const token = 'remote_management_token_longer_than_24_chars'
  let receivedAuthorization = ''
  const central = createServer((req, res) => {
    receivedAuthorization = req.headers.authorization || ''
    const payload = JSON.stringify({ entries: { active: 3 }, path: req.url })
    res.writeHead(receivedAuthorization === `Bearer ${token}` ? 200 : 401, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  })
  await new Promise(resolve => central.listen(0, '127.0.0.1', resolve))
  const centralAddress = central.address()
  const remoteUrl = `http://127.0.0.1:${centralAddress.port}/knowledge-api/v1`

  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerRemoteManagementProxy(ctx, '/knowledge-local/v1', () => ({
    backend: 'remote', remoteUrl, remoteToken: token, remoteTimeoutMs: 5000,
  }))
  const proxy = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddress = proxy.address()
  const base = `http://127.0.0.1:${proxyAddress.port}/knowledge-local/v1`
  t.after(async () => {
    await new Promise(resolve => proxy.close(resolve))
    await new Promise(resolve => central.close(resolve))
  })

  assert.equal((await fetch(`${base}/stats`)).status, 401)
  const headers = { 'x-dsh-knowledge-client': 'management-web' }
  const service = await (await fetch(`${base}/service`, { headers })).json()
  assert.deepEqual(service, { publicApiEnabled: true, publicApiPrefix: remoteUrl, remote: true })
  const stats = await (await fetch(`${base}/stats`, { headers })).json()
  assert.equal(stats.entries.active, 3)
  assert.equal(stats.path, '/knowledge-api/v1/stats')
  assert.equal(receivedAuthorization, `Bearer ${token}`)
  assert.doesNotMatch(JSON.stringify(service), new RegExp(token))
})
