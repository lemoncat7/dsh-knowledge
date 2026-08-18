import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as KnowledgePlugin from '../lib/index.js'

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolve => {
    server.closeAllConnections()
    server.close(resolve)
  })
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function createRuntime() {
  let controlHandler
  const disposers = []
  const runtime = {
    llm: { async *stream() {} },
    tools: { register() { return () => {} } },
    webServer: {
      register(route) {
        if (route.path === '/knowledge-control/v1/connection') controlHandler = route.handler
        return () => {}
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on() { return () => {} },
    effect(factory) { disposers.push(factory()) },
    inject(_services, callback) { callback(runtime) },
    get(name) { return name === 'webServer' ? runtime.webServer : undefined },
  }
  return {
    runtime,
    handler: () => controlHandler,
    async dispose() {
      for (const disposer of disposers.reverse()) await disposer?.()
    },
  }
}

test('plugin verifies, persists, hot-switches, and restores remote connections', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-activation-'))
  const token = 'valid_activation_token_longer_than_24_chars'
  const central = createServer((req, res) => {
    if (req.url !== '/knowledge-api/v1/stats') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid token"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"entries":{"active":0,"archived":0},"candidates":{"pending":0,"approved":0,"rejected":0}}')
  })
  const centralPort = await listen(central)
  const connectionPath = join(root, 'connection.json')
  const config = {
    backend: 'local', databasePath: join(root, 'knowledge.sqlite'), connectionPath,
    remoteTimeoutMs: 5000, exposeApi: false, apiPrefix: '/knowledge-api/v1', exposeWeb: false,
    webPath: '/knowledge', extractionEnabled: false, extractionMaxTokens: 1000,
    extractionTimeoutMs: 5000, extractionMaxInputChars: 10000, defaultScope: 'project',
    autoRecallLimit: 5, recallMaxChars: 6000,
  }
  const first = createRuntime()
  KnowledgePlugin.apply(first.runtime, config)
  const control = createServer((req, res) => void first.handler()(req, res))
  const controlPort = await listen(control)
  const controlUrl = `http://127.0.0.1:${controlPort}/knowledge-control/v1/connection`
  t.after(async () => {
    await closeServer(control)
    await first.dispose()
    await closeServer(central)
    await rm(root, { recursive: true, force: true })
  })

  const invalid = await fetch(controlUrl, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backend: 'remote', remoteUrl: `http://127.0.0.1:${centralPort}/knowledge-api/v1`,
      remoteToken: 'invalid_activation_token_longer_than_24', remoteTimeoutMs: 5000,
    }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await (await fetch(controlUrl)).json()).backend, 'local')

  const valid = await fetch(controlUrl, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backend: 'remote', remoteUrl: `http://127.0.0.1:${centralPort}/knowledge-api/v1`,
      remoteToken: token, remoteTimeoutMs: 5000,
    }),
  })
  const view = await valid.json()
  assert.equal(valid.status, 200)
  assert.equal(view.backend, 'remote')
  assert.equal(view.tokenConfigured, true)
  assert.equal(view.remoteToken, undefined)
  assert.equal(JSON.parse(await readFile(connectionPath, 'utf8')).remoteToken, token)

  await closeServer(control)
  await first.dispose()
  const restarted = createRuntime()
  KnowledgePlugin.apply(restarted.runtime, config)
  const restartedControl = createServer((req, res) => void restarted.handler()(req, res))
  const restartedPort = await listen(restartedControl)
  const restored = await (await fetch(`http://127.0.0.1:${restartedPort}/knowledge-control/v1/connection`)).json()
  assert.equal(restored.backend, 'remote')
  assert.equal(restored.tokenConfigured, true)
  await closeServer(restartedControl)
  await restarted.dispose()
})
