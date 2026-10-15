import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { WritebackQueue } from '../lib/writeback/queue.js'

const draft = { knowledgeBaseId: 'default', group: '测试', title: '分页测试', body: '正文', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .9 }
async function fixture(t) {
  const provider = new LocalKnowledgeProvider(':memory:')
  t.after(() => provider.close())
  return provider
}
function seed(provider, count = 105) {
  const put = provider.db.prepare(`INSERT INTO knowledge_candidates(id,action,status,draft_json,reason,created_at,proposal_hash) VALUES(?,'create',?,?,?,? ,?)`)
  for (let i = 0; i < count; i++) put.run(`c${String(i).padStart(4, '0')}`, 'approved', JSON.stringify({ ...draft, title: `记录${i}` }), '', '2026-10-15T00:00:00.000Z', `hash${i}`)
  put.run('pending', 'pending', JSON.stringify(draft), '', '2026-10-15T00:00:00.000Z', 'hash-pending')
  put.run('rejected', 'rejected', JSON.stringify(draft), '', '2026-10-15T00:00:00.000Z', 'hash-rejected')
}

test('candidate pages cover more than 100 records with stable tied timestamps and full counts', async t => {
  const p = await fixture(t); seed(p)
  const all = []; let cursor
  do {
    const page = p.candidatePage('approved', 20, cursor)
    assert.ok(page.items.length <= 20)
    assert.deepEqual(page.counts, { pending: 1, approved: 105, rejected: 1 })
    all.push(...page.items); cursor = page.nextCursor
  } while (cursor)
  assert.equal(all.length, 105); assert.equal(new Set(all.map(x => x.id)).size, 105)
  assert.equal(all[0].id, 'c0104'); assert.equal(all.at(-1).id, 'c0000')
  assert.equal((await p.listCandidates('approved', 5)).length, 5)
})

test('candidate cursor survives deletion or status change above boundary and rejects wrong filters', async t => {
  const p = await fixture(t); seed(p)
  const first = p.candidatePage('approved', 20)
  p.db.prepare("DELETE FROM knowledge_candidates WHERE id='c0104'").run()
  p.db.prepare("UPDATE knowledge_candidates SET status='rejected' WHERE id='c0103'").run()
  const second = p.candidatePage('approved', 20, first.nextCursor)
  assert.equal(second.items[0].id, 'c0084')
  assert.equal(second.total, 103)
  assert.throws(() => p.candidatePage('rejected', 20, first.nextCursor), { status: 400 })
  assert.throws(() => p.candidatePage('approved', 20, 'invalid!'), { status: 400 })
})

test('notes page by folder then case-insensitive name without fetching file contents', async t => {
  const p = await fixture(t)
  const folder = await p.notes.createFolder('z-folder', null)
  for (let i = 0; i < 45; i++) await p.notes.createDocument(`note-${String(i).padStart(3, '0')}.md`, null, '# body')
  await p.notes.createDocument('other.md', folder.id, 'hidden')
  const first = p.notes.listPage({ limit: 20 })
  assert.equal(first.total, 46); assert.equal(first.items[0].id, folder.id)
  assert.ok(first.items.every(node => !Object.hasOwn(node, 'content')))
  // An insertion ahead of the cursor cannot shift or duplicate the next page.
  await p.notes.createDocument('000-new.md', null, '')
  const second = p.notes.listPage({ limit: 20 }, first.nextCursor)
  assert.equal(second.items[0].name, 'note-019.md')
  assert.equal(second.total, 47)
  const last = p.notes.listPage({ limit: 20 }, second.nextCursor)
  assert.equal(last.items.length, 6); assert.equal(last.nextCursor, undefined)
  assert.equal(new Set([...first.items, ...second.items, ...last.items].map(n => n.id)).size, 46)
  assert.throws(() => p.notes.listPage({ parentId: folder.id, limit: 20 }, first.nextCursor), { status: 400 })
  const search = p.notes.listPage({ query: 'note-', limit: 20 })
  assert.equal(search.total, 45)
  assert.equal(p.notes.listPage({ query: 'note-', limit: 20 }, search.nextCursor).items.length, 20)
  assert.throws(() => p.notes.listPage({ query: 'other', limit: 20 }, search.nextCursor), { status: 400 })
})

test('HTTP opt-in pages retain legacy list shapes and expose all counts without broad stats', async t => {
  const p = await fixture(t); seed(p)
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } } }, p, '/api', { authMode: 'same-origin' })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const get = async path => fetch(base + path, { headers: { 'x-dsh-knowledge-client': 'management-web' } })
  const first = await (await get('/candidates?status=approved&limit=20&paged=1&includeTargets=1')).json()
  assert.equal(first.items.length, 20); assert.equal(first.total, 105); assert.deepEqual(first.targets, [])
  const second = await (await get(`/candidates?status=approved&limit=20&paged=1&cursor=${first.nextCursor}`)).json()
  assert.equal(second.items[0].id, 'c0084')
  assert.ok(Array.isArray(await (await get('/candidates?status=approved&limit=20')).json()))
  assert.ok(Array.isArray(await (await get('/notes')).json()))
  assert.deepEqual(await (await get('/notes?paged=1')).json(), { items: [], total: 0 })
  assert.equal((await get('/notes?paged=1&cursor=bad!')).status, 400)
})

test('writeback history cursor tolerates new jobs; watched statuses remain live and bounded', async t => {
  const queue = new WritebackQueue(':memory:', async () => ({ status: 'completed', summary: 'done', retryable: false }))
  t.after(() => queue.close())
  const put = queue.db.prepare("INSERT INTO queue_jobs(source_key,session_id,status,view) VALUES(?,?,'completed',?)")
  for (let i = 1; i <= 75; i++) put.run('job' + i, 'session', JSON.stringify({ status: 'completed', summary: 'done', retryable: false }))
  const first = queue.listPage('session')
  assert.equal(first.items.length, 30); assert.equal(first.total, 75)
  put.run('new', 'session', JSON.stringify({ status: 'completed', summary: 'new', retryable: false }))
  const second = queue.listPage('session', undefined, first.nextCursor, ['job1'])
  assert.equal(second.items[0].sourceKey, 'job45'); assert.equal(second.total, 76)
  assert.equal(second.updates[0].sourceKey, 'job1')
  const last = queue.listPage('session', undefined, second.nextCursor)
  assert.equal(last.items.length, 15); assert.equal(last.nextCursor, undefined)
  assert.throws(() => queue.listPage('different', undefined, first.nextCursor), { status: 400 })
})
