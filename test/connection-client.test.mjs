import assert from 'node:assert/strict'
import test from 'node:test'
import { createConnectionClient, isConnectionView } from '../lib/connection-client.js'

const value = { backend: 'local', remoteTimeoutMs: 10000, tokenConfigured: false, canSwitchRemote: true, writable: true, managementAvailable: true, managementPath: '/knowledge/' }
const response = (body = value, status = 200) => new Response(JSON.stringify(body), { status })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('concurrent metadata reads share transport; one consumer cancellation leaves others intact', async () => {
  const gate = deferred(); let calls = 0, transportSignal
  const client = createConnectionClient({ fetch: (_url, options) => { calls++; transportSignal = options.signal; return gate.promise } })
  const cancelled = new AbortController()
  const first = client.request('GET', undefined, cancelled.signal)
  const second = client.request('GET')
  cancelled.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(transportSignal.aborted, false)
  gate.resolve(response())
  assert.deepEqual(await second, value)
  assert.equal(calls, 1)
})

test('last consumer leaving aborts transport; immediate remount starts a fresh read', async () => {
  const signals = []
  const client = createConnectionClient({ fetch: (_url, options) => { signals.push(options.signal); return signals.length === 1 ? new Promise(() => {}) : Promise.resolve(response()) } })
  const controller = new AbortController()
  const first = client.request('GET', undefined, controller.signal)
  controller.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(await client.request('GET'), value)
  assert.equal(signals.length, 2)
})

test('metadata cache expires and never bypasses revalidation', async () => {
  let now = 0, calls = 0
  const client = createConnectionClient({ now: () => now, fetch: async () => { calls++; return response() } })
  await client.request('GET')
  assert.deepEqual(client.peek(), value)
  await client.request('GET')
  assert.equal(calls, 2)
  now = 30000
  assert.equal(client.peek(), undefined)
})

test('late response from an abandoned transport cannot repopulate the metadata cache', async () => {
  const gate = deferred()
  const client = createConnectionClient({ fetch: () => gate.promise })
  const controller = new AbortController()
  const read = client.request('GET', undefined, controller.signal)
  controller.abort()
  await assert.rejects(read, { name: 'AbortError' })
  gate.resolve(response())
  await tick()
  assert.equal(client.peek(), undefined)
})

test('permission failure clears cached metadata; plain text errors remain readable', async () => {
  let calls = 0
  const client = createConnectionClient({ fetch: async () => ++calls === 1 ? response() : new Response('forbidden', { status: 403 }) })
  await client.request('GET')
  await assert.rejects(client.request('GET'), { status: 403, message: '连接接口返回 HTTP 403' })
  assert.equal(client.peek(), undefined)
})

test('timeout includes stalled response body and supports later recovery', async () => {
  let calls = 0, signal
  const client = createConnectionClient({ readTimeoutMs: 15, fetch: async (_url, options) => {
    signal = options.signal
    return ++calls === 1 ? { ok: true, json: () => new Promise(() => {}) } : response()
  } })
  await assert.rejects(client.request('GET'), /超时/)
  assert.equal(signal.aborted, true)
  assert.equal(client.peek(), undefined)
  assert.deepEqual(await client.request('GET'), value)
})

test('a stale GET cannot undo a newer connection write, even when it resolves last', async () => {
  const old = deferred(), write = deferred(); const methods = []
  const changed = { ...value, managementPath: '/central/' }
  const client = createConnectionClient({ fetch: (_url, options) => {
    methods.push(options.method)
    if (options.method === 'PUT') return write.promise
    return methods.length === 1 ? old.promise : Promise.resolve(response(changed))
  } })
  const first = client.request('GET')
  const save = client.request('PUT', { backend: 'remote' })
  const second = client.request('GET')
  await tick()
  assert.deepEqual(methods, ['GET', 'PUT'])
  write.resolve(response(changed)); await save
  assert.deepEqual(await second, changed)
  old.resolve(response())
  assert.deepEqual(await first, changed)
  assert.deepEqual(client.peek(), changed)
})

test('failed writes invalidate cache, are not retried, and release waiting reads', async () => {
  let puts = 0
  const client = createConnectionClient({ fetch: async (_url, options) => {
    if (options.method === 'PUT') { puts++; throw Error('offline') }
    return response()
  } })
  await client.request('GET')
  await assert.rejects(client.request('PUT', {}), /offline/)
  assert.equal(client.peek(), undefined)
  assert.deepEqual(await client.request('GET'), value)
  assert.equal(puts, 1)
})

test('cancellation while waiting for a write does not cancel that write or issue a GET', async () => {
  const gate = deferred(); let calls = 0
  const client = createConnectionClient({ fetch: () => { calls++; return gate.promise } })
  const save = client.request('PUT', {})
  const controller = new AbortController()
  const read = client.request('GET', undefined, controller.signal)
  controller.abort()
  await assert.rejects(read, { name: 'AbortError' })
  gate.resolve(response()); await save
  assert.equal(calls, 1)
})

test('connection shape rejects external management paths and malformed metadata', () => {
  assert.equal(isConnectionView({ ...value, managementPath: '//foreign.invalid/' }), false)
  assert.equal(isConnectionView({ ...value, managementPath: 'https://foreign.invalid/' }), false)
  assert.equal(isConnectionView({ ...value, managementPath: '/knowledge/' }), true)
  assert.equal(isConnectionView({}), false)
})
