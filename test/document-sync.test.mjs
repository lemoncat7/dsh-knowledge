import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocumentSync } from '../web/document-sync.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, overrides = {}) {
  let busy = false
  let active = { key: 'note:one', identity: {}, version: 1, updatedAt: 'a', busy: () => busy }
  const events = []
  const sync = createDocumentSync({ current: () => active, visible: () => true, interval: 60000,
    check: async () => ({ version: 2, updatedAt: 'b' }), refresh: async (_, __, valid) => { if (valid()) events.push('refresh') },
    notify: (_, status) => events.push(status), ...overrides })
  t.after(() => sync.stop())
  return { sync, events, busy: value => { busy = value }, select: value => { active = value } }
}
test('clean documents refresh, dirty documents retain drafts, unchanged polls do not rerender', async t => {
  const f = fixture(t)
  f.sync.wake(); await settle()
  assert.deepEqual(f.events, ['refresh'])
  f.busy(true); f.sync.wake(); await settle()
  assert.deepEqual(f.events, ['refresh', 'changed'])
  const same = fixture(t, { check: async () => ({ version: 1, updatedAt: 'a' }) })
  same.sync.wake(); await settle()
  assert.deepEqual(same.events, ['current'])
})
test('single flight, selection changes, and late typing cannot apply stale responses', async t => {
  let resolve
  let calls = 0
  const f = fixture(t, { check: () => { calls++; return new Promise(r => { resolve = r }) } })
  f.sync.wake(); f.sync.wake()
  assert.equal(calls, 1)
  f.select(null)
  resolve({ version: 2 }); await settle()
  assert.deepEqual(f.events, [])
  let valid
  const typing = fixture(t, { refresh: async (_, __, guard) => { valid = guard } })
  typing.sync.wake(); await settle()
  typing.busy(true)
  assert.equal(valid(), false)
})
test('hidden pages do not request; errors recover and stop suppresses late updates', async t => {
  const hidden = fixture(t, { visible: () => false, check: () => { throw new Error('must not fetch') } })
  hidden.sync.wake(); await settle()
  assert.deepEqual(hidden.events, [])
  let failure = true
  const f = fixture(t, { check: async () => { if (failure) throw Object.assign(new Error('offline'), { status: 503 }); return { version: 2 } } })
  f.sync.wake(); await settle(); failure = false; f.sync.wake(); await settle()
  assert.deepEqual(f.events, ['offline', 'refresh'])
  let resolve
  const stopped = fixture(t, { check: () => new Promise(r => { resolve = r }) })
  stopped.sync.wake(); stopped.sync.stop(); resolve({ version: 2 }); await settle()
  assert.deepEqual(stopped.events, [])
})
