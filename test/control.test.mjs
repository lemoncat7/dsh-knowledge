import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { registerKnowledgeControl } from '../lib/control.js'

async function controlServer(options) {
  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerKnowledgeControl(ctx, options)
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/knowledge-control/v1/connection`,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}

function controlOptions(options = {}) {
  return { managementAvailable: false, ...options }
}

test('connection control never returns the stored token', async (t) => {
  const active = {
    backend: 'remote', remoteUrl: 'https://knowledge.example/api',
    remoteToken: 'secret_remote_token_longer_than_24_chars', remoteTimeoutMs: 5000,
  }
  const server = await controlServer(controlOptions({
    current: () => active, canSwitchRemote: true, writable: true,
    async update() { return active },
  }))
  t.after(server.close)

  const response = await fetch(server.url)
  const text = await response.text()
  const body = JSON.parse(text)
  assert.equal(response.status, 200)
  assert.equal(body.tokenConfigured, true)
  assert.equal(body.remoteToken, undefined)
  assert.doesNotMatch(text, /secret_remote_token/)
})

test('connection control rejects non-JSON and cross-site writes', async (t) => {
  let updates = 0
  const active = { backend: 'local', remoteTimeoutMs: 5000 }
  const server = await controlServer(controlOptions({
    current: () => active, canSwitchRemote: true, writable: true,
    async update() { updates += 1; return active },
  }))
  t.after(server.close)

  const nonJson = await fetch(server.url, { method: 'PUT', body: 'backend=local' })
  assert.equal(nonJson.status, 415)
  const crossSite = await fetch(server.url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ backend: 'local', remoteTimeoutMs: 5000 }),
  })
  assert.equal(crossSite.status, 403)
  assert.equal(updates, 0)
})

test('connection control returns only a verified update and surfaces validation errors', async (t) => {
  let active = { backend: 'local', remoteTimeoutMs: 5000 }
  let attempts = 0
  const server = await controlServer(controlOptions({
    current: () => active, canSwitchRemote: true, writable: true,
    async update(value) {
      attempts += 1
      if (value.remoteToken === 'invalid_remote_token_longer_than_24') {
        throw Object.assign(new Error('客户端令牌无效或已被撤销。'), { status: 400 })
      }
      active = { ...value, remoteToken: value.remoteToken }
      return active
    },
  }))
  t.after(server.close)

  const invalid = await fetch(server.url, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backend: 'remote', remoteUrl: 'https://knowledge.example/api',
      remoteToken: 'invalid_remote_token_longer_than_24', remoteTimeoutMs: 5000,
    }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(active.backend, 'local')

  const valid = await fetch(server.url, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backend: 'remote', remoteUrl: 'https://knowledge.example/api',
      remoteToken: 'valid_remote_client_token_longer_than_24', remoteTimeoutMs: 5000,
    }),
  })
  const body = await valid.json()
  assert.equal(valid.status, 200)
  assert.equal(body.backend, 'remote')
  assert.equal(body.tokenConfigured, true)
  assert.equal(body.remoteToken, undefined)
  assert.equal(attempts, 2)
})

test('central knowledge servers expose the entry but reject remote mode', async (t) => {
  let updates = 0
  const active = { backend: 'local', remoteTimeoutMs: 5000 }
  const server = await controlServer(controlOptions({
    current: () => active, canSwitchRemote: false, writable: true,
    async update() { updates += 1; return active },
  }))
  t.after(server.close)

  const view = await (await fetch(server.url)).json()
  assert.equal(view.canSwitchRemote, false)
  const response = await fetch(server.url, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backend: 'remote', remoteUrl: 'https://knowledge.example/api',
      remoteToken: 'valid_remote_client_token_longer_than_24', remoteTimeoutMs: 5000,
    }),
  })
  assert.equal(response.status, 409)
  assert.equal(updates, 0)
})

test('connection control reports management availability without leaking a disabled path', async (t) => {
  const active = { backend: 'local', remoteTimeoutMs: 5000 }
  const disabled = await controlServer(controlOptions({
    current: () => active, canSwitchRemote: true, writable: true,
    managementPath: '/knowledge',
    async update() { return active },
  }))
  t.after(disabled.close)
  const disabledView = await (await fetch(disabled.url)).json()
  assert.equal(disabledView.managementAvailable, false)
  assert.equal(disabledView.managementPath, undefined)

  const enabled = await controlServer(controlOptions({
    current: () => active, canSwitchRemote: false, writable: true,
    managementAvailable: true, managementPath: '/custom-knowledge',
    async update() { return active },
  }))
  t.after(enabled.close)
  const enabledView = await (await fetch(enabled.url)).json()
  assert.equal(enabledView.managementAvailable, true)
  assert.equal(enabledView.managementPath, '/custom-knowledge')
})

test('connection control keeps the embedded management entry available in remote mode', async (t) => {
  const active = {
    backend: 'remote', remoteUrl: 'https://knowledge.example/api',
    remoteToken: 'remote_client_token_longer_than_24_chars', remoteTimeoutMs: 5000,
  }
  const server = await controlServer(controlOptions({
    current: () => active, canSwitchRemote: true, writable: true,
    managementAvailable: () => true, managementPath: '/knowledge',
    async update() { return active },
  }))
  t.after(server.close)
  const view = await (await fetch(server.url)).json()
  assert.equal(view.managementAvailable, true)
  assert.equal(view.managementPath, '/knowledge')
})
