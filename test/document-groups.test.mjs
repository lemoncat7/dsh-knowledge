import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { normalizeDocumentGroup } from '../lib/document-groups.js'

const draft = { knowledgeBaseId: 'default', group: '部署运维', title: '部署约定', body: '发布后检查健康状态。', type: 'procedure', tags: ['ops'], scope: { kind: 'global' }, confidence: .9 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-document-groups-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return { provider, root }
}

test('new documents require a meaningful group; existing spellings are reused per base', async t => {
  const { provider } = await fixture(t)
  for (const group of [undefined, '', '  ', '未分组', null, 42, 'x\ny', 'x'.repeat(65)]) await assert.rejects(provider.create({ ...draft, group }), /分组/)
  await provider.create({ ...draft, group: 'Dev Ops' })
  const next = await provider.create({ ...draft, group: '  Ｄｅｖ   Ｏｐｓ  ', title: '发布核验' })
  assert.equal(next.group, 'Dev Ops')
  assert.deepEqual(await provider.listDocumentGroups('default'), [{ name: 'Dev Ops', count: 2 }])
  assert.equal(normalizeDocumentGroup(' 知识 文档 '), '知识 文档')
})

test('group changes preserve id, path, body, tags, links, finalization and search; legacy saves retain classification', async t => {
  const { provider } = await fixture(t)
  const entry = await provider.create(draft)
  const before = await provider.getDocument(entry.id)
  const note = await provider.createNoteDocument('说明.md', null, '原笔记')
  await provider.addKnowledgeNoteReference(entry.id, note.id, 'user')
  const { group, ...legacy } = entry
  const updated = await provider.update(entry.id, { ...legacy, body: '发布后检查健康状态及版本。' })
  assert.equal(updated.group, group)
  await provider.finalize(entry.id, 'complete')
  const [moved] = await provider.assignDocumentGroup('default', [entry.id], '项目规范')
  assert.equal(moved.documentState, 'complete'); assert.equal(moved.body, updated.body); assert.deepEqual(moved.tags, updated.tags)
  const after = await provider.getDocument(entry.id)
  assert.equal(after.relPath, before.relPath); assert.equal(after.group, '项目规范')
  assert.equal((await provider.listDocumentIndex({ knowledgeBaseIds: ['default'], limit: 10 })).items[0].group, '项目规范')
  assert.equal((await provider.listKnowledgeNoteReferences(entry.id))[0].note.id, note.id)
  assert.ok((await provider.search({ text: '健康状态', limit: 10 })).some(hit => hit.entry.id === entry.id))
  assert.equal((await provider.versions(entry.id))[0].snapshot.group, '项目规范')
})

test('batch grouping is atomic and base scoped; clearing a group never deletes documents', async t => {
  const { provider } = await fixture(t)
  const a = await provider.create(draft), b = await provider.create({ ...draft, title: '另一个主题' })
  await assert.rejects(provider.assignDocumentGroup('default', [a.id, 'missing'], '新组'), /刷新/)
  assert.equal((await provider.get(a.id)).group, draft.group)
  const base = await provider.createKnowledgeBase({ name: '另一个库', description: '', defaultTags: [], extractionInstructions: '' })
  await assert.rejects(provider.assignDocumentGroup(base.id, [a.id], '跨库'), /刷新/)
  await provider.assignDocumentGroup('default', [a.id, b.id], '')
  assert.deepEqual(await provider.listDocumentGroups('default'), [{ name: '', count: 2 }])
  assert.equal((await provider.list({ limit: 10 })).items.length, 2)
  await provider.update(a.id, { ...a, group: undefined, body: '旧文档仍然允许维护。' })
  assert.equal((await provider.get(a.id)).group, '')
})
