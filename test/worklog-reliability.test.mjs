import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { defaults, capture } from '../worklog/domain.js'
import { partition, nextBatch, finishBatch } from '../worklog/batches.js'
import { sourcePage, sourceDetail, daySummary, excludeSources, sourceRoutes } from '../worklog/sources.js'
import { recoverDay } from '../worklog/recovery.js'
import { generate } from '../worklog/generator.js'

const before = Date.parse('2026-10-14T12:00Z'), due = Date.parse('2026-10-15T15:00Z'), later = Date.parse('2026-10-16T01:00Z')
const day = '2026-10-15', config = { ...defaults, enabled: true, scope: 'all', provider: 'p', model: 'm' }
const setup = t => { const s = new Store(':memory:'); s.configure(config); t.after(() => s.close()); return s }
function many(s, n = 14) { for (let i = 0; i < n; i++) s.note(day, `素材${i}：` + '文'.repeat(15900), '/project') }

test('delegated children are skipped while ordinary forks and parent summaries remain', () => {
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '任务' }] } }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '工作成果' }] } } }]
  const session = { id: 's', header: { cwd: '/p', parentSession: 'parent', origin: 'subagent' }, snapshotEvents: () => events }
  assert.equal(capture(session, 1, config), null)
  delete session.header.origin
  assert.equal(capture(session, 1, config).captureKind, 'conversation')
  delete session.header.parentSession
  assert.equal(capture(session, 1, config).answer, '工作成果')
})

test('oversized days enqueue without clipping and commit only after final merge', async t => {
  const s = setup(t); many(s)
  const id = s.enqueue(day), seen = [], w = new Worker(s, {}, async (_, payload) => {
    seen.push(payload); return '# 结果 ' + payload.records.map(r => `[依据:${r.id}]`).join('')
  }); t.after(() => w.close())
  await w.tick(); assert.equal(s.report(day).revision, 0)
  assert.equal(s.progress(s.job(id)).completed, 1)
  for (let i = 0; i < 10 && s.job(id).status !== 'done'; i++) await w.tick()
  assert.equal(s.job(id).status, 'done')
  assert.equal(s.report(day).covered.length, 14)
  assert.equal(seen.filter(p => !p.material).flatMap(p => p.records).length, 14)
  assert.ok(seen.every(p => JSON.stringify(p.material || p.records).length <= 90000))
  assert.ok(seen.at(-1).material)
})

test('checkpoint survives restart and failed batch retry does not repeat successful leaves', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-batches-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  let s = new Store(join(dir, 'db')); s.configure(config); many(s)
  const id = s.enqueue(day), completedIds = []
  let w = new Worker(s, {}, async (_, p) => { completedIds.push(...p.records.map(r => r.id)); return '已完成' })
  await w.tick(); await w.close(); s.close()
  s = new Store(join(dir, 'db'))
  let failed = true, subsequent = []
  w = new Worker(s, {}, async (_, p) => { if (failed) throw Error('offline'); subsequent.push(p); return '恢复成功' })
  try {
    for (let i = 0; i < 3; i++) { await w.tick(); const j = s.job(id); if (i < 2) s.status(id, 'queued', JSON.parse(j.body), j.attempts, 0) }
    assert.equal(s.job(id).status, 'failed'); assert.equal(s.progress(s.job(id)).completed, 1)
    const retry = s.retry(id); failed = false
    for (let i = 0; i < 10 && s.job(retry).status !== 'done'; i++) await w.tick()
    assert.equal(s.job(retry).status, 'done')
    assert.ok(subsequent.filter(p => !p.material).flatMap(p => p.records).every(r => !completedIds.includes(r.id)))
  } finally { await w.close(); s.close() }
})

test('exclude or edit between batches stops the job without overwriting the report', async t => {
  for (const edit of [false, true]) {
    const s = setup(t); many(s); const id = s.enqueue(day)
    const w = new Worker(s, {}, async () => '结果'); t.after(() => w.close())
    await w.tick()
    if (edit) s.save(day, '人工正文', 0)
    else s.exclude(s.records(day)[0].id, true)
    await w.tick(); assert.equal(s.job(id).status, 'failed')
    assert.equal(s.report(day).markdown, edit ? '人工正文' : '')
  }
})

test('cancelling while a batch runs cannot checkpoint or publish', async t => {
  const s = setup(t); many(s); const id = s.enqueue(day)
  const w = new Worker(s, {}, async () => { w.cancel(id); return '不可写入' }); t.after(() => w.close())
  await w.tick(); assert.equal(s.job(id).status, 'cancelled'); assert.equal(s.report(day).revision, 0)
  assert.equal(s.progress(s.job(id)).completed, 0)
})

test('preflight failure persists, survives schedule changes, and is recoverable after fixing settings', t => {
  const s = setup(t)
  s.configure({ ...config, provider: '', model: '', scheduleEnabled: true }, before)
  s.note(day, '工作'); s.schedule(due)
  assert.equal(s.detail(day).job.status, 'failed'); assert.ok(s.overview().failedDays.includes(day))
  assert.equal(s.scheduleState().last.status, 'failed')
  s.configure({ ...config, scheduleEnabled: true, scheduleTime: '23:45' }, later)
  s.schedule(later)
  assert.equal(s.detail(day).job.status, 'queued')
  assert.equal(s.scheduleState().catchupSince, before)
})

test('unchanged preflight never spins; legacy failure is materialized on reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-preflight-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  let s = new Store(join(dir, 'db'))
  s.configure({ ...config, provider: '', model: '', scheduleEnabled: true }, before); s.note(day, '工作')
  s.setMeta('schedule', { since: before, last: { day, time: due, status: 'failed', message: '旧失败' } }); s.close()
  s = new Store(join(dir, 'db'))
  try {
    assert.equal(s.detail(day).job.status, 'failed')
    s.schedule(later); const count = s.db.prepare('SELECT count(*) AS n FROM jobs').get().n
    s.schedule(later + 60000); s.schedule(later + 120000)
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM jobs').get().n, count)
  } finally { s.close() }
})

test('backfill is bounded, opt-out and protects cancelled, edited and completed days', t => {
  const s = setup(t); s.configure({ ...config, scheduleEnabled: true }, before)
  for (const d of ['2026-09-01','2026-10-13','2026-10-14','2026-10-15']) s.note(d, '工作')
  s.save('2026-10-14', '人工', 0)
  const id = s.enqueue(day); s.status(id, 'cancelled', JSON.parse(s.job(id).body))
  assert.equal(recoverDay(s, s.scheduleState(), later), undefined)
  s.note('2026-10-16', '新增'); const now = Date.parse('2026-10-17T01:00Z')
  s.configure({ ...s.config(), scheduleCatchup: false }, now)
  assert.equal(recoverDay(s, s.scheduleState(), now), undefined)
  s.configure({ ...s.config(), scheduleCatchup: true }, now)
  assert.equal(recoverDay(s, s.scheduleState(), now), '2026-10-16')
  assert.equal(recoverDay(s, s.scheduleState(), now + 30000), undefined)
})

test('transient historical failures have at most two bounded compensation rounds', t => {
  const s = setup(t); s.configure({ ...config, scheduleEnabled: true }, before); s.note(day, '工作')
  let id = s.enqueue(day)
  for (let n = 0; n < 3; n++) {
    const p = JSON.parse(s.job(id).body)
    s.status(id, 'failed', { ...p, failedAt: due, diagnostic: { retryable: true } }, 3, due)
    const recovered = recoverDay(s, s.scheduleState(), later)
    assert.equal(recovered, n < 2 ? day : undefined)
    id = s.detail(day).job.id
  }
})

test('paged summaries omit full bodies; full evidence and history are fetched independently', t => {
  const s = setup(t); many(s, 65)
  const first = sourcePage(s, new URLSearchParams({ day, sort: 'size' }))
  assert.equal(first.records.length, 30); assert.equal(first.total, 65)
  assert.ok(first.records.every(r => !('answer' in r) && r.preview.length <= 120))
  const second = sourcePage(s, new URLSearchParams({ day, page: '1' }))
  assert.equal(second.records.length, 30)
  assert.equal(daySummary(s, day).records, undefined)
  assert.equal(sourceDetail(s, first.records[0].id).answer.length, 15904 + String(0).length)
  s.save(day, '历史正文', 0); s.save(day, '当前正文', 1)
  const history = sourceRoutes(s, 'GET', '/history', {}, new URLSearchParams({ day }))
  assert.equal(history.length, 1); assert.equal(history[0].markdown, undefined)
  assert.equal(sourceRoutes(s, 'GET', '/history', {}, new URLSearchParams({ day, id: history[0].id })).markdown, '历史正文')
})

test('server search handles Chinese/literal wildcards, ranges and reversible atomic batches', t => {
  const s = setup(t); s.note(day, '测试 %_ 字面量', '/a'); s.note('2026-10-14', '另一工作', '/b')
  const q = new URLSearchParams({ from: '2026-10-14', to: day, search: '%_' })
  const hit = sourcePage(s, q); assert.equal(hit.total, 1)
  const ids = hit.records.map(r => r.id)
  assert.throws(() => excludeSources(s, { ids: [...ids, 'missing'], excluded: true }), /不存在/)
  assert.equal(sourceDetail(s, ids[0]).excluded, false)
  excludeSources(s, { ids, excluded: true }); assert.equal(daySummary(s, day).included, 0)
  excludeSources(s, { ids, excluded: false }); assert.equal(daySummary(s, day).included, 1)
  q.set('search', '另一'); assert.equal(sourcePage(s, q).records[0].project, '/b')
})

test('partial and merge prompts preserve original identity validation', async () => {
  let request
  const llm = { async *stream(input) { request = input; yield { type: 'text-delta', text: '成果 [依据:a]' } } }
  const output = await generate(llm, { route: {}, records: [{ id: 'a' }], material: [{ ids: ['a'], text: '事实' }], partial: true }, new AbortController().signal)
  assert.equal(output, '成果 [依据:a]'); assert.equal(request.maxTokens, 2200)
  assert.match(request.system, /分批整理/); assert.match(request.messages[0].content[0].text, /事实/)
  await assert.rejects(generate(llm, { route: {}, records: [{ id: 'b' }], material: [] }, new AbortController().signal), /引用校验/)
})

test('partition never drops records and rejects an indivisible oversized source', () => {
  const items = Array.from({ length: 100 }, (_, id) => ({ id, text: 'x'.repeat(1000) }))
  assert.deepEqual(partition(items).flat(), items)
  assert.throws(() => partition([{ text: 'x'.repeat(100000) }]), /单条/)
})
