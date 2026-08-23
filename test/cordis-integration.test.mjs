import assert from 'node:assert/strict'
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
    ['prefix', '/knowledge-local/v1'],
    ['prefix', '/knowledge'],
    ['prefix', '/knowledge-api/v1'],
    ['exact', '/knowledge-control/v1/connection'],
  ])
})
