import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LOCAL_MANAGEMENT_API_PREFIX, registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('same-origin management API controls public access and deletes revoked tokens', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-management-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  let enabled = false
  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, {
    authMode: 'same-origin',
    service: {
      current: () => ({ publicApiEnabled: enabled, publicApiPrefix: '/knowledge-api/v1' }),
      async update(value) {
        enabled = value
        return { publicApiEnabled: enabled, publicApiPrefix: '/knowledge-api/v1' }
      },
    },
  })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}${LOCAL_MANAGEMENT_API_PREFIX}`
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal((await fetch(`${base}/service`)).status, 401)
  assert.equal((await fetch(`${base}/service`, {
    headers: { 'x-dsh-knowledge-client': 'management-web', 'sec-fetch-site': 'cross-site' },
  })).status, 403)

  const headers = { 'x-dsh-knowledge-client': 'management-web' }
  const initial = await (await fetch(`${base}/service`, { headers })).json()
  assert.deepEqual(initial, { publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' })
  const updated = await (await fetch(`${base}/service`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ publicApiEnabled: true }),
  })).json()
  assert.equal(updated.publicApiEnabled, true)

  const created = await (await fetch(`${base}/tokens`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test client', permissions: ['read'] }),
  })).json()
  const tokenId = created.record.id
  assert.equal((await fetch(`${base}/tokens/${tokenId}`, { method: 'DELETE', headers })).status, 204)
  assert.ok(provider.listApiTokens().find(token => token.id === tokenId)?.revokedAt)
  assert.equal((await fetch(`${base}/tokens/${tokenId}`, { method: 'DELETE', headers })).status, 204)
  assert.equal(provider.listApiTokens().some(token => token.id === tokenId), false)
})
