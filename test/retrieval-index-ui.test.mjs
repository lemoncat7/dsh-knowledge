import test from 'node:test'
import assert from 'node:assert/strict'
import { indexStatusLabel, createRetrievalIndexStatus } from '../web/retrieval-index-status.js'

test('index progress labels do not mistake unavailable or empty state for completion', () => {
  assert.equal(indexStatusLabel(), '读取索引状态…')
  assert.equal(indexStatusLabel({ ready: 0, pending: 0, failed: 0, total: 0 }), '暂无文档需要索引')
  assert.equal(indexStatusLabel({ ready: 128, pending: 92, failed: 0, total: 220 }), '索引更新中 · 128 / 220')
  assert.equal(indexStatusLabel({ ready: 220, pending: 0, failed: 0, total: 220 }), '索引已就绪')
  assert.equal(indexStatusLabel({ ready: 128, pending: 89, failed: 3, total: 220 }), '3 篇索引失败 · 89 篇待处理')
})

const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function statusFixture(t, api, observed = true) {
  const previousDocument = globalThis.document, previousObserver = globalThis.IntersectionObserver
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  let notify
  globalThis.IntersectionObserver = observed ? class {
    constructor(callback) { notify = value => callback([{ isIntersecting: value }]) }
    observe() {}
    disconnect() {}
  } : undefined
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const element = () => ({ dataset: {}, setAttribute() {}, textContent: '' })
  const status = createRetrievalIndexStatus({ api, element, actionButton: element, interfaceIcon: () => null })
  t.after(() => { status.dispose(); globalThis.document = previousDocument; globalThis.IntersectionObserver = previousObserver })
  return { status, visible: () => notify?.(true), event: () => document.dispatchEvent(new Event('visibilitychange')) }
}

test('index status coalesces initial events and respects ready-state freshness', async t => {
  const requests = []
  const f = statusFixture(t, (_path, { signal }) => new Promise(resolve => requests.push({ resolve, signal })))
  f.status.mount(new URLSearchParams())
  assert.equal(requests.length, 0, 'detached roots do not start reads')
  assert.equal(f.status.root.dataset.state, 'loading')
  f.visible(); f.event(); f.event(); f.status.mount(new URLSearchParams())
  assert.equal(requests.length, 1)
  assert.equal(requests[0].signal.aborted, false)
  requests[0].resolve({ ready: 1, total: 1, failed: 0, pending: 0 }); await settled()
  t.mock.timers.tick(5000); f.event(); f.status.mount(new URLSearchParams())
  assert.equal(requests.length, 1, 'ready metadata is fresh for thirty seconds')
  t.mock.timers.tick(25000)
  assert.equal(requests.length, 2)
  f.status.suspend()
  assert.equal(requests[1].signal.aborted, true)
  t.mock.timers.tick(60000)
  assert.equal(requests.length, 2)
})

test('network errors back off across mount/visibility events; unsupported servers stop polling', async t => {
  let calls = 0, status = 503
  const f = statusFixture(t, async () => { calls++; throw Object.assign(Error('unavailable'), { status }) })
  f.status.mount(new URLSearchParams()); f.visible(); await settled()
  assert.equal(f.status.root.dataset.state, 'unavailable')
  t.mock.timers.tick(5000); f.event(); f.status.mount(new URLSearchParams())
  assert.equal(calls, 1)
  status = 404; t.mock.timers.tick(10000); await settled()
  assert.equal(calls, 2)
  t.mock.timers.tick(60000); f.event(); f.status.mount(new URLSearchParams())
  assert.equal(calls, 2)
})

test('fallback browsers coalesce reads and scope changes cannot reuse old results', async t => {
  const requests = []
  const f = statusFixture(t, (path, { signal }) => new Promise(resolve => requests.push({ path, signal, resolve })), false)
  f.status.mount(new URLSearchParams('knowledgeBaseId=a'))
  f.status.mount(new URLSearchParams('knowledgeBaseId=a'))
  assert.equal(requests.length, 1)
  f.status.mount(new URLSearchParams('knowledgeBaseId=b'))
  assert.equal(requests.length, 2)
  assert.equal(requests[0].signal.aborted, true)
  requests[0].resolve({ ready: 999, total: 999, failed: 0, pending: 0 }); await settled()
  assert.equal(f.status.root.dataset.state, 'loading')
  requests[1].resolve({ ready: 1, total: 1, failed: 0, pending: 0 }); await settled()
  assert.equal(f.status.root.dataset.state, 'ready')
})
