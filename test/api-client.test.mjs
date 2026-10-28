import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient } from '../web/api-client.js'

const client = options => createApiClient({ apiBase: '/api', authMode: 'same-origin', getToken: () => '', readTimeoutMs: 20, ...options })
const aborted = signal => new Promise((_, reject) => {
  const cancel = () => reject(signal.reason || new DOMException('aborted', 'AbortError'))
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
})

test('stalled metadata reads time out once without automatic replay', async () => {
  let calls = 0
  const { api } = client({ fetch: (_url, { signal }) => { calls++; return aborted(signal) } })
  await assert.rejects(api('knowledge-bases'), error => error.code === 'READ_TIMEOUT')
  assert.equal(calls, 1)
})

test('read timeout includes a stalled response body', async () => {
  const { api } = client({ fetch: async (_url, { signal }) => ({ ok: true, text: () => aborted(signal) }) })
  await assert.rejects(api('documents/one'), error => error.code === 'READ_TIMEOUT')
})

test('caller cancellation is preserved, including already-aborted navigation', async () => {
  const navigation = new AbortController()
  const { api } = client({ fetch: (_url, { signal }) => aborted(signal) })
  const pending = api('knowledge-bases', { signal: navigation.signal })
  navigation.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(api('knowledge-bases', { signal: navigation.signal }), { name: 'AbortError' })
})

test('writes remain single-shot and are not cancelled by read timeout', async () => {
  let calls = 0
  const { api } = client({ fetch: async (_url, { signal, headers }) => {
    calls++; assert.equal(signal, undefined)
    assert.equal(headers['x-dsh-knowledge-client'], 'management-web')
    await new Promise(resolve => setTimeout(resolve, 35))
    return new Response('{"saved":true}', { status: 200 })
  } })
  assert.deepEqual(await api('documents/one', { method: 'PUT', body: { content: 'text' } }), { saved: true })
  assert.equal(calls, 1)
})

test('completed reads release timers/listeners and preserve server error codes', async () => {
  const navigation = new AbortController()
  let adds = 0, removes = 0, captured
  const signal = { aborted: false, addEventListener() { adds++ }, removeEventListener() { removes++ } }
  const { api } = client({ fetch: async (_url, { signal }) => {
    captured = signal
    return new Response('{"error":"changed","code":"VERSION_CONFLICT"}', { status: 409 })
  } })
  await assert.rejects(api('documents/one', { signal }), { status: 409, code: 'VERSION_CONFLICT' })
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(captured.aborted, false)
  assert.equal(adds, removes)
  navigation.abort()
})
