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
  const tools = new Map()
  const settingsNamespaces = new Set()
  const runtime = {
    llm: { async *stream() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    settings: {
      register(namespace) {
        settingsNamespaces.add(namespace)
        return { get() { return {} }, watch() { return () => {} } }
      },
    },
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
    tools,
    settingsNamespaces,
    handler: () => controlHandler,
    async dispose() {
      for (const disposer of disposers.reverse()) await disposer?.()
    },
  }
}

test('plugin verifies, persists, hot-switches, and restores remote connections', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-activation-'))
  const token = 'valid_activation_token_longer_than_24_chars'
  const centralRequests = []
  const centralBases = []
  const central = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid token"}')
        return
      }
      const url = new URL(req.url, 'http://central.test')
      centralRequests.push([req.method, url.pathname])
      if (req.method === 'GET' && url.pathname === '/knowledge-api/v1/stats') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"entries":{"active":0,"archived":0},"candidates":{"pending":0,"approved":0,"rejected":0}}')
        return
      }
      if (req.method === 'GET' && url.pathname === '/knowledge-api/v1/knowledge-bases') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(centralBases))
        return
      }
      if (req.method === 'POST' && url.pathname === '/knowledge-api/v1/knowledge-bases') {
        const { draft } = await readJsonRequest(req)
        const timestamp = new Date().toISOString()
        const base = { ...draft, id: `remote-${centralBases.length + 1}`, status: 'active', createdAt: timestamp, updatedAt: timestamp }
        centralBases.push(base)
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(base))
        return
      }
      const match = /^\/knowledge-api\/v1\/knowledge-bases\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'PATCH' && match) {
        const id = decodeURIComponent(match[1])
        const index = centralBases.findIndex(base => base.id === id)
        if (index < 0) {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
          return
        }
        const { patch } = await readJsonRequest(req)
        centralBases[index] = { ...centralBases[index], ...patch, updatedAt: new Date().toISOString() }
        if (patch.writebackProvider === null || patch.writebackModel === null) {
          delete centralBases[index].writebackProvider
          delete centralBases[index].writebackModel
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(centralBases[index]))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
    })().catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }))
    })
  })
  const centralPort = await listen(central)
  const connectionPath = join(root, 'connection.json')
  const config = {
    backend: 'local', databasePath: join(root, 'knowledge.sqlite'), connectionPath,
    remoteTimeoutMs: 5000, exposeApi: false, apiPrefix: '/knowledge-api/v1', exposeWeb: false,
    webPath: '/knowledge', extractionEnabled: false, extractionMaxTokens: 1000,
    extractionTimeoutMs: 5000, extractionMaxInputChars: 10000, defaultScope: 'project',
  }
  const first = createRuntime()
  KnowledgePlugin.apply(first.runtime, config)
  assert.deepEqual([...first.settingsNamespaces], ['dsh-knowledge-connection'])
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

  const toolExec = {
    agent: { session: { id: 'remote-tool-session', header: {}, events: [] } },
    signal: new AbortController().signal,
  }
  const created = JSON.parse(await first.tools.get('knowledge_base_create').execute({
    name: 'Central tool base',
    description: 'Created through the currently active remote provider.',
    defaultTags: ['central'],
    writebackPolicy: 'proactive',
    writebackProvider: 'kimi',
    writebackModel: 'kimi-k2.7-code',
  }, toolExec))
  assert.equal(created.storage, 'remote')
  assert.equal(created.operation, 'created')
  assert.equal(created.mountsChanged, false)
  assert.equal(created.knowledgeBase.id, 'remote-1')
  assert.equal(created.knowledgeBase.writebackPolicy, 'proactive')
  assert.deepEqual([created.knowledgeBase.writebackProvider, created.knowledgeBase.writebackModel], ['kimi', 'kimi-k2.7-code'])

  const updated = JSON.parse(await first.tools.get('knowledge_base_update').execute({
    base: 'Central tool base',
    name: 'Updated central tool base',
    description: 'Updated only on the central service.',
    defaultTags: ['remote', 'managed'],
    useCurrentSessionModel: true,
  }, toolExec))
  assert.equal(updated.storage, 'remote')
  assert.equal(updated.operation, 'updated')
  assert.equal(updated.mountsChanged, false)
  assert.equal(updated.knowledgeBase.name, 'Updated central tool base')
  assert.deepEqual(updated.knowledgeBase.defaultTags, ['managed', 'remote'])
  assert.equal(updated.knowledgeBase.writebackProvider, undefined)
  assert.deepEqual(centralRequests.slice(-3), [
    ['POST', '/knowledge-api/v1/knowledge-bases'],
    ['GET', '/knowledge-api/v1/knowledge-bases'],
    ['PATCH', '/knowledge-api/v1/knowledge-bases/remote-1'],
  ])

  const localObserver = new KnowledgePlugin.LocalKnowledgeProvider(config.databasePath)
  assert.equal((await localObserver.listKnowledgeBases()).some(base => base.name === 'Central tool base'), false)
  await localObserver.close()

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

async function readJsonRequest(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
