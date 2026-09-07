import assert from 'node:assert/strict'
import test from 'node:test'
import { WritebackStatusClient } from '../lib/writeback/status-client.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const failed = { status: 'failed', summary: '回写失败', retryable: true }
const queued = { status: 'queued', summary: '等待回写', retryable: false }
const completed = { status: 'completed', summary: '回写成功', retryable: false }
const response = body => new Response(JSON.stringify(body), { status: 200 })

test('default transport preserves the browser global fetch receiver', async t => {
  const original = globalThis.fetch
  const changes = []
  globalThis.fetch = async function () {
    assert.equal(this, globalThis, 'Window.fetch rejects an instance as its receiver')
    return response(completed)
  }
  const client = new WritebackStatusClient('/status', value => changes.push(value))
  t.after(() => { client.dispose(); globalThis.fetch = original })
  client.refresh(); await tick()
  assert.equal(changes.at(-1)?.status, 'completed')
})

test('status read errors are visible without falsely marking the writeback failed, and clear on recovery', async t => {
  let fail = true
  const changes = []
  const client = new WritebackStatusClient('/status', (value, pending, error) => changes.push({ value, error }), async () => {
    if (fail) throw new Error('network offline')
    return response(completed)
  })
  t.after(() => client.dispose())
  client.refresh(); await tick()
  assert.equal(changes.at(-1).value, undefined)
  assert.match(changes.at(-1).error, /不代表回写失败/)
  fail = false
  client.refresh(); await tick()
  assert.equal(changes.at(-1).value.status, 'completed')
  assert.equal(changes.at(-1).error, undefined)
})

test('retry feedback is immediate, double click is ignored and late GET cannot overwrite POST', async t => {
  const changes = [], calls = []
  let lateGet, post
  const client = new WritebackStatusClient('/status', (value, pending) => changes.push({ value, pending }), async (_url, init) => {
    calls.push(init.method)
    if (calls.length === 1) return response(failed)
    if (init.method === 'GET') return new Promise(resolve => { lateGet = resolve })
    return new Promise(resolve => { post = resolve })
  })
  t.after(() => client.dispose())
  client.refresh(); await tick()
  client.refresh(); client.retry(); client.retry()
  assert.equal(changes.at(-1).pending, true)
  assert.deepEqual(calls, ['GET', 'GET', 'POST'])
  post(response(queued)); await tick()
  lateGet(response(failed)); await tick()
  assert.deepEqual(changes.at(-1), { value: queued, pending: false })
})

test('polling resumes after retry and pauses while hidden', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const changes = []
  const client = new WritebackStatusClient('/status', value => changes.push(value), async () => response([failed, queued, completed][calls++]))
  t.after(() => client.dispose())
  client.refresh(); await tick()
  client.retry(); await tick()
  client.setVisible(false)
  t.mock.timers.tick(60000); await tick()
  assert.equal(calls, 2)
  client.setVisible(true); await tick()
  assert.equal(changes.at(-1).status, 'completed')
  t.mock.timers.tick(60000); await tick()
  assert.equal(calls, 3)
})

test('temporary status transport failure does not permanently stop polling; disposal prevents stale updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const changes = []
  const client = new WritebackStatusClient('/status', value => changes.push(value), async () => { if (++calls === 1) throw new Error('offline'); return response(completed) })
  client.refresh(); await tick()
  t.mock.timers.tick(2000); await tick()
  assert.equal(changes.at(-1).status, 'completed')
  client.dispose()
  client.refresh(); client.retry(); t.mock.timers.tick(60000); await tick()
  assert.equal(calls, 2)
})
