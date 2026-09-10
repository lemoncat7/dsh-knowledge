import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply, LocalKnowledgeProvider } from '../lib/index.js'

async function runtime(path, stream) {
  const routes = new Map(), events = new Map(), disposers = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: { stream }, tools: { register() { return () => {} } },
    on(name, fn) { events.set(name, fn); return () => events.delete(name) },
    effect(factory) { disposers.push(factory()) }, get() { return undefined },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
  }
  apply(ctx, { backend: 'local', databasePath: path, writebackQueuePath: `${path}.outbox`, exposeApi: false, exposeWeb: false, extractionEnabled: true, extractionTimeoutMs: 5000, extractionMaxTokens: 1000, extractionMaxInputChars: 10000 })
  const server = createServer((req, res) => {
    const route = [...routes.values()].find(route => req.url.split('?')[0] === route.path)
    if (route) void route.handler(req, res); else res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/knowledge-control/v1/writeback-status?sessionId=session&turn=1`
  let closed = false
  return {
    enqueue: session => events.get('agent/turn-stopping')({ agent: { session }, turn: 1, signal: new AbortController().signal }),
    status: async (method = 'GET') => {
      const res = await fetch(url, { method, headers: { 'x-dsh-knowledge-client': 'conversation-web' } })
      return { code: res.status, ...await res.json() }
    },
    close: async () => {
      if (closed) return; closed = true
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      for (const dispose of disposers.reverse()) await dispose?.()
    },
  }
}
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('writeback runtime condition timed out')
}

test('turn-stop and HTTP retry return before extraction; failed snapshot survives runtime restart and new turns', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-runtime-outbox-'))
  const path = join(root, 'knowledge.sqlite')
  const observer = new LocalKnowledgeProvider(path)
  await observer.upsertMount({ targetKind: 'session', targetId: 'session', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '' })
  let calls = 0, release
  const blocked = new Promise(resolve => { release = resolve })
  const first = await runtime(path, async function* () { calls++; await blocked; throw new Error('configured model unavailable') })
  let second
  t.after(async () => { release(); await first.close(); await second?.close(); await observer.close(); await rm(root, { recursive: true, force: true }) })
  const session = { id: 'session', header: {}, events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'original question' }] } },
    { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'original answer' }] } } },
  ], snapshotEvents() { return this.events } }
  assert.equal(first.enqueue(session), undefined, 'turn-stopping must not return a model promise')
  // Exercise exhausted-budget manual recovery; normal failures now auto-retry.
  const disk = new DatabaseSync(`${path}.outbox`)
  disk.exec('UPDATE queue_jobs SET attempts=4')
  disk.close()
  session.events = []
  await waitFor(() => calls === 1)
  assert.equal((await first.status()).status, 'running')
  release()
  await waitFor(async () => (await first.status()).status === 'failed')
  await first.close()
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  second = await runtime(path, async function* (request) {
    calls++
    const content = JSON.parse(request.messages[0].content[0].text)
    assert.deepEqual(content.conversation, { user: 'original question', assistant: 'original answer' })
    await gate
    yield { type: 'text-delta', text: '{"candidates":[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(() => resume())
  assert.equal((await second.status()).status, 'failed')
  const retried = await second.status('POST')
  assert.equal(retried.code, 200)
  assert.equal(retried.status, 'queued')
  await second.status('POST')
  await waitFor(() => calls === 2)
  assert.equal((await second.status()).status, 'running')
  resume()
  await waitFor(async () => (await second.status()).status === 'completed')
  assert.match((await second.status()).summary, /无需收录/)
  assert.equal(calls, 2)
})
