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

  assert.equal((await remote.getSettings()).writebackPolicy, 'conservative')
  assert.equal((await remote.updateSettings({ writebackPolicy: 'proactive' })).writebackPolicy, 'proactive')

  const entry = await remote.create({
    knowledgeBaseId: 'default',
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
  const documents = await remote.listDocuments('default', 'central knowledge')
  assert.equal(documents[0]?.relPath, 'decisions.md')
  assert.match((await remote.getDocument(documents[0].id))?.content || '', /Central knowledge service/)

  const base = await remote.createKnowledgeBase({
    name: 'Shared project knowledge', description: 'Mounted by remote clients.',
    defaultTags: ['shared'], extractionInstructions: 'Keep cross-client decisions.',
  })
  const patched = await remote.patchKnowledgeBase(base.id, {
    description: 'Only conversations about the shared project qualify.',
    defaultTags: ['shared', 'project'],
  })
  assert.equal(patched.description, 'Only conversations about the shared project qualify.')
  assert.deepEqual(patched.defaultTags, ['project', 'shared'])
  await remote.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: base.id,
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: ['shared'], excludeTags: [], extractionInstructions: '',
  })
  assert.equal((await remote.resolveMounts('remote-session', '/workspace/demo'))[0]?.knowledgeBaseId, base.id)
  assert.equal((await remote.archiveKnowledgeBase(base.id)).status, 'archived')
  assert.equal((await remote.restoreKnowledgeBase(base.id)).status, 'active')

  const candidate = await remote.propose({
    action: 'update',
    targetId: entry.id,
    draft: { ...entry, body: 'Other clients connect to the central knowledge API over authenticated HTTPS.' },
    reason: 'Clarifies authentication.',
  }, 'remote-session:1')
  await remote.review(candidate.id, { decision: 'approve' })
  assert.equal((await remote.get(entry.id))?.version, 2)
  const direct = await remote.writeDirect({
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', title: 'Central knowledge service',
      body: 'Other clients connect to the central knowledge API over authenticated HTTPS. Keep client tokens private.',
      type: 'decision', tags: ['remote', 'security'], scope: { kind: 'global' }, confidence: 0.96,
    },
    reason: 'Adds compatible security guidance.',
  }, 'remote-direct:1')
  assert.equal(direct.outcome, 'merged')
  assert.match((await remote.get(entry.id))?.body || '', /tokens private/)
  await assert.rejects(() => remote.deleteKnowledgeBase(base.id), /must be archived/)
  await remote.archiveKnowledgeBase(base.id)
  await remote.deleteKnowledgeBase(base.id)
  assert.equal(await remote.getKnowledgeBase(base.id), undefined)
})
