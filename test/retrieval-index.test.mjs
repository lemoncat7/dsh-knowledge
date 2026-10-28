import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RetrievalIndex, PASSAGE_INDEX_VERSION } from '../lib/retrieval-index.js'
import { buildPassageStructure, selectKnowledgePassage } from '../lib/retrieval-passages.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'

const draft = { knowledgeBaseId: 'default', group: '运维', title: '证书维护',
  body: '# 运维\n\n## TLS_CERT_EXPIRED\n\n😀先续签证书。\n\n检查系统时间。\n\n## 其他\n\n不相关内容。',
  type: 'procedure', tags: ['ops'], scope: { kind: 'global' }, confidence: .9 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-index-'))
  const path = join(root, 'knowledge.sqlite')
  const provider = new LocalKnowledgeProvider(path)
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return { provider, path }
}
const search = provider => provider.search({ text: 'TLS_CERT_EXPIRED', includePassage: true, limit: 4 })
const drain = provider => { while (provider.retrievalIndex.processBatch()) {} }

test('bounded index batches use one savepoint and preserve surrounding rollback', async t => {
  const { provider } = await fixture(t)
  provider.retrievalIndex.close()
  for (let n = 0; n < 3; n++) await provider.create({ ...draft, title: `batch ${n}` })
  const index = new RetrievalIndex(provider.db)
  t.after(() => index.close())
  const statements = []
  const exec = provider.db.exec.bind(provider.db)
  provider.db.exec = sql => { statements.push(sql); return exec(sql) }
  provider.db.exec('BEGIN')
  assert.equal(index.processBatch(), 3)
  assert.equal(index.status().ready, 3)
  provider.db.exec('ROLLBACK')
  assert.equal(index.status().pending, 3)
  assert.equal(statements.filter(s => s === 'SAVEPOINT knowledge_passage_batch').length, 1)
  assert.equal(statements.filter(s => s === 'RELEASE knowledge_passage_batch').length, 1)
  index.processBatch()
  statements.length = 0
  assert.equal(index.processBatch(), 0)
  assert.deepEqual(statements, [], 'idle work must not start write transactions')
})

test('storage failure rolls back a batch and the next attempt can recover', async t => {
  const { provider } = await fixture(t)
  provider.retrievalIndex.close()
  for (let n = 0; n < 2; n++) await provider.create({ ...draft, title: `recover ${n}` })
  const index = new RetrievalIndex(provider.db)
  t.after(() => index.close())
  provider.db.exec(`CREATE TRIGGER reject_batch BEFORE UPDATE ON knowledge_passage_index
    WHEN (SELECT count(*) FROM knowledge_passage_index WHERE state='ready') > 0
    BEGIN SELECT RAISE(ABORT, 'test storage unavailable'); END;`)
  assert.throws(() => index.processBatch(), /test storage unavailable/)
  assert.equal(index.status().ready, 0)
  assert.equal(index.status().pending, 2)
  provider.db.exec('DROP TRIGGER reject_batch')
  assert.equal(index.processBatch(), 2)
  assert.equal(index.status().ready, 2)
})

test('persistent index has parent sections, deduplicated contiguous context and Unicode-accurate evidence', async t => {
  const { provider } = await fixture(t)
  const entry = await provider.create(draft)
  drain(provider)
  const [hit] = await search(provider)
  assert.equal(hit.retrieval.source, 'index')
  assert.deepEqual(hit.passage, selectKnowledgePassage(entry.body, 'TLS_CERT_EXPIRED'))
  assert.match(hit.passage.text, /先续签证书/)
  assert.match(hit.passage.text, /检查系统时间/)
  assert.doesNotMatch(hit.passage.text, /不相关内容/)
  assert.equal(hit.passage.text.split('检查系统时间').length, 2)
  assert.equal(Array.from(entry.body).slice(hit.passage.offset, hit.passage.endOffset).join(''), hit.passage.text)
  const row = provider.db.prepare('SELECT * FROM knowledge_passage_index WHERE entry_id=?').get(entry.id)
  assert.equal(row.index_version, PASSAGE_INDEX_VERSION)
  assert.equal(row.body_hash.length, 64)
  const structure = JSON.parse(row.structure_json)
  assert.equal(structure.sections[1].parentId, 0)
  assert.equal(structure.sections[2].parentId, 0)
  assert.ok(!row.structure_json.includes('先续签证书'), 'index stores ranges, not duplicate bodies')
})

test('updates immediately invalidate evidence, same-body version changes reuse structure, delete cascades', async t => {
  const { provider } = await fixture(t)
  const entry = await provider.create(draft)
  drain(provider)
  const updated = await provider.update(entry.id, { ...draft, body: '# TLS_CERT_EXPIRED\n\n新操作：更换证书。' })
  const [pending] = await search(provider)
  assert.equal(pending.retrieval.source, 'fallback')
  assert.equal(pending.retrieval.documentVersion, updated.version)
  assert.doesNotMatch(pending.passage.text, /先续签/)
  drain(provider)
  const indexBefore = provider.db.prepare('SELECT structure_json FROM knowledge_passage_index WHERE entry_id=?').get(entry.id)
  await provider.update(entry.id, { ...updated, title: '新名称' })
  drain(provider)
  assert.equal((await search(provider))[0].retrieval.source, 'index')
  assert.deepEqual(provider.db.prepare('SELECT structure_json FROM knowledge_passage_index WHERE entry_id=?').get(entry.id), indexBefore)
  await provider.archive(entry.id)
  assert.equal((await search(provider)).length, 0)
  assert.equal(provider.retrievalIndex.status().pending, 0)
  await provider.delete(entry.id)
  assert.equal(provider.db.prepare('SELECT count(*) AS n FROM knowledge_passage_index').get().n, 0)
})

test('restart resumes pending work and reuses current indexes without parsing again', async t => {
  const { provider, path } = await fixture(t)
  const first = await provider.create(draft)
  drain(provider)
  const indexedAt = provider.db.prepare('SELECT indexed_at FROM knowledge_passage_index WHERE entry_id=?').get(first.id).indexed_at
  await provider.create({ ...draft, title: '第二份维护', body: 'TLS_CERT_EXPIRED 新文档' })
  await provider.close()
  const reopened = new LocalKnowledgeProvider(path)
  try {
    drain(reopened)
    assert.equal(reopened.retrievalIndex.status().ready, 2)
    assert.equal(reopened.db.prepare('SELECT indexed_at FROM knowledge_passage_index WHERE entry_id=?').get(first.id).indexed_at, indexedAt)
  } finally { await reopened.close() }
})

test('failed builds keep source usable, back off, redact errors and allow explicit retry', async t => {
  const { provider } = await fixture(t)
  const entry = await provider.create(draft)
  provider.retrievalIndex.close()
  let fail = true
  const index = new RetrievalIndex(provider.db, body => {
    if (fail) throw new Error('SECRET document body or credential must not be logged')
    return buildPassageStructure(body)
  })
  t.after(() => index.close())
  const now = Date.now()
  index.processBatch(4, now)
  assert.equal(index.status().failed, 1)
  assert.equal(index.status().failures[0].retryAt, now + 5000)
  assert.ok(!JSON.stringify(index.status()).includes('SECRET'))
  assert.equal(index.processBatch(4, now + 100), 0)
  assert.equal(index.passage(entry, 'TLS_CERT_EXPIRED').retrieval.source, 'fallback')
  assert.equal((await provider.get(entry.id)).body, draft.body)
  fail = false
  assert.equal(index.retryFailed(), 1)
  index.processBatch()
  assert.equal(index.passage(entry, 'TLS_CERT_EXPIRED').retrieval.source, 'index')
})

test('corrupt and outdated derived indexes fall back without corrupting evidence', async t => {
  const { provider } = await fixture(t)
  const entry = await provider.create(draft)
  drain(provider)
  for (const json of ['{', '{"blocks":[{"start":-1,"end":9}],"sections":[]}']) {
    provider.db.prepare("UPDATE knowledge_passage_index SET structure_json=?,state='ready' WHERE entry_id=?").run(json, entry.id)
    assert.equal((await search(provider))[0].retrieval.source, 'fallback')
    drain(provider)
    assert.equal((await search(provider))[0].retrieval.source, 'index')
  }
  provider.db.prepare('UPDATE knowledge_passage_index SET index_version=0').run()
  assert.equal((await search(provider))[0].retrieval.source, 'fallback')
})

test('indexed search never widens project, base, tag or archive scope', async t => {
  const { provider } = await fixture(t)
  const publicEntry = await provider.create(draft)
  await provider.create({ ...draft, title: '私有', scope: { kind: 'project', id: '/secret' } })
  await provider.create({ ...draft, title: '排除', tags: ['private'] })
  const base = await provider.createKnowledgeBase({ name: '其他库', description: '', defaultTags: [], extractionInstructions: '' })
  await provider.create({ ...draft, title: '其他库资料', knowledgeBaseId: base.id })
  drain(provider)
  const hits = await provider.search({ text: 'TLS_CERT_EXPIRED', includePassage: true, knowledgeBaseIds: ['default'], excludeTags: ['private'], projectId: '/demo', limit: 20 })
  assert.deepEqual(hits.map(hit => hit.entry.id), [publicEntry.id])
  assert.equal(hits[0].retrieval.source, 'index')
})

test('remote search carries indexed passages; readers see status but only administrators can retry', async t => {
  const { provider } = await fixture(t)
  await provider.create(draft)
  drain(provider)
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, get() {} }, provider, '/api')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api`
  const reader = provider.createApiToken('reader', ['read']).token
  const admin = provider.createApiToken('admin', ['admin']).token
  const remote = new RemoteKnowledgeProvider({ url, token: reader, timeoutMs: 5000 })
  assert.equal((await search(remote))[0].retrieval.source, 'index')
  for (const token of ['', reader]) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    assert.equal((await fetch(`${url}/retrieval-index`, { headers })).status, token ? 200 : 401)
    assert.equal((await fetch(`${url}/retrieval-index/retry`, { method: 'POST', headers })).status, token ? 403 : 401)
  }
  const headers = { Authorization: `Bearer ${admin}` }
  assert.equal((await (await fetch(`${url}/retrieval-index`, { headers })).json()).ready, 1)
  assert.deepEqual(await (await fetch(`${url}/retrieval-index/retry`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json(), { queued: 0 })
  const excluded = await provider.create({ ...draft, title: '不可见标签', tags: ['ops', 'private'] })
  await provider.create({ ...draft, title: '其他项目', scope: { kind: 'project', id: '/secret' } })
  await provider.upsertMount({ targetKind: 'session', targetId: 'index-session', knowledgeBaseId: 'default', enabled: true,
    recallEnabled: true, writeMode: 'none', includeTags: ['ops'], excludeTags: ['private'], extractionInstructions: '' })
  provider.retrievalIndex.close()
  provider.db.exec("UPDATE knowledge_passage_index SET state='failed',error_code='INDEX_BUILD_FAILED'")
  const query = '?sessionId=index-session&projectId=%2Fdemo&knowledgeBaseId=default'
  const scoped = await (await fetch(`${url}/retrieval-index${query}&details=1`, { headers })).json()
  assert.equal(scoped.total, 1)
  assert.equal(scoped.failed, 1)
  assert.equal(scoped.items.length, 1)
  assert.equal(scoped.items[0].title, draft.title)
  const retryHeaders = { ...headers, 'content-type': 'application/json' }
  assert.deepEqual(await (await fetch(`${url}/retrieval-index/retry${query}`, { method: 'POST', headers: retryHeaders, body: JSON.stringify({ documentId: excluded.id }) })).json(), { queued: 0 })
  assert.deepEqual(await (await fetch(`${url}/retrieval-index/retry${query}`, { method: 'POST', headers: retryHeaders, body: '{}' })).json(), { queued: 1 })
  assert.equal(provider.db.prepare("SELECT count(*) AS n FROM knowledge_passage_index WHERE state='failed'").get().n, 2)
  const empty = await (await fetch(`${url}/retrieval-index?knowledgeBaseId=`, { headers })).json()
  assert.equal(empty.total, 0)
  const unmounted = await (await fetch(`${url}/retrieval-index?sessionId=unmounted&details=1`, { headers })).json()
  assert.equal(unmounted.total, 0)
  assert.deepEqual(unmounted.items, [])
})

test('fences, CRLF, duplicate headings and bounded windows keep exact source positions', () => {
  const body = '# A\r\n\r\n```txt\r\n# not a heading\r\n' + '😀背景'.repeat(300) + 'NEEDLE\r\n```\r\n\r\n# A\r\n\r\n另一个标题。'
  const structure = buildPassageStructure(body)
  assert.equal(structure.sections.length, 2)
  const passage = selectKnowledgePassage(body, 'NEEDLE', 180, structure)
  assert.match(passage.text, /NEEDLE/)
  assert.equal(Array.from(body).slice(passage.offset, passage.endOffset).join(''), passage.text)
  assert.equal(Array.from(passage.text).length, 180)
})

test('document rollback also rolls back invalidation, and ordinary searches do not parse evidence', async t => {
  const { provider } = await fixture(t)
  const entry = await provider.create(draft)
  drain(provider)
  provider.db.exec('BEGIN IMMEDIATE')
  provider.db.prepare('UPDATE knowledge_entries SET body=?,version=version+1 WHERE id=?').run('uncommitted text', entry.id)
  assert.equal(provider.retrievalIndex.status().pending, 1)
  provider.db.exec('ROLLBACK')
  assert.equal(provider.retrievalIndex.status().ready, 1)
  const [ordinary] = await provider.search({ text: 'TLS_CERT_EXPIRED', limit: 4 })
  assert.equal(ordinary.passage, undefined)
  assert.equal(ordinary.retrieval, undefined)
  assert.equal((await search(provider))[0].passage.text, selectKnowledgePassage(draft.body, 'TLS_CERT_EXPIRED').text)
})

test('worker runs off the request path, bounds batches and can be closed safely', async t => {
  const { provider } = await fixture(t)
  for (let i = 0; i < 7; i++) await provider.create({ ...draft, title: `测试 ${i}` })
  provider.db.exec("UPDATE knowledge_passage_index SET state='pending'")
  assert.ok(provider.retrievalIndex.processBatch(2) <= 2)
  assert.ok(provider.retrievalIndex.status().pending >= 5)
  // Exercise the actual timer; timeout is a failure bound, not a fixed delay.
  const deadline = Date.now() + 6500
  while (provider.retrievalIndex.status().ready < 7 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(provider.retrievalIndex.status().ready, 7)
  await provider.close()
  assert.equal(provider.retrievalIndex.processBatch(), 0)
})

test('status pagination and retries preserve base, project and mount tag scope', async t => {
  const { provider } = await fixture(t)
  provider.retrievalIndex.close()
  for (let i = 0; i < 32; i++) await provider.create({ ...draft, title: `可见 ${i}` })
  const excluded = await provider.create({ ...draft, title: '排除标签', tags: ['ops', 'private'] })
  await provider.create({ ...draft, title: '其他项目', scope: { kind: 'project', id: '/other' } })
  const scope = { baseIds: ['default'], scoped: true, projectId: '/demo', mounts: [{ knowledgeBaseId: 'default', includeTags: ['ops'], excludeTags: ['private'] }] }
  provider.db.exec("UPDATE knowledge_passage_index SET state='failed',attempts=1")
  const first = provider.retrievalIndex.status(scope, { details: true })
  assert.equal(first.total, 32); assert.equal(first.items.length, 30); assert.equal(first.hasMore, true)
  assert.ok(first.items.every(item => String(item.title).startsWith('可见')))
  assert.equal(provider.retrievalIndex.status(scope, { details: true, offset: 30 }).items.length, 2)
  assert.deepEqual(provider.retrievalIndex.status(scope, { details: false }).items, [])
  assert.equal(provider.retrievalIndex.status({ baseIds: [] }).total, 0)
  assert.equal(provider.retrievalIndex.status({ mounts: [] }).total, 0)
  assert.equal(provider.retrievalIndex.retryFailed(scope, excluded.id), 0)
  assert.equal(provider.retrievalIndex.retryFailed(scope), 32)
  assert.equal(provider.retrievalIndex.status(scope).pending, 32)
  assert.equal(provider.retrievalIndex.status().failed, 2)
})
