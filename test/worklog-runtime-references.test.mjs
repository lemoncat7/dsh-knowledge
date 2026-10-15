import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../lib/worklog-runtime.js'

test('bundled runtime normalizes grouped references and preserves reports on invalid sources', async t => {
  let cleanup, calls = 0, invalid = false
  const service = apply({
    on() {}, inject() {},
    effect(factory, key) { if (key === 'worklog.close') cleanup = factory() },
    logger: { warn() {} },
    llm: {
      listProviders: () => [], listModels: async () => [],
      async *stream(request) {
        calls++
        const records = JSON.parse(request.messages[0].content[0].text)
        yield { type: 'text-delta', text: `完成 [依据: ${records[0].id}， ${invalid ? 'missing-source' : records[1].id} ]` }
      },
    },
  }, { databasePath: ':memory:' })
  t.after(() => cleanup())
  const day = '2026-10-15', api = service.dispatch
  const state = await api('GET', '/state')
  await api('POST', '/settings', { ...state.config, sharedRevision: state.sharedRevision, provider: 'test', model: 'test', scheduleEnabled: false })
  for (const text of ['测试素材一', '测试素材二']) await api('POST', '/note', { day, text })
  async function completed(id) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const value = await api('GET', '/day', {}, new URLSearchParams({ day }))
      if (value.job?.id === id && ['done', 'failed'].includes(value.job.status)) return value
      await delay(20)
    }
    assert.fail('Isolated runtime generation did not complete')
  }
  const first = await completed((await api('POST', '/generate', { day })).id)
  assert.equal(first.job.status, 'done')
  assert.equal(first.job.attempts, 1)
  assert.equal(first.report.covered.length, 2)
  const references = [...first.report.markdown.matchAll(/\[依据:([^\]]+)\]/g)].map(match => match[1])
  assert.equal(references.length, 2)
  for (const id of references) assert.ok(first.records.some(record => record.id === id))
  invalid = true
  await api('POST', '/note', { day, text: '追加测试素材' })
  const second = await completed((await api('POST', '/generate', { day })).id)
  assert.equal(second.job.status, 'failed')
  assert.equal(second.job.attempts, 1)
  assert.equal(calls, 2)
  assert.match(JSON.parse(second.job.body).error, /已停止自动重试/)
  assert.equal(second.report.markdown, first.report.markdown)
})
