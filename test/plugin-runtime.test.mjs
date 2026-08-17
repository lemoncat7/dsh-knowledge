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
  const extractionRequests = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream(request) {
        extractionRequests.push(request)
        yield { type: 'text-delta', text: JSON.stringify({ candidates: [{
          action: 'create',
          knowledgeBaseId: 'default',
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
    ],
    append(type, data, options) {
      const event = { type, seq: this.events.length, time: Date.now(), data, ...options }
      this.events.push(event)
      return event
    },
  }

  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(() => observer.close())
  await observer.patchKnowledgeBase('default', {
    description: 'Only reusable DSH plugin installation and operation knowledge qualifies.',
  })
  await observer.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  const dedicatedBase = await observer.createKnowledgeBase({
    name: 'Dedicated model base', description: 'Only dedicated-model knowledge qualifies.',
    defaultTags: [], extractionInstructions: '', writebackProvider: 'kimi', writebackModel: 'kimi-k2.7-code',
  })
  await observer.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: dedicatedBase.id,
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  await listeners.get('agent/turn-stopping')({ agent: { session }, turn: 1, signal: new AbortController().signal })
  const job = await observer.extractionJob('session-1:1')
  assert.equal(job?.status, 'completed')
  const pending = await observer.listCandidates('pending', 10)
  assert.equal(pending.length, 1)
  assert.equal(session.events.at(-1).data.source.form, 'notice')
  assert.match(session.events.at(-1).data.source.summary, /待审 1/)
  const writebackNotice = session.events.at(-1).data
  assert.deepEqual(extractionRequests.map(request => [request.provider, request.model]).sort(), [
    ['kimi', 'kimi-k2.7-code'], ['mock', 'extractor'],
  ])
  const extractionRequest = extractionRequests.find(request => request.provider === 'mock')
  const extractionPayload = JSON.parse(extractionRequest.messages[0].content[0].text)
  assert.equal(extractionPayload.destinations[0].routingDescription, 'Only reusable DSH plugin installation and operation knowledge qualifies.')
  assert.match(extractionRequest.system, /routingDescription as its applicability rule/)
  assert.equal(extractionRequest.provider, 'mock')
  assert.equal(extractionRequest.model, 'extractor')

  const preStep = listeners.get('agent/pre-step')
  const beforeApproval = await preStep({ agent: { session }, messages: [user, writebackNotice], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user, writebackNotice] }))
  assert.equal(beforeApproval.messages.length, 1)
  assert.equal(beforeApproval.messages.some(message => message.source.form === 'notice'), false)
  await observer.review(pending[0].id, { decision: 'approve' })
  const afterApproval = await preStep({ agent: { session }, messages: [user, writebackNotice], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user, writebackNotice] }))
  assert.equal(afterApproval.messages.at(-1).source.form, 'recall')
  assert.equal(afterApproval.messages.some(message => message.source.form === 'notice'), false)
  assert.match(afterApproval.messages.at(-1).content[0].text, /DSH plugin installation command/)
})

test('direct write approves only high-confidence non-conflicts and skips unmounted sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-direct-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const disposers = []
  let targetId = ''
  let streamCalls = 0
  const streamBudgets = []
  const streamRoutes = []
  const streamReasoning = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream(request) {
        streamCalls += 1
        streamBudgets.push(request.maxTokens)
        streamRoutes.push([request.provider, request.model])
        streamReasoning.push(request.reasoningEffort)
        if (streamCalls === 1) {
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
          return
        }
        yield { type: 'text-delta', text: JSON.stringify({ candidates: [
          {
            action: 'create', knowledgeBaseId: 'default', title: 'Confirmed high confidence',
            body: 'This durable fact can be written immediately.', type: 'fact', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.94, reason: 'Explicitly confirmed.',
          },
          {
            action: 'create', knowledgeBaseId: 'default', title: 'Uncertain detail',
            body: 'This may be correct but still needs review.', type: 'fact', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.61, reason: 'Uncertain wording.',
          },
          {
            action: 'conflict', knowledgeBaseId: 'default', targetId, title: 'Conflicting policy',
            body: 'This contradicts the existing policy.', type: 'decision', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.99, reason: 'Contradiction detected.',
          },
        ] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(factory) { disposers.push(factory()) },
    get() { return undefined },
  }
  apply(ctx, {
    backend: 'local', databasePath, remoteTimeoutMs: 5000, exposeApi: false,
    apiPrefix: '/knowledge-api/v1', extractionEnabled: true, extractionMaxTokens: 1200,
    extractionTimeoutMs: 5000, extractionMaxInputChars: 10000, defaultScope: 'project',
    autoRecallLimit: 5, recallMaxChars: 6000, directWriteMinConfidence: 0.85,
  })
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })

  const sessionFor = (id, turn) => ({
    id, header: { cwd: '/workspace/direct' }, events: [
      { type: 'turn/start', seq: 0, data: { turn } },
      { type: 'user/message', seq: 1, data: { id: `u-${id}`, role: 'user', content: [{ type: 'text', text: 'Record the durable policy.' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, data: { turn, step: 1, message: {
        id: `a-${id}`, role: 'assistant', content: [{ type: 'text', text: 'The durable policy is now confirmed.' }],
        source: { kind: 'model', provider: 'mock', model: 'extractor' },
      } } },
    ],
    append(type, data, options) {
      const event = { type, seq: this.events.length, time: Date.now(), data, ...options }
      this.events.push(event)
      return event
    },
  })

  const unmounted = sessionFor('unmounted', 1)
  await listeners.get('agent/turn-stopping')({ agent: { session: unmounted }, turn: 1, signal: new AbortController().signal })
  assert.equal(streamCalls, 0)
  assert.match(unmounted.events.at(-1).data.source.summary, /未挂载/)

  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(() => observer.close())
  const existing = await observer.create({
    knowledgeBaseId: 'default', title: 'Existing policy', body: 'Keep the existing behavior.',
    type: 'decision', tags: ['policy'], scope: { kind: 'global' }, confidence: 1,
  })
  targetId = existing.id
  await observer.upsertMount({
    targetKind: 'project', targetId: '/workspace/direct', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  const direct = sessionFor('direct', 1)
  await listeners.get('agent/turn-stopping')({ agent: { session: direct }, turn: 1, signal: new AbortController().signal })
  assert.equal(streamCalls, 2)
  assert.deepEqual(streamBudgets, [1200, 2400])
  assert.deepEqual(streamRoutes, [['mock', 'extractor'], ['mock', 'extractor']])
  assert.deepEqual(streamReasoning, [undefined, 'low'])
  assert.equal((await observer.listCandidates('approved', 10)).length, 1)
  assert.equal((await observer.listCandidates('pending', 10)).length, 2)
  assert.equal((await observer.list({ status: 'active', limit: 10 })).items.length, 2)
  assert.match(direct.events.at(-1).data.source.summary, /直写 1/)
  assert.match(direct.events.at(-1).data.source.summary, /待审 2/)
})
