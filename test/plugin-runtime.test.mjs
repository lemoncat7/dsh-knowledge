import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, LocalKnowledgeProvider } from '../lib/index.js'
import { createRecallMessage } from '../lib/runtime.js'

test('message IDs do not depend on the ambient global crypto object', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  try {
    assert.match(createRecallMessage('test').id, /^[0-9a-f-]{36}$/)
  } finally {
    if (descriptor === undefined) delete globalThis.crypto
    else Object.defineProperty(globalThis, 'crypto', descriptor)
  }
})

test('plugin extracts after a completed turn and recalls only approved knowledge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-runtime-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: JSON.stringify({ candidates: [{
          action: 'create',
          title: 'DSH plugin installation command',
          body: 'Install profile plugins with dsh plugin --profile web add <package>.',
          type: 'procedure',
          tags: ['dsh', 'plugin'],
          scope: { kind: 'project', id: '/workspace/demo' },
          confidence: 0.93,
          reason: 'Reusable DSH operation.',
        }] }) },
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(factory) { disposers.push(factory()) },
    get() { return undefined },
  }
  apply(ctx, {
    backend: 'local', databasePath, remoteTimeoutMs: 5000, exposeApi: false,
    apiPrefix: '/knowledge-api/v1', extractionEnabled: true, extractionMaxTokens: 1000,
    extractionTimeoutMs: 5000, extractionMaxInputChars: 10000, defaultScope: 'project',
    autoRecallLimit: 5, recallMaxChars: 6000,
  })
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })

  const user = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'How do I install a DSH plugin?' }], source: { kind: 'user' } }
  const assistant = {
    id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Use the DSH profile plugin add command.' }],
    source: { kind: 'model', provider: 'mock', model: 'extractor' },
  }
  const session = {
    id: 'session-1', header: { cwd: '/workspace/demo' }, events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: user },
      { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: assistant } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  listeners.get('session/event')(session, session.events[3])

  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(() => observer.close())
  let job
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = await observer.extractionJob('session-1:1')
    if (job?.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(job?.status, 'completed')
  const pending = await observer.listCandidates('pending', 10)
  assert.equal(pending.length, 1)

  const preStep = listeners.get('agent/pre-step')
  const beforeApproval = await preStep({ agent: { session }, messages: [user], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
  assert.equal(beforeApproval.messages.length, 1)
  await observer.review(pending[0].id, { decision: 'approve' })
  const afterApproval = await preStep({ agent: { session }, messages: [user], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
  assert.equal(afterApproval.messages.at(-1).source.form, 'recall')
  assert.match(afterApproval.messages.at(-1).content[0].text, /DSH plugin installation command/)
})
