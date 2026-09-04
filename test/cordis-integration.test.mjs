import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as KnowledgePlugin from '../lib/index.js'

test('real Cordis context dynamically mounts API and Web routes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-cordis-'))
  const routes = []
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  class FakeLlm extends Service {
    constructor(inner) { super(inner, 'llm') }
    async *stream() {}
    listProviders() { return [{ id: 'mock', name: 'Mock' }] }
    async listModels() { return [{ id: 'model', name: 'Model' }] }
  }
  class FakeWebServer extends Service {
    constructor(inner) { super(inner, 'webServer') }
    register(route) {
      routes.push(route)
      return () => routes.splice(routes.indexOf(route), 1)
    }
  }
  class FakeTools extends Service {
    constructor(inner) { super(inner, 'tools') }
    register() { return () => {} }
  }
  class FakeSystemPrompt extends Service {
    constructor(inner) { super(inner, 'systemPrompt') }
  }
  await ctx.plugin(FakeLlm).await()
  await ctx.plugin(FakeTools).await()
  await ctx.plugin(FakeSystemPrompt).await()
  await ctx.plugin(FakeWebServer).await()
  await ctx.plugin(KnowledgePlugin, {
    backend: 'local', databasePath: join(root, 'knowledge.sqlite'), remoteTimeoutMs: 5000,
    exposeApi: true, apiToken: 'cordis_test_admin_token_longer_than_24_chars', apiPrefix: '/knowledge-api/v1',
    exposeWeb: true, webPath: '/knowledge', extractionEnabled: false, extractionMaxTokens: 1000,
    extractionTimeoutMs: 5000, extractionMaxInputChars: 10000, defaultScope: 'project',
  }).await()

  assert.deepEqual(routes.map(route => [route.kind, route.path]), [
    ['prefix', '/knowledge-control/v1/activity'],
    ['prefix', '/knowledge-local/v1'],
    ['prefix', '/knowledge'],
    ['prefix', '/knowledge-api/v1'],
    ['exact', '/knowledge-control/v1/connection'],
    ['exact', '/knowledge-control/v1/writeback-status'],
    ['exact', '/knowledge-control/v1/models'],
  ])

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === pathname)
    if (route === undefined) return res.writeHead(404).end()
    void route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const endpoint = path => `http://127.0.0.1:${port}${path}`
  const persisted = new KnowledgePlugin.LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  await persisted.claimExtraction('persisted-session:3')
  await persisted.completeExtraction('persisted-session:3', {
    outcome: 'completed', candidateCount: 1, directCount: 1, auditCount: 0,
    destinations: [{
      knowledgeBaseId: 'default', knowledgeBaseName: '默认知识库', documentId: 'doc-1',
      documentTitle: '刷新后仍可见', documentPath: '刷新后仍可见--doc1.md', disposition: 'written',
    }],
  })
  await persisted.close()
  assert.equal((await fetch(endpoint('/knowledge-control/v1/models'))).status, 401)
  assert.equal((await fetch(endpoint('/knowledge-control/v1/models'), {
    headers: { 'x-dsh-knowledge-client': 'management-web', 'sec-fetch-site': 'cross-site' },
  })).status, 403)
  const catalog = await fetch(endpoint('/knowledge-control/v1/models'), {
    headers: { 'x-dsh-knowledge-client': 'management-web' },
  })
  assert.equal(catalog.status, 200)
  assert.deepEqual((await catalog.json()).providers[0].models, [{ id: 'model', name: 'Model' }])
  assert.equal((await fetch(endpoint('/knowledge-control/v1/writeback-status?sessionId=s&turn=1'))).status, 401)
  assert.equal((await fetch(endpoint('/knowledge-control/v1/writeback-status?sessionId=s&turn=1'), {
    headers: { 'x-dsh-knowledge-client': 'conversation-web' },
  })).status, 404)
  const restored = await fetch(endpoint('/knowledge-control/v1/writeback-status?sessionId=persisted-session&turn=3'), {
    headers: { 'x-dsh-knowledge-client': 'conversation-web' },
  })
  assert.equal(restored.status, 200)
  assert.deepEqual((await restored.json()).destinations, [{
    knowledgeBaseId: 'default', knowledgeBaseName: '默认知识库', documentId: 'doc-1',
    documentTitle: '刷新后仍可见', documentPath: '刷新后仍可见--doc1.md', disposition: 'written',
  }])
})
