import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  knowledgeBaseId: 'default',
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
    knowledgeBases: { total: 1, active: 1, archived: 0 },
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

test('approved entries are projected into browsable Markdown documents', async (t) => {
  const provider = await fixture(t)
  const readme = (await provider.listDocuments('default')).find(document => document.relPath === 'README.md')
  assert.ok(readme)
  assert.match(readme.content, /# 默认知识库/)
  assert.equal(readme.entryCount, 0)

  const entry = await provider.create(globalDraft)
  let documents = await provider.listDocuments('default')
  const procedures = documents.find(document => document.relPath === 'procedures.md')
  assert.ok(procedures)
  assert.equal(procedures.entryCount, 1)
  assert.match(procedures.content, /Production deployment policy/)
  assert.match(procedures.content, /#docker/)
  assert.equal((await provider.getDocument(procedures.id))?.contentHash, procedures.contentHash)
  assert.deepEqual((await provider.listDocuments('default', 'persistent volume')).map(document => document.id), [procedures.id])

  await provider.update(entry.id, { ...globalDraft, type: 'decision', body: 'Use Docker Compose for production deployments.' })
  documents = await provider.listDocuments('default')
  assert.equal(documents.some(document => document.relPath === 'procedures.md'), false)
  assert.match(documents.find(document => document.relPath === 'decisions.md')?.content || '', /Docker Compose/)

  await provider.archive(entry.id)
  documents = await provider.listDocuments('default')
  assert.deepEqual(documents.map(document => document.relPath), ['README.md'])
  assert.equal(documents[0]?.entryCount, 0)
})

test('knowledge bases mount by project and session with session overrides', async (t) => {
  const provider = await fixture(t)
  const base = await provider.createKnowledgeBase({
    name: '项目规范',
    description: '只存当前项目的稳定规范。',
    defaultTags: ['project-rule'],
    extractionInstructions: '只收录明确的项目约定。',
  })
  const patchedBase = await provider.patchKnowledgeBase(base.id, {
    description: '只匹配当前项目的工程规范。',
    defaultTags: ['project-rule', 'engineering'],
  })
  assert.equal(patchedBase.description, '只匹配当前项目的工程规范。')
  assert.deepEqual(patchedBase.defaultTags, ['engineering', 'project-rule'])
  await provider.create({
    ...globalDraft,
    knowledgeBaseId: base.id,
    title: 'Repository test command',
    body: 'Run npm test before pushing.',
    tags: ['project-rule', 'testing'],
  })
  const projectMount = await provider.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: base.id,
    enabled: true, recallEnabled: true, writeMode: 'audit',
    includeTags: ['project-rule'], excludeTags: [], extractionInstructions: '',
  })
  const inherited = await provider.resolveMounts('session-1', '/workspace/demo')
  assert.equal(inherited[0]?.inheritedFrom, 'project')
  assert.equal((await provider.search({ text: 'test command', knowledgeBaseIds: [base.id], includeTags: ['project-rule'], limit: 10 })).length, 1)
  await provider.upsertMount({
    ...projectMount,
    targetKind: 'session', targetId: 'session-1', enabled: true, recallEnabled: false, writeMode: 'direct',
  })
  const overridden = await provider.resolveMounts('session-1', '/workspace/demo')
  assert.equal(overridden[0]?.writeMode, 'direct')
  assert.equal(overridden[0]?.recallEnabled, false)
  assert.equal(overridden[0]?.inheritedFrom, undefined)

  await provider.upsertMount({
    ...projectMount,
    targetKind: 'session', targetId: 'session-1', enabled: false, recallEnabled: false, writeMode: 'none',
  })
  assert.deepEqual(await provider.resolveMounts('session-1', '/workspace/demo'), [])

  assert.equal((await provider.archiveKnowledgeBase(base.id)).status, 'archived')
  assert.equal((await provider.restoreKnowledgeBase(base.id)).status, 'active')
  assert.deepEqual(await provider.resolveMounts('another-session', '/workspace/demo'), [])
})

test('bulk mount changes commit atomically', async (t) => {
  const provider = await fixture(t)
  const base = await provider.createKnowledgeBase({
    name: 'Batch target', description: '', defaultTags: [], extractionInstructions: '',
  })
  const draft = {
    targetKind: 'project', targetId: '/workspace/batch', knowledgeBaseId: base.id,
    enabled: true, recallEnabled: true, writeMode: 'audit',
    includeTags: [], excludeTags: [], extractionInstructions: '',
  }
  await assert.rejects(
    () => provider.applyMountBatch({ upserts: [draft], deleteIds: ['missing-mount'] }),
    /was not found/,
  )
  assert.deepEqual(await provider.listMounts('project', '/workspace/batch'), [])
  const committed = await provider.applyMountBatch({ upserts: [draft], deleteIds: [] })
  assert.equal(committed.mounts.length, 1)
  assert.equal((await provider.listMounts('project', '/workspace/batch')).length, 1)
})

test('only archived non-default knowledge bases can be permanently deleted', async (t) => {
  const provider = await fixture(t)
  const base = await provider.createKnowledgeBase({
    name: 'Disposable base', description: '', defaultTags: [], extractionInstructions: '',
  })
  const entry = await provider.create({
    knowledgeBaseId: base.id, title: 'Disposable knowledge', body: 'Delete this with its knowledge base.',
    type: 'fact', tags: ['disposable'], scope: { kind: 'global' }, confidence: 0.9,
  })
  await provider.upsertMount({
    targetKind: 'project', targetId: '/workspace/disposable', knowledgeBaseId: base.id,
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  await provider.propose({
    action: 'update', targetId: entry.id,
    draft: { ...entry, body: 'Candidate content that must also be deleted.' },
    reason: 'Deletion test.',
  }, 'delete-base:1')

  await assert.rejects(() => provider.deleteKnowledgeBase(base.id), /must be archived/)
  await assert.rejects(() => provider.deleteKnowledgeBase('default'), /cannot be deleted/)
  await provider.archiveKnowledgeBase(base.id)
  await provider.deleteKnowledgeBase(base.id)

  assert.equal(await provider.getKnowledgeBase(base.id), undefined)
  assert.equal(await provider.get(entry.id), undefined)
  assert.deepEqual(await provider.listMounts(undefined, undefined), [])
  assert.deepEqual(await provider.listCandidates('pending', 10), [])
  assert.deepEqual(await provider.listDocuments(base.id), [])
})

test('schema v1 databases migrate existing entries into the default knowledge base', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-v1-'))
  const path = join(root, 'knowledge.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE knowledge_entries (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, type TEXT NOT NULL,
      tags_json TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT, confidence REAL NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL,
      source_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO knowledge_entries VALUES(
      'legacy-1','Legacy decision','Keep this after migration.','decision','["legacy"]',
      'global',NULL,0.9,'active',1,'legacy-hash',NULL,
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version = 1;
  `)
  legacy.close()
  const provider = new LocalKnowledgeProvider(path)
  t.after(async () => {
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const entries = await provider.list({ status: 'active', limit: 10 })
  assert.equal(entries.items[0]?.knowledgeBaseId, 'default')
  assert.equal((await provider.listKnowledgeBases())[0]?.id, 'default')
  const documents = await provider.listDocuments('default')
  assert.ok(documents.some(document => document.relPath === 'README.md'))
  assert.match(documents.find(document => document.relPath === 'decisions.md')?.content || '', /Legacy decision/)
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
  assert.equal(await provider.claimExtraction('session-1:1'), false)
  assert.equal(await provider.claimExtraction('session-retry:1'), true)
  await provider.failExtraction('session-retry:1', 'temporary failure')
  assert.equal(await provider.claimExtraction('session-retry:1'), true)
  assert.equal((await provider.extractionJob('session-retry:1'))?.attempts, 2)
  await provider.failExtraction('session-retry:1', 'temporary failure again')
  assert.equal(await provider.claimExtraction('session-retry:1'), true)
  assert.equal((await provider.extractionJob('session-retry:1'))?.attempts, 3)
  await provider.failExtraction('session-retry:1', 'permanent failure')
  assert.equal(await provider.claimExtraction('session-retry:1'), false)
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
