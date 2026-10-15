import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeReferences } from '../worklog/references.js'
import { generate } from '../worklog/generator.js'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { createCentral, sourceKey } from '../worklog/central.js'

const ids = new Set(['s:1', 's:2', 'source-abc'])
const day = '2026-10-15'
const llmFor = output => ({ async *stream() { yield { type: 'text-delta', text: output } } })

test('issue 16: grouped references normalize to independent exact source markers', () => {
  for (const separator of [', ', '，', '、', ';', '；', ' ', '\n', '\t', '， ;\n']) {
    const value = `已完成 [依据: s:1${separator}s:2${separator}source-abc ]`
    assert.equal(normalizeReferences(value, ids), '已完成 [依据:s:1][依据:s:2][依据:source-abc]')
  }
  assert.equal(normalizeReferences('完成 [依据：s:1，s:2]', ids), '完成 [依据:s:1][依据:s:2]')
  assert.equal(normalizeReferences('完成 [依据:s:1][依据:s:2]', ids), '完成 [依据:s:1][依据:s:2]')
  assert.equal(normalizeReferences('完成 [依据:s:1,s:1,s:2]', ids), '完成 [依据:s:1][依据:s:2]')
})

test('exact IDs take priority over separators; body text and reference order stay intact', () => {
  const text = '# 报告\n原文、标点 ; 不改变\n事项 [依据:id,with,commas][依据:id with spaces]'
  assert.equal(normalizeReferences(text, new Set(['id,with,commas', 'id with spaces'])), text)
  assert.equal(normalizeReferences('甲 [依据:s:2,s:1]\n乙 [依据:s:1]', ids), '甲 [依据:s:2][依据:s:1]\n乙 [依据:s:1]')
})

test('invented, truncated, case-changed and range IDs are still rejected without diagnostic leakage', () => {
  for (const raw of ['s:1,secret-fake', 'S:1', 's:1-s:2', 's:1…', '`s:1`']) {
    assert.throws(() => normalizeReferences(`private body [依据:${raw}]`, ids), error => {
      assert.equal(error.worklogDiagnostic.code, 'invalid_reference')
      assert.equal(error.worklogDiagnostic.retryable, false)
      assert.ok(!JSON.stringify(error.worklogDiagnostic).includes(raw))
      assert.ok(!error.message.includes('secret-fake'))
      return true
    })
  }
})

test('empty or unclosed references produce a distinct nonretryable formatting error', () => {
  for (const value of ['[依据:]', '[依据: ,； ]', '[依据:s:1', '[依据:s:1]后续[依据：s:2']) {
    assert.throws(() => normalizeReferences(value, ids), error => error.worklogDiagnostic.code === 'invalid_reference_format' && error.worklogDiagnostic.retryable === false)
  }
})

test('generation documents multi-source syntax and normalizes block-only and delta responses', async () => {
  for (const blockOnly of [false, true]) {
    let calls = 0
    const llm = { async *stream(request) {
      calls++
      assert.match(request.system, /每个编号使用独立括号/)
      const text = '完成 [依据:s:1, s:2]'
      if (!blockOnly) yield { type: 'text-delta', text }
      yield { type: 'block-end', block: { type: 'text', text } }
    } }
    assert.equal(await generate(llm, { records: [...ids].map(id => ({ id })), route: {} }, new AbortController().signal), '完成 [依据:s:1][依据:s:2]')
    assert.equal(calls, 1)
  }
})

function fixture(t) {
  const store = new Store(':memory:')
  for (const id of ['s:1', 's:2']) store.insert({ id, day, project: '', route: { provider: 'test', model: 'test' } })
  t.after(() => store.close())
  return store
}

test('valid grouped output saves on first attempt and all source links remain independently resolvable', async t => {
  const store = fixture(t), job = store.enqueue(day)
  const worker = new Worker(store, llmFor('完成 [依据:s:1，s:2]'))
  try {
    await worker.tick()
    assert.equal(store.job(job).status, 'done')
    assert.equal(store.job(job).attempts, 1)
    assert.equal(store.report(day).markdown, '完成 [依据:s:1][依据:s:2]')
    const refs = [...store.report(day).markdown.matchAll(/\[依据:([^\]]+)\]/g)].map(match => match[1])
    assert.deepEqual(refs, ['s:1', 's:2'])
    for (const id of refs) assert.ok(store.detail(day).records.some(record => record.id === id))
  } finally { await worker.close() }
})

test('invalid source stops after one call, preserves prior report and allows explicit retry', async t => {
  const store = fixture(t)
  store.save(day, '已有有效日报', 0, [], false)
  const job = store.enqueue(day)
  let calls = 0, invalid = true
  const worker = new Worker(store, { async *stream() { calls++; yield { type: 'text-delta', text: invalid ? '完成 [依据:s:1,secret-fake]' : '完成 [依据:s:1,s:2]' } } })
  try {
    await worker.tick(); await worker.tick(); await worker.tick()
    assert.equal(calls, 1)
    assert.equal(store.job(job).status, 'failed')
    assert.equal(store.report(day).markdown, '已有有效日报')
    const payload = JSON.parse(store.job(job).body)
    assert.match(payload.error, /不存在的记录编号/)
    assert.match(payload.error, /已停止自动重试/)
    assert.ok(!payload.error.includes('secret-fake'))
    invalid = false
    const retry = store.retry(job)
    await worker.tick()
    assert.equal(store.job(retry).status, 'done'); assert.equal(calls, 2)
  } finally { await worker.close() }
})

test('normalized multi-source reports archive each source separately across instances', async t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const sourceId = 'source-instance-123456'
  const central = createCentral(store, {}, async () => [])
  for (const [index, id] of ['s:1', 's:2'].entries()) await central('POST', '/ingest', {
    sourceId, record: { id, time: Date.parse(day + 'T04:00:00Z'), project: '', sessionId: 's', turn: index + 1, user: '任务', answer: '完成' },
  })
  const markdown = await generate(llmFor('完成 [依据:s:1; s:2]'), { records: [{ id: 's:1' }, { id: 's:2' }], route: {} }, new AbortController().signal)
  await central('POST', '/archive', { sourceId, report: { day, markdown, updated: Date.now(), revision: 1 } })
  const detail = store.detail(day)
  assert.equal(detail.history[0].markdown, `完成 [依据:${sourceKey(sourceId, 's:1')}][依据:${sourceKey(sourceId, 's:2')}]`)
  for (const match of detail.history[0].markdown.matchAll(/\[依据:([^\]]+)\]/g)) assert.ok(detail.records.some(record => record.id === match[1]))
})
