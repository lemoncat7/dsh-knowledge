import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { contentHash } from '../lib/domain.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  provider.fixtureRoot = root
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
  assert.equal((await provider.getSettings()).writebackPolicy, 'conservative')
  assert.equal((await provider.updateSettings({ writebackPolicy: 'proactive' })).writebackPolicy, 'proactive')
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

test('separate local provider instances serialize their shared Markdown projection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-shared-projection-'))
  const path = join(root, 'knowledge.sqlite')
  const first = new LocalKnowledgeProvider(path)
  const second = new LocalKnowledgeProvider(path)
  t.after(async () => {
    await Promise.all([first.close(), second.close()])
    await rm(root, { recursive: true, force: true })
  })

  const [left, right] = await Promise.all([
    first.create({ ...globalDraft, title: 'Shared projection left', body: 'The left provider writes this document.' }),
    second.create({ ...globalDraft, title: 'Shared projection right', body: 'The right provider writes this document.' }),
  ])
  const documents = await first.listDocuments('default')
  assert.deepEqual(new Set(documents.map(document => document.id)), new Set([left.id, right.id]))
  assert.match((await second.getDocument(left.id))?.content || '', /left provider/)
  assert.match((await first.getDocument(right.id))?.content || '', /right provider/)
})

test('in-memory providers keep projections in disposable temporary storage', async () => {
  const provider = new LocalKnowledgeProvider(':memory:')
  const root = provider.documentStore.root
  assert.equal(root.startsWith(tmpdir()), true)
  assert.equal(root.startsWith(process.cwd()), false)
  await provider.create(globalDraft)
  await access(root)
  await provider.close()
  await assert.rejects(() => access(root), error => error?.code === 'ENOENT')
})

test('document index paginates metadata without returning document bodies', async (t) => {
  const provider = await fixture(t)
  assert.ok(provider.db.prepare("PRAGMA index_list('knowledge_documents')").all()
    .some(index => index.name === 'knowledge_documents_index_order'))
  const created = []
  for (const [title, body] of [
    ['Alpha runbook', 'alpha deployment details'],
    ['Beta runbook', 'beta deployment details'],
    ['Gamma runbook', 'gamma searchable body marker'],
  ]) created.push(await provider.create({ ...globalDraft, title, body }))

  const first = await provider.listDocumentIndex({ knowledgeBaseIds: ['default'], limit: 2 })
  assert.equal(first.items.length, 2)
  assert.equal(first.total, 3)
  assert.ok(first.nextCursor)
  assert.equal(Object.hasOwn(first.items[0], 'content'), false)

  const second = await provider.listDocumentIndex({ knowledgeBaseIds: ['default'], limit: 2, cursor: first.nextCursor })
  assert.equal(second.items.length, 1)
  assert.equal(second.nextCursor, undefined)
  assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set(created.map(item => item.id)))

  const searched = await provider.listDocumentIndex({ knowledgeBaseIds: ['default'], query: 'searchable body marker', limit: 10 })
  assert.deepEqual(searched.items.map(item => item.title), ['Gamma runbook'])
  await assert.rejects(
    () => provider.listDocumentIndex({ knowledgeBaseIds: ['default'], cursor: 'not-a-cursor', limit: 10 }),
    /invalid document pagination cursor/,
  )
})

test('entry and knowledge-base updates do not rewrite an entire Markdown projection', async (t) => {
  const provider = await fixture(t)
  const entries = []
  for (let index = 0; index < 12; index += 1) {
    entries.push(await provider.create({
      ...globalDraft,
      title: `Projection performance ${index}`,
      body: `Stable document ${index}.`,
    }))
  }

  const originalWrite = provider.documentStore.writeDocument.bind(provider.documentStore)
  let writes = 0
  provider.documentStore.writeDocument = async (...args) => {
    writes += 1
    return originalWrite(...args)
  }

  const target = entries[5]
  await provider.update(target.id, { ...target, body: 'Only this projected document should be rewritten.' })
  assert.equal(writes, 1)

  writes = 0
  const base = await provider.getKnowledgeBase('default')
  await provider.updateKnowledgeBase(base.id, { ...base, description: 'Manifest-only metadata change.' })
  assert.equal(writes, 0)
})

test('archived documents cannot be silently restored by editing or candidate approval', async (t) => {
  const provider = await fixture(t)
  const entry = await provider.create({
    ...globalDraft,
    title: 'Archived deployment policy',
  })
  const candidate = await provider.propose({
    action: 'conflict',
    targetId: entry.id,
    draft: { ...entry, body: 'Use a different archived deployment policy.' },
    reason: 'Requires review.',
  }, 'archived-review:1')
  await provider.archive(entry.id)

  await assert.rejects(
    () => provider.update(entry.id, { ...entry, body: 'Editing must not restore this document.' }),
    /is archived and cannot be edited/,
  )
  await assert.rejects(
    () => provider.review(candidate.id, { decision: 'approve', resolution: 'merge' }),
    /active knowledge entry/,
  )
  assert.equal((await provider.get(entry.id))?.status, 'archived')
  assert.equal((await provider.listCandidates('pending', 10))[0]?.id, candidate.id)
})

test('direct writes merge compatible knowledge, skip duplicates, and hold conflicts for review', async (t) => {
  const provider = await fixture(t)
  const existing = await provider.create({
    knowledgeBaseId: 'default', title: 'Service port policy', body: 'Use port 8080 for the service.',
    type: 'procedure', tags: ['service'], scope: { kind: 'global' }, confidence: 0.92,
  })
  const merged = await provider.writeDirect({
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', title: 'Service port policy',
      body: 'Use port 8080 for the service. Keep the port documented in Docker Compose.',
      type: 'procedure', tags: ['docker'], scope: { kind: 'global' }, confidence: 0.96,
    },
    reason: 'Adds compatible deployment context.',
  }, 'direct-merge:1')
  assert.equal(merged.outcome, 'merged')
  assert.equal(merged.entry?.id, existing.id)
  assert.equal(merged.entry?.version, 2)
  assert.deepEqual(merged.entry?.tags, ['docker', 'service'])
  assert.match(merged.entry?.body || '', /Docker Compose/)

  const duplicate = await provider.writeDirect({
    action: 'create', draft: { ...merged.entry }, reason: 'Same durable content.',
  }, 'direct-duplicate:1')
  assert.equal(duplicate.outcome, 'duplicate')
  assert.equal((await provider.get(existing.id))?.version, 2)

  const conflict = await provider.writeDirect({
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', title: 'Service port policy', body: 'Use port 9090 for the service.',
      type: 'procedure', tags: ['service'], scope: { kind: 'global' }, confidence: 0.98,
    },
    reason: 'Contradictory port value.',
  }, 'direct-conflict:1')
  assert.equal(conflict.outcome, 'conflict')
  assert.equal(conflict.candidate?.action, 'conflict')
  assert.equal(conflict.candidate?.status, 'pending')
  assert.equal((await provider.get(existing.id))?.version, 2)

  await assert.rejects(
    () => provider.writeDirect({
      action: 'update', targetId: existing.id,
      draft: {
        knowledgeBaseId: 'another-base', title: 'Service port policy',
        body: 'Move this entry to another knowledge base.', type: 'procedure', tags: ['service'],
        scope: { kind: 'global' }, confidence: 0.99,
      },
      reason: 'Invalid cross-base update.',
    }, 'direct-cross-base:1'),
    /cannot move knowledge between knowledge bases/,
  )
  assert.equal((await provider.listCandidates('pending', 10)).length, 1)
  assert.equal((await provider.get(existing.id))?.knowledgeBaseId, 'default')

  const created = await provider.writeDirect({
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', title: 'Backup policy', body: 'Back up the volume before deployment.',
      type: 'procedure', tags: ['backup'], scope: { kind: 'global' }, confidence: 0.95,
    },
    reason: 'Independent durable procedure.',
  }, 'direct-create:1')
  assert.equal(created.outcome, 'created')
  assert.equal(created.candidate?.status, 'approved')
  assert.equal((await provider.list({ status: 'active', limit: 10 })).items.length, 2)
})

test('explicit revisions replace obsolete knowledge instead of appending contradictory text', async (t) => {
  const provider = await fixture(t)
  const existing = await provider.create({
    knowledgeBaseId: 'default', title: 'Release policy',
    body: '## Current version\n\nThe supported release is 1.2.\n\n## Installation\n\nUse the stable channel.',
    type: 'procedure', tags: ['release'], scope: { kind: 'global' }, confidence: .94,
  })
  const result = await provider.writeDirect({
    action: 'update', targetId: existing.id,
    change: {
      kind: 'revise', baseVersion: existing.version, baseHash: contentHash(existing),
      edits: [{ oldText: 'The supported release is 1.2.', newText: 'The supported release is 1.3.' }],
    },
    draft: {
      ...existing,
      body: 'This untrusted preview is intentionally ignored by the provider.',
      confidence: .98,
      source: { evidence: 'verified' },
    },
    reason: 'The verified supported release changed.',
  }, 'direct-revision:1')

  assert.equal(result.outcome, 'merged')
  assert.match(result.entry?.body || '', /supported release is 1\.3/)
  assert.doesNotMatch(result.entry?.body || '', /supported release is 1\.2/)
  assert.match(result.entry?.body || '', /Use the stable channel/)
  assert.doesNotMatch(result.entry?.body || '', /untrusted preview/)
})

test('revisions rebase over unrelated additions and surface overlapping edits as real conflicts', async (t) => {
  const provider = await fixture(t)
  const existing = await provider.create({
    knowledgeBaseId: 'default', title: 'Runtime status',
    body: '## Version\n\nCurrent version: 1.0.\n\n## Platform\n\nRuns on macOS.',
    type: 'fact', tags: ['runtime'], scope: { kind: 'global' }, confidence: .93,
  })
  const rebased = await provider.propose({
    action: 'update', targetId: existing.id,
    change: {
      kind: 'revise', baseVersion: existing.version, baseHash: contentHash(existing),
      edits: [{ oldText: 'Runs on macOS.', newText: 'Runs on macOS and Linux.' }],
    },
    draft: { ...existing, body: 'preview', confidence: .96 },
    reason: 'Platform support expanded.',
  }, 'revision-rebase:1')
  await provider.writeDirect({
    action: 'update', targetId: existing.id, change: { kind: 'append' },
    draft: { ...existing, body: '## Verification\n\nSmoke tests passed.', confidence: .97 },
    reason: 'Adds an independent verification section.',
  }, 'revision-rebase:2')
  await provider.review(rebased.id, { decision: 'approve' })
  const afterRebase = await provider.get(existing.id)
  assert.match(afterRebase?.body || '', /macOS and Linux/)
  assert.match(afterRebase?.body || '', /Smoke tests passed/)

  const current = afterRebase
  assert.ok(current)
  const overlapping = await provider.propose({
    action: 'update', targetId: current.id,
    change: {
      kind: 'revise', baseVersion: current.version, baseHash: contentHash(current),
      edits: [{ oldText: 'Current version: 1.0.', newText: 'Current version: 1.1.' }],
    },
    draft: { ...current, body: 'preview', confidence: .98 },
    reason: 'Candidate update.',
  }, 'revision-overlap:1')
  await provider.writeDirect({
    action: 'update', targetId: current.id,
    change: {
      kind: 'revise', baseVersion: current.version, baseHash: contentHash(current),
      edits: [{ oldText: 'Current version: 1.0.', newText: 'Current version: 2.0.' }],
    },
    draft: { ...current, body: 'preview', confidence: .99, source: { evidence: 'verified' } },
    reason: 'A newer verified update won the race.',
  }, 'revision-overlap:2')

  const changed = await provider.review(overlapping.id, { decision: 'approve' })
  assert.equal(changed.status, 'pending')
  assert.equal(changed.action, 'conflict')
  await assert.rejects(
    () => provider.review(overlapping.id, { decision: 'approve', resolution: 'merge' }),
    /no longer matches.*edit the current document/i,
  )
  const latest = await provider.get(current.id)
  assert.ok(latest)
  await provider.review(overlapping.id, {
    decision: 'approve', resolution: 'merge', expectedVersion: latest.version,
    draft: { ...latest, body: latest.body.replace('Current version: 2.0.', 'Current version: 2.1.') },
  })
  assert.match((await provider.get(current.id))?.body || '', /Current version: 2\.1/)
  assert.doesNotMatch((await provider.get(current.id))?.body || '', /Current version: 2\.0/)
})

test('document type drift does not turn a compatible append into a conflict', async (t) => {
  const provider = await fixture(t)
  const existing = await provider.create({
    knowledgeBaseId: 'default', title: '安卓代理客户端偏好',
    body: '## 偏好\n\n单一 SOCKS5 节点优先选择配置简单的客户端。',
    type: 'preference', tags: ['安卓', '代理'], scope: { kind: 'global' }, confidence: 0.91,
  })
  const result = await provider.writeDirect({
    action: 'update', targetId: existing.id,
    draft: {
      knowledgeBaseId: 'default', title: '安卓代理客户端偏好',
      body: '## 排障\n\n手机不能使用 127.0.0.1 连接电脑上的代理服务。',
      type: 'lesson', tags: ['排障'], scope: { kind: 'global' }, confidence: 0.92,
    },
    reason: '追加同一主题的排障经验。',
  }, 'type-drift-append:1')

  assert.equal(result.outcome, 'merged')
  assert.equal(result.candidate?.action, 'update')
  assert.equal(result.entry?.type, 'preference')
  assert.match(result.entry?.body || '', /单一 SOCKS5/)
  assert.match(result.entry?.body || '', /不能使用 127\.0\.0\.1/)
  assert.equal((await provider.listCandidates('pending', 10)).length, 0)
})

test('direct writes merge the same GitHub repository despite different document titles', async (t) => {
  const provider = await fixture(t)
  const existing = await provider.create({
    knowledgeBaseId: 'default', title: 'example/repository 项目资料',
    body: '## 仓库\n\nhttps://github.com/example/repository',
    type: 'fact', tags: ['github'], scope: { kind: 'global' }, confidence: .92,
  })
  const result = await provider.writeDirect({
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', title: 'example/repository 维护状态',
      body: '## 维护状态\n\nhttps://github.com/example/repository/ 最近仍有提交和稳定发布。',
      type: 'fact', tags: ['维护状态'], scope: { kind: 'global' }, confidence: .95,
    },
    reason: '补充同一仓库的维护状态。',
  }, 'github-reference-merge:1')

  assert.equal(result.outcome, 'merged')
  assert.equal(result.entry?.id, existing.id)
  assert.equal((await provider.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })).items.length, 1)
  assert.match(result.entry?.body || '', /## 仓库/)
  assert.match(result.entry?.body || '', /## 维护状态/)
})

test('audit approval merges a same-topic candidate into its document', async (t) => {
  const provider = await fixture(t)
  const existing = await provider.create({
    knowledgeBaseId: 'default', title: 'example/repository',
    body: '## 仓库\n\nhttps://github.com/example/repository',
    type: 'fact', tags: ['github'], scope: { kind: 'global' }, confidence: 0.91,
  })
  const candidate = await provider.propose({
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', title: 'example/repository',
      body: '## 维护状态\n\n最近仍有稳定发布。',
      type: 'fact', tags: ['维护状态'], scope: { kind: 'global' }, confidence: 0.94,
    },
    reason: '补充同一仓库的维护状态。',
  }, 'audit-document-merge:1')

  await provider.review(candidate.id, { decision: 'approve' })

  const entries = (await provider.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })).items
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, existing.id)
  assert.equal(entries[0].version, 2)
  assert.match(entries[0].body, /## 仓库/)
  assert.match(entries[0].body, /## 维护状态/)
  assert.equal((await provider.listDocuments('default')).length, 1)

  const conflictCandidate = await provider.propose({
    action: 'conflict', targetId: existing.id,
    draft: {
      knowledgeBaseId: 'default', title: 'example/repository',
      body: '## 兼容性风险\n\n新版需要重新验证旧版配置。',
      type: 'fact', tags: ['风险'], scope: { kind: 'global' }, confidence: 0.97,
    },
    reason: '新增内容可能改变原有兼容性结论。',
  }, 'audit-document-conflict:1')
  await assert.rejects(
    () => provider.review(conflictCandidate.id, { decision: 'approve' }),
    /explicit merge resolution/,
  )
  await provider.review(conflictCandidate.id, { decision: 'approve', resolution: 'merge' })
  const resolved = await provider.get(existing.id)
  assert.equal(resolved?.version, 3)
  assert.match(resolved?.body || '', /## 仓库/)
  assert.match(resolved?.body || '', /## 维护状态/)
  assert.match(resolved?.body || '', /## 兼容性风险/)
  assert.equal((await provider.listDocuments('default')).length, 1)

  const database = new DatabaseSync(join(provider.fixtureRoot, 'knowledge.sqlite'), { readOnly: true })
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE id=?').get(existing.id).count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM knowledge_versions WHERE knowledge_id=?').get(existing.id).count, 3)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM knowledge_fts WHERE knowledge_id=?').get(existing.id).count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM knowledge_documents WHERE id=?').get(existing.id).count, 1)
    assert.match(database.prepare('SELECT body FROM knowledge_entries WHERE id=?').get(existing.id).body, /兼容性风险/)
  } finally {
    database.close()
  }

  await provider.close()
  const reopened = new LocalKnowledgeProvider(join(provider.fixtureRoot, 'knowledge.sqlite'))
  t.after(() => reopened.close())
  const afterRestart = await reopened.get(existing.id)
  assert.equal(afterRestart?.version, 3)
  assert.match(afterRestart?.body || '', /## 兼容性风险/)
  assert.equal((await reopened.search({ text: '旧版配置兼容性风险', limit: 10 }))[0]?.entry.id, existing.id)
  assert.equal((await reopened.listDocuments('default')).length, 1)
})

test('concurrent review treats distinct document sections as compatible additions', async (t) => {
  const provider = await fixture(t)
  const existing = await provider.create({
    knowledgeBaseId: 'default', title: '项目排查记录', body: '## 基础信息\n\n当前服务使用版本 1.0。',
    type: 'fact', tags: ['项目'], scope: { kind: 'global' }, confidence: .9,
  })
  const first = await provider.propose({
    action: 'update', targetId: existing.id,
    draft: {
      knowledgeBaseId: 'default', title: '项目排查记录', body: '## 变更记录\n\n提交 123 增加了配置同步。',
      type: 'fact', tags: ['变更'], scope: { kind: 'global' }, confidence: .94,
    },
    reason: '追加变更记录。',
  }, 'concurrent-section:1')
  const second = await provider.propose({
    action: 'update', targetId: existing.id,
    draft: {
      knowledgeBaseId: 'default', title: '项目排查记录', body: '## 排查结论\n\n测试 8 项均已通过。',
      type: 'fact', tags: ['结论'], scope: { kind: 'global' }, confidence: .95,
    },
    reason: '追加排查结论。',
  }, 'concurrent-section:2')

  assert.equal((await provider.review(first.id, { decision: 'approve' })).status, 'approved')
  const reviewed = await provider.review(second.id, { decision: 'approve' })
  assert.equal(reviewed.status, 'approved')
  assert.equal(reviewed.action, 'update')
  const result = await provider.get(existing.id)
  assert.match(result?.body || '', /提交 123/)
  assert.match(result?.body || '', /测试 8 项/)
})

test('search scores exact topic matches above incidental term matches', async (t) => {
  const provider = await fixture(t)
  const exact = await provider.create({
    knowledgeBaseId: 'default', title: 'DSH 插件安装',
    body: '使用 dsh plugin add 安装插件，并在完成后重启对应 profile。',
    type: 'procedure', tags: ['dsh', '插件'], scope: { kind: 'global' }, confidence: .95,
  })
  await provider.create({
    knowledgeBaseId: 'default', title: '常规开发检查',
    body: '提交之前运行测试，插件项目也遵循相同要求。',
    type: 'procedure', tags: ['测试'], scope: { kind: 'global' }, confidence: .9,
  })

  const hits = await provider.search({ text: '什么是 DSH 插件安装流程', limit: 10 })
  assert.equal(hits[0]?.entry.id, exact.id)
  assert.ok((hits[0]?.score ?? 0) > .5)
  assert.ok(hits.every(hit => hit.score >= 0 && hit.score <= 1))
  const incidental = hits.find(hit => hit.entry.id !== exact.id)
  if (incidental !== undefined) assert.ok(incidental.score < (hits[0]?.score ?? 0))

  const oldSectionHits = await provider.search({ text: 'dsh plugin add', limit: 10 })
  const newSectionHits = await provider.search({ text: '重启 profile', limit: 10 })
  assert.equal(oldSectionHits[0]?.entry.id, exact.id)
  assert.equal(newSectionHits[0]?.entry.id, exact.id)
})

test('each active entry is persisted as one editable Markdown document', async (t) => {
  const provider = await fixture(t)
  assert.deepEqual(await provider.listDocuments('default'), [])

  const entry = await provider.create(globalDraft)
  let documents = await provider.listDocuments('default')
  assert.equal(documents.length, 1)
  const document = documents[0]
  assert.equal(document.id, entry.id)
  assert.match(document.relPath, /^Production-deployment-policy--[a-zA-Z0-9]+\.md$/)
  assert.equal(document.entryCount, 1)
  assert.match(document.content, /Production deployment policy/)
  assert.match(document.content, /persistent volume/)
  assert.equal((await provider.getDocument(document.id))?.contentHash, document.contentHash)
  assert.deepEqual((await provider.listDocuments('default', 'persistent volume')).map(item => item.id), [document.id])
  await access(join(provider.fixtureRoot, 'documents', 'base-default', document.relPath))

  await provider.update(entry.id, { ...globalDraft, title: 'Production Docker decision', type: 'decision', body: 'Use Docker Compose for production deployments.' })
  documents = await provider.listDocuments('default')
  assert.equal(documents.length, 1)
  assert.equal(documents[0]?.id, entry.id)
  assert.match(documents[0]?.relPath || '', /^Production-Docker-decision--[a-zA-Z0-9]+\.md$/)
  assert.match(documents[0]?.content || '', /Docker Compose/)

  await provider.archive(entry.id)
  assert.deepEqual(await provider.listDocuments('default'), [])
})

test('finalized documents remain recallable but reject every content mutation until reopened', async (t) => {
  const provider = await fixture(t)
  const entry = await provider.create({
    ...globalDraft,
    title: 'Closed incident investigation',
    body: 'The incident root cause was confirmed and the production fix was verified.',
  })

  const finalized = await provider.finalize(entry.id, 'resolved', 'Production verification passed; incident closed.')
  assert.equal(finalized.documentState, 'resolved')
  assert.equal(finalized.finalizationNote, 'Production verification passed; incident closed.')
  assert.ok(finalized.finalizedAt)
  assert.equal((await provider.search({ text: 'incident root cause', limit: 10 }))[0]?.entry.id, entry.id)

  const document = (await provider.listDocuments('default'))[0]
  assert.equal(document?.documentState, 'resolved')
  assert.equal(document?.finalizationNote, 'Production verification passed; incident closed.')
  const markdown = await readFile(join(provider.fixtureRoot, 'documents', 'base-default', document.relPath), 'utf8')
  assert.match(markdown, /documentState: resolved/)
  assert.match(markdown, /finalizationNote: Production verification passed; incident closed\./)

  await assert.rejects(
    () => provider.update(entry.id, { ...globalDraft, title: entry.title, body: 'Attempted edit.' }),
    /is finalized as resolved/,
  )
  await assert.rejects(
    () => provider.propose({
      action: 'update', targetId: entry.id,
      draft: { ...globalDraft, title: entry.title, body: 'Attempted candidate update.' },
      reason: 'Must not modify finalized knowledge.',
    }),
    /is finalized as resolved/,
  )
  const direct = await provider.writeDirect({
    action: 'create',
    draft: { ...globalDraft, title: entry.title, body: 'New material for the same finalized topic.' },
    reason: 'Must be skipped because the topic is finalized.',
  })
  assert.equal(direct.outcome, 'finalized')
  assert.equal(direct.entry?.id, entry.id)

  const reopened = await provider.reopen(entry.id)
  assert.equal(reopened.documentState, 'open')
  assert.equal(reopened.finalizedAt, undefined)
  const updated = await provider.update(entry.id, { ...globalDraft, title: entry.title, body: 'Editing is allowed after reopening.' })
  assert.match(updated.body, /allowed after reopening/)
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
  assert.equal(documents.length, 1)
  assert.equal(documents[0]?.id, 'legacy-1')
  assert.match(documents[0]?.relPath || '', /^Legacy-decision--legacy1\.md$/)
  assert.match(documents[0]?.content || '', /Keep this after migration/)
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
  assert.equal(await provider.claimExtraction('session-crashed:1'), true)
  const recoveryDb = new DatabaseSync(join(provider.fixtureRoot, 'knowledge.sqlite'))
  recoveryDb.prepare('UPDATE extraction_jobs SET updated_at=? WHERE source_key=?')
    .run('2000-01-01T00:00:00.000Z', 'session-crashed:1')
  recoveryDb.close()
  assert.equal(await provider.claimExtraction('session-crashed:1'), true)
  assert.equal((await provider.extractionJob('session-crashed:1'))?.attempts, 2)
  await provider.completeExtraction('session-crashed:1', 0)
  const stats = await provider.stats()
  assert.equal(stats.entries.active, 1)
  assert.equal(stats.candidates.approved, 1)
  assert.equal(stats.extractionJobs.completed, 2)
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
  assert.ok(provider.listApiTokens().some(token => token.id === created.record.id && token.revokedAt))
  provider.deleteApiToken(created.record.id)
  assert.equal(provider.listApiTokens().some(token => token.id === created.record.id), false)
  assert.throws(() => provider.deleteApiToken(actor.id), /only revoked/)
})

test('knowledge documents keep stable structured references to note documents', async (t) => {
  const provider = await fixture(t)
  const note = await provider.notes.createDocument('部署记录', null, '# 部署记录\n\n原始资料不进入知识正文。')
  const file = await provider.notes.upload({
    name: '架构图.png', mediaType: 'image/png', content: Buffer.from('image bytes'),
  })
  const folder = await provider.notes.createFolder('资料目录')
  const entry = await provider.create({
    ...globalDraft,
    title: '部署知识摘要',
    body: '部署前需要核对原始记录和架构图。',
  })

  assert.deepEqual((await provider.searchNotes('部署', 10)).map(item => item.id), [note.id])
  assert.deepEqual(await provider.searchNotes('不存在', 10), [])
  await assert.rejects(
    () => provider.addKnowledgeNoteReference(entry.id, folder.id, 'user'),
    /can reference note documents or files, not folders/,
  )

  const first = await provider.addKnowledgeNoteReference(entry.id, note.id, 'user')
  const duplicate = await provider.addKnowledgeNoteReference(entry.id, note.id, 'agent', 'session-duplicate')
  await provider.addKnowledgeNoteReference(entry.id, file.id, 'agent', 'session-1')
  assert.equal(first.note.id, note.id)
  assert.equal(duplicate.source, 'user')
  assert.equal((await provider.listKnowledgeNoteReferences(entry.id)).length, 2)
  assert.deepEqual(
    new Set(provider.noteReferencesForNotes([note.id, file.id]).map(item => `${item.documentId}:${item.noteId}`)),
    new Set([`${entry.id}:${note.id}`, `${entry.id}:${file.id}`]),
  )
  assert.doesNotMatch((await provider.get(entry.id))?.body || '', /note:\/\//)

  await provider.deleteKnowledgeNoteReference(entry.id, note.id)
  assert.deepEqual((await provider.listKnowledgeNoteReferences(entry.id)).map(item => item.note.id), [file.id])
  await assert.rejects(
    () => provider.deleteKnowledgeNoteReference(entry.id, note.id),
    /knowledge note reference.*was not found/,
  )

  await provider.finalize(entry.id, 'complete')
  await assert.rejects(
    () => provider.addKnowledgeNoteReference(entry.id, note.id, 'user'),
    /is finalized as collection complete/,
  )
  await assert.rejects(
    () => provider.deleteKnowledgeNoteReference(entry.id, file.id),
    /is finalized as collection complete/,
  )
  await provider.reopen(entry.id)
  await provider.archive(entry.id)
  await assert.rejects(
    () => provider.addKnowledgeNoteReference(entry.id, note.id, 'user'),
    /archived knowledge documents cannot change note references/,
  )
  await provider.delete(entry.id)
  assert.deepEqual(provider.noteReferencesForNotes([file.id]), [])
})

test('schema 9 migration backfills legacy note links without rewriting knowledge bodies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-note-reference-migration-'))
  const path = join(root, 'knowledge.sqlite')
  let provider = new LocalKnowledgeProvider(path)
  const note = await provider.notes.createDocument('旧引用', null, '# 旧资料')
  const entry = await provider.create({
    ...globalDraft,
    title: '旧格式引用',
    body: `兼容保留 @[旧引用.md](note://${note.id})。`,
  })
  await provider.close()

  const database = new DatabaseSync(path)
  database.exec('DROP TABLE knowledge_note_references; PRAGMA user_version = 9;')
  database.close()
  provider = new LocalKnowledgeProvider(path)
  t.after(async () => {
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })

  const references = await provider.listKnowledgeNoteReferences(entry.id)
  assert.equal(references.length, 1)
  assert.equal(references[0].note.id, note.id)
  assert.equal(references[0].source, 'legacy')
  assert.match((await provider.get(entry.id))?.body || '', new RegExp(`note://${note.id}`))
})
