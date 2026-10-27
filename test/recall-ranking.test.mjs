import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { compareRecallHits } from '../lib/recall-ranking.js'
import { selectAutomaticRecallHits, formatAutomaticRecall } from '../lib/retrieval.js'
import { usageRecorder } from '../lib/recall-usage.js'

const draft = { knowledgeBaseId: 'default', group: '测试', title: 'Production deployment', body: 'Deploy with Docker and retain persistent volumes.', type: 'lesson', tags: ['ops'], scope: { kind: 'global' }, confidence: .9 }
async function fixture(t) {
  const provider = new LocalKnowledgeProvider(':memory:')
  t.after(() => provider.close())
  const entry = await provider.create(draft)
  await provider.upsertMount({ targetKind: 'session', targetId: 's', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'none', includeTags: [], excludeTags: [], extractionInstructions: '' })
  return { provider, entry, store: provider.recallRanking }
}

test('recall counts only delivered usage, deduplicates turns and preserves channel flags', async t => {
  const { provider, entry, store } = await fixture(t)
  await provider.search({ text: 'deployment', limit: 10 })
  await provider.get(entry.id)
  assert.equal(store.list().items[0].recalls, 0)
  const usage = { sessionId: 's', turn: '1', ids: [entry.id] }
  for (const kind of ['auto', 'auto', 'search', 'read', 'read']) await provider.recordRecallUsage({ ...usage, kind })
  const row = store.list().items[0]
  assert.deepEqual([row.recalls, row.sessions, row.reads, row.auto, row.searches], [1, 1, 1, 1, 1])
  assert.equal('body' in row, false)
  assert.equal(JSON.stringify(store.detail(entry.id, 'usage')).includes('sessionId'), false)
  store.record({ ...usage, turn: '2', kind: 'search' }, 'local', Date.now() - 8 * 86400000)
  assert.equal(store.list({ days: 7 }).items[0].recalls, 1)
  assert.equal(store.list({ days: 30 }).items[0].recalls, 2)
  store.record({ ...usage, kind: 'auto' }, 'another-client')
  assert.equal(store.list().items[0].sessions, 2)
})

test('usage obeys mount, tags and project scope and rejects invalid payloads', async t => {
  const { provider, entry, store } = await fixture(t)
  const privateEntry = await provider.create({ ...draft, title: 'Other project', scope: { kind: 'project', id: '/private' } })
  await provider.recordRecallUsage({ sessionId: 's', turn: '1', kind: 'auto', ids: [privateEntry.id] })
  await provider.recordRecallUsage({ sessionId: 'unmounted', turn: '1', kind: 'auto', ids: [entry.id] })
  assert.ok(store.list().items.every(item => item.recalls === 0))
  await provider.upsertMount({ targetKind: 'session', targetId: 's', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'none', includeTags: [], excludeTags: ['ops'], extractionInstructions: '' })
  await provider.recordRecallUsage({ sessionId: 's', turn: '1', kind: 'auto', ids: [entry.id] })
  assert.equal(store.list().items.find(item => item.id === entry.id).recalls, 0)
  await assert.rejects(provider.recordRecallUsage({ sessionId: 's', turn: '1', kind: 'fake', ids: [entry.id] }), /参数无效/)
})

test('friction decays with a prevention floor, can be overridden and retracted without touching document versions', async t => {
  const { provider, entry, store } = await fixture(t)
  const original = await provider.get(entry.id)
  const value = { requestId: randomUUID(), severity: 3, reason: 'Repeated deployment lost the volume' }
  const incident = store.incident(entry.id, value)
  assert.deepEqual(store.incident(entry.id, value), incident)
  assert.throws(() => store.incident(entry.id, { ...value, severity: 6 }), /内容已改变/)
  assert.equal(store.list().items[0].friction, 30)
  provider.db.prepare('UPDATE recall_friction SET at=? WHERE id=?').run(Date.now() - 90 * 86400000, incident.id)
  assert.ok(Math.abs(store.list().items[0].friction - 18.75) < .06)
  assert.throws(() => store.patch(entry.id, { revision: 0, frictionOverride: 80 }), /填写原因/)
  store.patch(entry.id, { revision: 0, frictionOverride: 80, priority: 2, reason: 'Critical recurring failure' })
  assert.equal(store.list().items[0].friction, 80)
  assert.throws(() => store.patch(entry.id, { revision: 0, priority: 0 }), /已被修改/)
  store.patch(entry.id, { revision: 1, frictionOverride: null, reason: 'Use automatic calculation' })
  store.retract(entry.id, incident.id, 'Duplicate incident')
  assert.equal(store.list().items[0].friction, 0)
  assert.ok(store.detail(entry.id).items[0].retracted_at)
  assert.equal(store.detail(entry.id, 'changes').items.length, 2)
  assert.deepEqual(await provider.get(entry.id), original)
  assert.equal((await provider.versions(entry.id)).length, 1)
})

test('batch priorities are atomic, list and histories paginate independently, cursors bind filters', async t => {
  const { provider, entry, store } = await fixture(t)
  const other = await provider.create({ ...draft, title: 'Another deployment' })
  assert.throws(() => store.patchMany([{ id: entry.id, revision: 0 }, { id: other.id, revision: 7 }], 2), /已被修改/)
  assert.ok(store.list().items.every(row => row.priority === 0 && row.revision === 0))
  store.patchMany([{ id: entry.id, revision: 0 }, { id: other.id, revision: 0 }], 1)
  assert.ok(store.list().items.every(row => row.priority === 1))
  const page = store.list({ limit: 1 })
  const next = store.list({ limit: 1, cursor: page.nextCursor })
  assert.equal(page.total, 2); assert.notEqual(page.items[0].id, next.items[0].id)
  assert.throws(() => store.list({ days: 7, cursor: page.nextCursor }), /游标/)
  for (let i = 0; i < 32; i++) store.incident(entry.id, { requestId: randomUUID(), reason: 'Independent occurrence ' + i, severity: 1 })
  const history = store.detail(entry.id)
  assert.equal(history.items.length, 30)
  assert.equal(store.detail(entry.id, 'incidents', history.nextCursor).items.length, 2)
  assert.equal(store.list({ sort: 'friction' }).items[0].id, entry.id)
  assert.equal(store.list().items.find(row => row.id === entry.id).friction, 100)
  await provider.archive(entry.id)
  assert.equal(store.list().total, 1)
})

test('preferences reorder similar relevance only, preserve thresholds and snippet-budget accounting', async t => {
  const { provider, entry, store } = await fixture(t)
  const other = await provider.create({ ...draft, title: 'Production deployment second' })
  store.patch(entry.id, { priority: 2, frictionOverride: 100, revision: 0, reason: 'Important prevention' })
  const hit = (e, score) => ({ entry: e, score, snippet: e.body, handle: e.id, mount: { base: { name: 'Default' } } })
  const near = store.boost([hit(other, .52), hit(entry, .51)])
  assert.equal(near[0].entry.id, entry.id)
  assert.equal(near[0].score, .51)
  const far = store.boost([hit(other, .55), hit(entry, .54)])
  assert.equal(far[0].entry.id, other.id)
  assert.equal(selectAutomaticRecallHits(near, 2, .515)[0].entry.id, other.id)
  assert.ok(compareRecallHits(far[0], far[1]) < 0)
  const included = []
  formatAutomaticRecall(near, 1, included)
  assert.deepEqual(included, [])
})

test('incident summary spans all pages, honors filters and excludes revoked and archived records', async t => {
  const { provider, entry, store } = await fixture(t)
  for (let i = 0; i < 32; i++) {
    const e = await provider.create({ ...draft, title: `Frequently read ${i}` })
    store.record({ sessionId: 's', turn: String(i), kind: 'search', ids: [e.id] })
  }
  const incident = store.incident(entry.id, { requestId: randomUUID(), reason: 'Real independent failure', severity: 3 })
  const first = store.list({ limit: 30, sort: 'recalls' })
  assert.equal(first.incidentDocuments, 1)
  assert.ok(first.items.every(row => row.incidents === 0))
  assert.equal(store.list({ sort: 'friction' }).items[0].id, entry.id)
  assert.equal(store.list({ query: 'Frequently' }).incidentDocuments, 0)
  assert.equal(store.list({ cursor: first.nextCursor, limit: 30, sort: 'recalls' }).incidentDocuments, 1)
  provider.db.prepare('UPDATE recall_friction SET at=? WHERE id=?').run(Date.now() - 100 * 86400000, incident.id)
  assert.equal(store.list({ days: 7 }).incidentDocuments, 1)
  store.retract(entry.id, incident.id, 'Test retraction')
  assert.equal(store.list().incidentDocuments, 0)
  store.incident(entry.id, { requestId: randomUUID(), reason: 'New independent failure', severity: 1 })
  await provider.archive(entry.id)
  assert.equal(store.list().incidentDocuments, 0)
})

test('remote usage and ranking API enforce management permission without granting write authority', async t => {
  const { provider, entry, store } = await fixture(t)
  const admin = provider.createApiToken('admin', ['admin']).token
  const reader = provider.createApiToken('reader', ['read']).token
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, get() {} }, provider, '/api')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api`
  const remote = new RemoteKnowledgeProvider({ url, token: reader, timeoutMs: 5000 })
  await remote.recordRecallUsage({ sessionId: 's', turn: '1', kind: 'auto', ids: [entry.id] })
  assert.equal(store.list().items[0].recalls, 1)
  const request = (path, token, method = 'GET', body) => fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  assert.equal((await fetch(url + '/recall')).status, 401)
  assert.equal((await (await request('/recall', reader)).json()).canManage, false)
  assert.equal((await request('/recall/' + entry.id, reader, 'PATCH', { revision: 0, priority: 2 })).status, 403)
  assert.equal((await request('/recall/preferences', reader, 'POST', { items: [{ id: entry.id, revision: 0 }], priority: 2 })).status, 403)
  assert.equal((await request('/recall/preferences', admin, 'POST', { items: [{ id: entry.id, revision: 0 }], priority: 2 })).status, 200)
  assert.equal(store.list().items[0].priority, 2)
})

test('optional telemetry failures never interrupt replies and captures turn once', async () => {
  const calls = [], agent = { session: { id: 's', header: { cwd: '/demo' }, snapshotEvents: () => [{ type: 'turn/start', data: { turn: 7 } }] } }
  const record = usageRecorder({ recordRecallUsage: async value => { calls.push(value); throw new Error('old server') } }, agent)
  record('search', ['entry']); record('read', ['entry'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0].turn, '7')
  assert.equal(calls[0].projectId, '/demo')
  assert.doesNotThrow(() => usageRecorder({}, agent)('auto', ['entry']))
})
