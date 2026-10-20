import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generate } from '../worklog/generator.js'
import { referenceContext, privateFailure } from '../worklog/reference-context.js'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { handler } from '../worklog/http.js'
import { daySummary, failureDetail } from '../worklog/sources.js'
import { nextBatch, finishBatch, prepareBatches } from '../worklog/batches.js'

const day = '2026-10-20', quote = '修复了来源引用编号并通过验证'
const records = Array.from({ length: 42 }, (_, i) => ({ id: `source-${String(i).padStart(64, '0')}`, day, project: '/project', user: '核验来源引用', answer: quote, route: { provider: 'test', model: 'test' } }))
const signal = () => new AbortController().signal
const response = text => ({ type: 'text-delta', text })
const input = request => JSON.parse(request.messages[0].content[0].text)
const payload = { records, route: { provider: 'test', model: 'test' } }

test('42 long source IDs become short aliases and restore deterministically', async () => {
  let calls = 0
  const llm = { async *stream(request) {
    calls++
    const material = input(request)
    assert.equal(material[0].id, 'R001'); assert.equal(material[41].id, 'R042')
    assert.ok(!JSON.stringify(material).includes(records[0].id))
    yield response('已验证 [依据:R042,R001]')
  } }
  assert.equal(await generate(llm, payload, signal()), `已验证 [依据:${records[41].id}][依据:${records[0].id}]`)
  assert.equal(calls, 1)
})

test('one evidence-backed marker repair preserves all prose and existing valid sources', async () => {
  let calls = 0
  const llm = { async *stream(request) {
    if (++calls === 1) yield response('## 概览\n已验证 [依据:R001]\n修复引用 [依据:R002,R999]')
    else {
      const { issues, material } = input(request)
      assert.equal(material.length, 42); assert.equal(issues.length, 1)
      yield response(JSON.stringify({ repairs: [{ index: issues[0].index, sources: [{ id: 'R002', quote }, { id: 'R003', quote }] }] }))
    }
  } }
  assert.equal(await generate(llm, payload, signal()), `## 概览\n已验证 [依据:${records[0].id}]\n修复引用 [依据:${records[1].id}][依据:${records[2].id}]`)
  assert.equal(calls, 2)
})

for (const kind of ['rewrite', 'remove', 'fake_quote', 'invalid_id', 'drop_known', 'duplicate']) test(`unsafe correction rejected: ${kind}`, async () => {
  let calls = 0
  const llm = { async *stream(request) {
    if (++calls === 1) yield response('不能丢失的事项 [依据:R001,R999]')
    else {
      const { issues } = input(request)
      const repair = { index: issues[0].index, sources: [{ id: 'R001', quote }] }
      if (kind === 'rewrite') { yield response('没有引用的新正文'); return }
      if (kind === 'fake_quote') repair.sources[0].quote = '完全不存在的原始证据片段'
      if (kind === 'invalid_id') repair.sources[0].id = 'R888'
      if (kind === 'drop_known') repair.sources[0].id = 'R002'
      yield response(JSON.stringify({ repairs: kind === 'remove' ? [] : kind === 'duplicate' ? [repair, repair] : [repair] }))
    }
  } }
  await assert.rejects(generate(llm, payload, signal()), error => {
    assert.equal(error.worklogDiagnostic.retryable, false)
    assert.equal(error.worklogFailure.repairAttempted, true)
    assert.equal(error.worklogFailure.issues[0].line, 1)
    assert.ok(!JSON.stringify(error.worklogDiagnostic).includes('R999'))
    return true
  })
  assert.equal(calls, 2)
})

test('ambiguous unclosed markers do not swallow prose through automatic repair', async () => {
  let calls = 0
  await assert.rejects(generate({ async *stream() { calls++; yield response('事项 [依据:R001\n后续重要正文') } }, payload, signal()), error => {
    assert.equal(error.worklogFailure.repairAttempted, false)
    assert.equal(error.worklogFailure.repairResult, 'ambiguous_format')
    return true
  })
  assert.equal(calls, 1)
})

test('bounded details and credentials redaction', () => {
  const result = privateFailure({ total: 1, issues: [{ line: 2, reference: 'token=abc12345', excerpt: 'password=hunter222 Bearer abc.def-123 sk-hidden123', code: 'invalid_reference' }] })
  for (const secret of ['abc12345', 'hunter222', 'abc.def-123', 'sk-hidden123']) assert.ok(!JSON.stringify(result).includes(secret))
})

test('abort during repair keeps diagnostics, never makes a third request', async () => {
  const controller = new AbortController(); let calls = 0
  const llm = { async *stream(request) {
    assert.equal(request.signal, controller.signal)
    if (++calls === 1) yield response('事项 [依据:R999]')
    else { controller.abort(new Error('timeout')); throw controller.signal.reason }
  } }
  await assert.rejects(generate(llm, payload, controller.signal), error => error.worklogFailure.repairResult === 'timeout_or_cancelled' && error.worklogDiagnostic.retryable === false)
  assert.equal(calls, 2)
})

test('batch summaries persist real IDs and merges remap text plus ids together', async () => {
  const p = { ...payload, records: records.map(record => ({ ...record, answer: quote.repeat(400) })) }
  prepareBatches(p)
  let merged = false, steps = 0
  for (;;) {
    const step = nextBatch(p)
    const result = await generate({ async *stream(request) {
      const material = input(request)
      if (step.payload.material) {
        merged = true
        assert.ok(material.every(item => item.ids.every(id => /^R\d+$/.test(id))))
        assert.ok(material.every(item => !item.text.includes('source-')))
      }
      yield response(`验证完成 [依据:${material[0].id || material[0].ids[0]}]`)
    } }, step.payload, signal())
    assert.ok(result.includes('[依据:source-'))
    if (finishBatch(p, step, result)) break
    assert.ok(++steps < 100)
  }
  assert.ok(merged)
  const ctx = referenceContext({ records: [records[3]], material: [{ text: `事实 [依据:${records[3].id}]`, ids: [records[3].id] }] })
  assert.equal(ctx.material[0].text, '事实 [依据:R001]')
})

test('worker keeps private details off logs and summary; authorized API pages sources', async t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  for (const record of records) store.insert(record)
  store.save(day, '保留原日报', 0, [], false)
  const job = store.enqueue(day), logs = []
  const worker = new Worker(store, { async *stream() { yield response('敏感正文 [依据:R999]') } }, undefined, value => logs.push(value))
  t.after(() => worker.close())
  await worker.tick(); await worker.tick()
  assert.equal(store.job(job).status, 'failed')
  assert.equal(store.report(day).markdown, '保留原日报')
  assert.ok(!JSON.stringify(logs).includes('敏感正文'))
  assert.ok(!JSON.stringify(daySummary(store, day)).includes('R999'))
  assert.equal(failureDetail(store, new URLSearchParams({ day, id: job })).sources.length, 30)
  assert.equal(failureDetail(store, new URLSearchParams({ day, id: job, page: 1 })).sources[0].alias, 'R031')
  assert.throws(() => failureDetail(store, new URLSearchParams({ day: '2026-10-19', id: job })), /不存在/)
  let authorized = false
  const server = createServer(handler(store, worker, () => authorized ? undefined : 401))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/worklog-control/v1/failure?day=${day}&id=${job}`
  const options = { headers: { 'x-dsh-worklog-client': 'workspace' } }
  assert.equal((await fetch(url, options)).status, 401)
  authorized = true
  assert.equal((await fetch(url)).status, 403)
  assert.equal((await fetch(url, { headers: { ...options.headers, origin: 'https://evil.example' } })).status, 403)
  const result = await (await fetch(url, options)).json()
  assert.equal(result.detail.issues[0].reference, 'R999')
  const saved = JSON.parse(store.job(job).body); delete saved.failure
  store.status(job, 'failed', saved)
  assert.equal(failureDetail(store, new URLSearchParams({ day, id: job })).detail, null)
})
