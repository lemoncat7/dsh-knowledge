import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('composite score is explainable, bounded, filter independent and sorted before pagination', async t => {
  const provider = new LocalKnowledgeProvider(':memory:')
  t.after(() => provider.close())
  const store = provider.recallRanking
  const create = title => provider.create({ knowledgeBaseId: 'default', group: '测试', title, body: 'test', type: 'lesson', tags: [], scope: { kind: 'global' }, confidence: .9 })
  const hot = await create('Only frequently recalled'), useful = await create('Useful lesson'), empty = await create('Empty')
  const now = Date.now() - 1000
  for (let i = 0; i < 100; i++) store.record({ sessionId: 'same', turn: String(i), kind: 'auto', ids: [hot.id] }, 'local', now)
  for (let i = 0; i < 10; i++) {
    for (const kind of ['search', 'read']) store.record({ sessionId: `s${i}`, turn: '1', kind, ids: [useful.id] }, 'local', now)
  }
  store.patch(useful.id, { revision: 0, priority: 1, frictionOverride: 50, reason: 'Test bounded prevention' })
  const page = store.list({ limit: 1 })
  assert.equal(page.items[0].id, useful.id)
  assert.equal(store.list({ sort: 'recalls', limit: 1 }).items[0].id, hot.id)
  const row = page.items[0]
  const expected = 25 * 10 / 20 + 25 * 10 / 15 + 20 * 10 / 15 + .2 * 50 + 5
  assert.equal(row.score, Math.round(expected * 10) / 10)
  assert.ok(Math.abs(Object.values(row.scoreBreakdown).reduce((a, b) => a + b, 0) - expected) < 1e-10)
  assert.equal(store.list({ query: 'Useful', days: 7 }).items[0].score, row.score)
  const second = store.list({ cursor: page.nextCursor, limit: 1 })
  assert.equal(second.items[0].id, hot.id)
  assert.throws(() => store.list({ sort: 'recalls', cursor: page.nextCursor }), /游标/)
  assert.equal(store.list({ query: 'Empty' }).items[0].score, 0)
  store.patch(empty.id, { revision: 0, priority: -2 })
  assert.equal(store.list({ query: 'Empty' }).items[0].score, 0)
  store.patch(useful.id, { revision: 1, priority: 2, frictionOverride: 100, reason: 'Maximum prevention' })
  assert.equal(store.list({ query: 'Useful' }).items[0].scoreBreakdown.frictionPoints, 20)
  assert.ok(store.list().items.every(item => item.score >= 0 && item.score <= 100))
  provider.db.prepare('UPDATE recall_events SET at=?').run(now - 8 * 86400000)
  const past = store.list({ query: 'Useful', days: 7 }).items[0]
  assert.equal(past.score, 30, 'window excludes usage, but prevention and priority remain')
  assert.equal(past.scoreBreakdown.recallPoints, 0)
  assert.equal(store.list({ query: 'Useful', days: 0 }).items[0].recalls, 10)
  await provider.archive(useful.id)
  assert.equal(store.list().total, 2)
})
