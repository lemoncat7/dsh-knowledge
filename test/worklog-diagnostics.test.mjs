import test from 'node:test'
import assert from 'node:assert/strict'
import { generate } from '../worklog/generator.js'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'

test('generation identifies invalid references without exposing content', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', text: 'private text [依据:a,b]' } } }
  await assert.rejects(generate(llm, { records: [{ id: 'a' }] }, new AbortController().signal), error => {
    assert.equal(error.worklogDiagnostic.code, 'invalid_reference')
    assert.equal(error.worklogDiagnostic.groupedReference, true)
    assert.ok(!JSON.stringify(error.worklogDiagnostic).includes('private'))
    return true
  })
})

test('worker persists and logs safe diagnostic metadata', async () => {
  const store = new Store(':memory:')
  store.insert({ id: 'a', day: '2026-10-09', project: '', route: { provider: 'p', model: 'm' } })
  const id = store.enqueue('2026-10-09'), logs = []
  const worker = new Worker(store, { async *stream() {} }, undefined, value => logs.push(value))
  try {
    await worker.tick()
    const payload = JSON.parse(store.job(id).body)
    assert.equal(payload.diagnostic.code, 'empty')
    assert.match(payload.error, /未返回日报正文/)
    assert.equal(logs[0].attempt, 1)
  } finally { await worker.close(); store.close() }
})
