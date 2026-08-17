import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => {
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  return provider
}

const globalDraft = {
  title: 'Production deployment policy',
  body: 'Deploy the web service with Docker Compose and retain its persistent volume.',
  type: 'procedure',
  tags: ['Docker', 'deployment'],
  scope: { kind: 'global' },
  confidence: 0.92,
}

test('local provider preserves versions and searches approved scoped knowledge', async (t) => {
  const provider = await fixture(t)
  const global = await provider.create(globalDraft)
  const project = await provider.create({
    ...globalDraft,
    title: 'Project deployment port',
    body: 'This project exposes its service on port 3080.',
    scope: { kind: 'project', id: '/workspace/demo' },
  })

  const projectHits = await provider.search({ text: 'deployment port', projectId: '/workspace/demo', limit: 10 })
  assert.equal(projectHits[0]?.entry.id, project.id)
  const globalHits = await provider.search({ text: 'persistent volume', limit: 10 })
  assert.deepEqual(globalHits.map(hit => hit.entry.id), [global.id])
  const chinese = await provider.create({
    title: '插件安装方式',
    body: '通过配置文件安装知识库插件，并使用 Docker 重新启动服务。',
    type: 'procedure',
    tags: ['插件'],
    scope: { kind: 'global' },
    confidence: 0.9,
  })
  const chineseHits = await provider.search({ text: '怎样安装这个插件', limit: 10 })
  assert.ok(chineseHits.some(hit => hit.entry.id === chinese.id))

  const updated = await provider.update(global.id, { ...globalDraft, body: `${globalDraft.body} Back up the volume first.` })
  assert.equal(updated.version, 2)
  assert.equal((await provider.versions(global.id)).length, 2)
  await provider.archive(global.id)
  assert.equal((await provider.search({ text: 'persistent volume', limit: 10 })).length, 0)
  assert.deepEqual(await provider.stats(), {
    entries: {
      total: 3,
      active: 2,
      archived: 1,
      byType: { preference: 0, fact: 0, decision: 0, procedure: 3, lesson: 0 },
    },
    candidates: { total: 0, pending: 0, approved: 0, rejected: 0 },
    extractionJobs: { total: 0, running: 0, completed: 0, failed: 0 },
  })
})

test('candidate approval is transactional and extraction claims are idempotent', async (t) => {
  const provider = await fixture(t)
  const candidate = await provider.propose({
    action: 'create',
    draft: globalDraft,
    reason: 'Reusable deployment procedure.',
  }, 'session-1:1')
  assert.equal(candidate.status, 'pending')
  const duplicate = await provider.propose({
    action: 'create',
    draft: globalDraft,
    reason: 'Same proposal with another explanation.',
  }, 'session-1:1')
  assert.equal(duplicate.id, candidate.id)

  const approved = await provider.review(candidate.id, { decision: 'approve', note: 'Verified.' })
  assert.equal(approved.status, 'approved')
  assert.equal((await provider.list({ status: 'active', limit: 10 })).items.length, 1)
  await assert.rejects(() => provider.review(candidate.id, { decision: 'approve' }), /already approved/)

  assert.equal(await provider.claimExtraction('session-1:1'), true)
  assert.equal(await provider.claimExtraction('session-1:1'), false)
  await provider.completeExtraction('session-1:1', 1)
  assert.equal((await provider.extractionJob('session-1:1'))?.status, 'completed')
  const stats = await provider.stats()
  assert.equal(stats.entries.active, 1)
  assert.equal(stats.candidates.approved, 1)
  assert.equal(stats.extractionJobs.completed, 1)
})

test('API tokens are hashed, permissioned, and revocable', async (t) => {
  const provider = await fixture(t)
  const bootstrap = 'bootstrap_token_longer_than_24_chars'
  provider.ensureBootstrapToken(bootstrap)
  const actor = provider.authenticate(bootstrap)
  assert.ok(actor?.permissions.includes('admin'))
  const created = provider.createApiToken('laptop', ['read', 'propose'])
  assert.ok(created.token.startsWith('dshk_'))
  assert.deepEqual(provider.authenticate(created.token)?.permissions, ['read', 'propose'])
  provider.revokeApiToken(created.record.id)
  assert.equal(provider.authenticate(created.token), undefined)
})
