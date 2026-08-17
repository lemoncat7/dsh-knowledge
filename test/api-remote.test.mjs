import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'

test('remote provider interoperates with the authenticated local API', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-api-'))
  const local = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const token = 'remote_test_token_longer_than_24_chars'
  local.ensureBootstrapToken(token)
  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerKnowledgeApi(ctx, local, '/knowledge-api/v1')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const remote = new RemoteKnowledgeProvider({
    url: `http://127.0.0.1:${address.port}/knowledge-api/v1`,
    token,
    timeoutMs: 5000,
  })
  t.after(async () => {
    await remote.close()
    await new Promise(resolve => server.close(resolve))
    await local.close()
    await rm(root, { recursive: true, force: true })
  })

  const entry = await remote.create({
    title: 'Central knowledge service',
    body: 'Other clients connect to the central knowledge API over HTTPS.',
    type: 'decision',
    tags: ['remote'],
    scope: { kind: 'global' },
    confidence: 0.9,
  })
  assert.equal((await remote.get(entry.id))?.title, 'Central knowledge service')
  assert.equal((await remote.search({ text: 'central knowledge', limit: 5 })).length, 1)
  assert.equal((await remote.stats()).entries.active, 1)

  const candidate = await remote.propose({
    action: 'update',
    targetId: entry.id,
    draft: { ...entry, body: 'Other clients connect to the central knowledge API over authenticated HTTPS.' },
    reason: 'Clarifies authentication.',
  }, 'remote-session:1')
  await remote.review(candidate.id, { decision: 'approve' })
  assert.equal((await remote.get(entry.id))?.version, 2)
})
