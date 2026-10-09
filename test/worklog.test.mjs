import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { capture, dayOf, defaults, settings, validDay } from '../worklog/domain.js'
import { authorize, handler } from '../worklog/http.js'
import { generate } from '../worklog/generator.js'
import { createServer } from 'node:http'

const day = '2026-09-29'
const record = (id = 's:1') => ({ id, day, time: 1790640000000, project: '/project', sessionId: 's', turn: 1, user: '修复问题', answer: '已修复并测试', route: { provider: 'p', model: 'm' } })
function db(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store }

test('opt in and exact scope, timezone boundary, invalid date', () => {
  assert.equal(dayOf('2026-09-28T17:00:00Z', 'Asia/Shanghai'), day)
  assert.throws(() => validDay('2026-02-30'))
  assert.throws(() => settings({ ...defaults, projects: [5] }))
  const session = { id: 's', header: { cwd: '/project' }, snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '修复' }] } },
    { type: 'assistant/message', data: { turn: 1, message: { source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: '完成' }] } } },
  ] }
  assert.equal(capture(session, 1, defaults), null)
  const config = { ...defaults, enabled: true, projects: ['/project'] }
  assert.equal(capture(session, 1, config).answer, '完成')
  assert.equal(capture(session, 1, { ...config, excludedSessions: ['s'] }), null)
  assert.equal(capture(session, 2, config), null)
  assert.equal(settings({ ...defaults, scope: undefined }).scope, 'selected')
  assert.throws(() => settings({ ...defaults, scope: 'invalid' }))
  const all = { ...config, projects: [], scope: 'all' }
  assert.equal(capture(session, 1, all).answer, '完成')
  assert.equal(capture(session, 1, { ...all, enabled: false }), null)
  assert.equal(capture(session, 1, { ...all, excludedSessions: ['s'] }), null)
  assert.equal(capture(session, 1, { ...all, scope: undefined }), null)
})
test('dedup, source exclusions, notes and report versions', t => {
  const s = db(t); s.insert(record()); s.insert(record())
  assert.equal(s.records(day).length, 1)
  s.save(day, '# 日报', 0, ['s:1'], false)
  s.save(day, '# 人工编辑', 1)
  assert.throws(() => s.save(day, '过期编辑', 1), /已被修改/)
  assert.throws(() => s.enqueue(day), /手工修改/)
  s.note(day, '补充工作')
  assert.equal(s.detail(day).pending, 1)
  s.exclude('s:1', true); assert.equal(s.records(day).length, 1)
  assert.equal(s.detail(day).history.length, 1)
})
test('manual-only days can use an explicitly configured model', t => {
  const s = db(t); s.configure({ ...defaults, provider: 'local', model: 'daily' })
  s.note(day, '完成验收')
  const id = s.enqueue(day)
  assert.deepEqual(JSON.parse(s.job(id).body).route, { provider: 'local', model: 'daily' })
  assert.throws(() => settings({ ...defaults, timezone: 'Bad/Timezone' }), /有效的 IANA/)
  assert.throws(() => settings({ ...defaults, provider: 'local' }), /同时填写/)
})
test('durable queued work survives restart, running is recovered', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'worklog-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'work.sqlite'); let s = new Store(path)
  s.insert(record()); const id = s.enqueue(day); assert.equal(s.enqueue(day), id)
  s.status(id, 'running', JSON.parse(s.job(id).body)); s.close()
  s = new Store(path); assert.equal(s.job(id).status, 'queued')
  const worker = new Worker(s, {}, async () => '# 已完成\n修复问题')
  await worker.tick(); assert.equal(s.job(id).status, 'done'); assert.equal(s.detail(day).pending, 0)
  await worker.close(); s.close()
})
test('generation never overwrites a newer manual edit', async t => {
  const s = db(t); s.insert(record()); const id = s.enqueue(day)
  const w = new Worker(s, {}, async () => { s.save(day, '人工正文', 0); return '模型正文' })
  await w.tick(); assert.equal(s.report(day).markdown, '人工正文'); assert.equal(s.job(id).status, 'failed'); await w.close()
})
test('sources excluded during generation invalidate result', async t => {
  const s = db(t); s.insert(record()); const id = s.enqueue(day)
  const w = new Worker(s, {}, async () => { s.exclude('s:1', true); return '模型正文' })
  await w.tick(); assert.equal(s.report(day).revision, 0); assert.equal(s.job(id).status, 'failed'); await w.close()
})
test('new arrivals remain pending, cancellation does not save', async t => {
  const s = db(t); s.insert(record()); s.enqueue(day)
  let w = new Worker(s, {}, async () => { s.insert(record('s:2')); return '模型正文' })
  await w.tick(); assert.equal(s.detail(day).pending, 1); await w.close()
  const id = s.enqueue(day)
  w = new Worker(s, {}, async () => { w.cancel(id); return '不应保存' })
  await w.tick(); assert.equal(s.job(id).status, 'cancelled'); assert.equal(s.report(day).markdown, '模型正文'); await w.close()
})
test('failed jobs retry with bounded attempts and preserve last valid report', async t => {
  const s = db(t); s.insert(record()); s.save(day, '已有日报', 0, [], false); const id = s.enqueue(day)
  const w = new Worker(s, {}, async () => { throw new Error('secret network detail') })
  for (let i = 0; i < 3; i++) { await w.tick(); const j = s.job(id); if (i < 2) s.status(id, 'queued', JSON.parse(j.body), j.attempts, 0) }
  assert.equal(s.job(id).status, 'failed'); assert.equal(s.report(day).markdown, '已有日报')
  assert.ok(!s.job(id).body.includes('secret network detail'))
  assert.notEqual(s.retry(id), id); await w.close()
})
test('browser and official loopback desktop origin checks', () => {
  const request = headers => ({ headers: { 'x-dsh-worklog-client': 'workspace', host: 'localhost:3080', ...headers } })
  authorize(request({ origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' }))
  authorize(request({ origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' }))
  assert.throws(() => authorize(request({ origin: 'https://evil.example' })))
  assert.throws(() => authorize(request({ origin: 'dsh-app://app', host: 'public.example' })))
  assert.throws(() => authorize({ headers: {} }))
})
test('generator uses deltas once and rejects invented evidence', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', text: '完成 [依据:s:1]' }; yield { type: 'block-end', block: { type: 'text', text: '完成 [依据:s:1]' } } } }
  assert.equal(await generate(llm, { records: [record()], route: {} }, new AbortController().signal), '完成 [依据:s:1]')
  await assert.rejects(generate(llm, { records: [], route: {} }, new AbortController().signal), /来源引用校验失败/)
})
test('HTTP serves JSON errors and supports notes/settings', async t => {
  const s = db(t), w = new Worker(s, {}), server = createServer(handler(s, w, () => undefined))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/worklog-control/v1`
  let r = await fetch(`${base}/state`); assert.equal(r.status, 403); assert.ok((await r.json()).error)
  const headers = { 'x-dsh-worklog-client': 'workspace', 'content-type': 'application/json' }
  r = await fetch(`${base}/note`, { method: 'POST', headers, body: JSON.stringify({ day, text: '完成测试' }) }); assert.equal(r.status, 200)
  r = await fetch(`${base}/day?day=${day}`, { headers }); assert.equal((await r.json()).records.length, 1)
  r = await fetch(`${base}/settings`, { method: 'POST', headers, body: '{}' }); assert.equal(r.status, 400)
})
test('custom API fails closed without Host authentication', async t => {
  const s = db(t), w = new Worker(s, {}), server = createServer(handler(s, w))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/worklog-control/v1/state`, { headers: { 'x-dsh-worklog-client': 'workspace' } })
  assert.equal(response.status, 401)
  assert.match((await response.json()).error, /登录/)
})
