import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, LocalKnowledgeProvider } from '../lib/index.js'
import { createWritebackMessage } from '../lib/runtime.js'

test('message IDs do not depend on the ambient global crypto object', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  try {
    assert.match(createWritebackMessage('test').id, /^[0-9a-f-]{36}$/)
  } finally {
    if (descriptor === undefined) delete globalThis.crypto
    else Object.defineProperty(globalThis, 'crypto', descriptor)
  }
})

test('plugin gates completed-turn extraction and keeps knowledge surface messages out of model input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-runtime-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const disposers = []
  const extractionRequests = []
  const tools = new Map()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream(request) {
        extractionRequests.push(request)
        const candidates = [{
          action: 'create',
          knowledgeBaseId: 'default',
          title: 'DSH plugin installation command',
          body: 'Install profile plugins with dsh plugin --profile web add <package>.',
          type: 'procedure',
          tags: ['dsh', 'plugin'],
          scope: { kind: 'project', id: '/workspace/demo' },
          confidence: 0.93,
          retention: { durable: true, evidence: 'explicit' },
          reason: 'Reusable DSH operation.',
        }, ...Array.from({ length: 5 }, (_, index) => ({
          action: 'create', knowledgeBaseId: 'default', title: `Confirmed installation detail ${index + 1}`,
          body: `Confirmed reusable installation detail number ${index + 1}.`, type: 'procedure', tags: ['dsh'],
          scope: { kind: 'project', id: '/workspace/demo' }, confidence: 0.91,
          retention: { durable: true, evidence: 'verified' }, reason: 'Verified reusable detail.',
        })), {
          action: 'create', knowledgeBaseId: 'default', title: 'Unverified suggestion',
          body: 'This model-generated suggestion must not pass conservative mode.', type: 'fact', tags: [],
          scope: { kind: 'project', id: '/workspace/demo' }, confidence: 0.99,
          retention: { durable: false, evidence: 'inferred' }, reason: 'Only inferred.',
        }]
        yield { type: 'text-delta', text: JSON.stringify({ candidates }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
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
  const staleNotice = {
    id: 'notice-old', role: 'user', content: [{ type: 'text', text: 'WRITEBACK_NOTICE_MUST_NOT_ENTER_CONTEXT' }],
    source: { kind: 'plugin', plugin: 'dsh-knowledge', form: 'notice' },
  }
  const legacyRecall = {
    id: 'recall-old', role: 'user', content: [{ type: 'text', text: 'LEGACY_PREFETCH_MUST_NOT_ENTER_CONTEXT' }],
    source: { kind: 'plugin', plugin: 'dsh-knowledge', form: 'recall' },
  }
  const session = {
    id: 'session-1', header: { cwd: '/workspace/demo' }, events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: staleNotice },
      { type: 'user/message', seq: 2, data: user },
      { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: assistant } },
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
  assert.equal(pending.length, 6)
  assert.equal(session.events.at(-1).data.source.form, 'notice')
  assert.match(session.events.at(-1).data.source.summary, /待审 6/)
  const writebackNotice = session.events.at(-1).data
  assert.deepEqual(extractionRequests.map(request => [request.provider, request.model]).sort(), [
    ['kimi', 'kimi-k2.7-code'], ['mock', 'extractor'],
  ])
  const extractionRequest = extractionRequests.find(request => request.provider === 'mock')
  const extractionPayload = JSON.parse(extractionRequest.messages[0].content[0].text)
  assert.equal(extractionPayload.destinations[0].routingDescription, 'Only reusable DSH plugin installation and operation knowledge qualifies.')
  assert.equal(extractionPayload.writebackPolicy, 'conservative')
  assert.doesNotMatch(extractionPayload.conversation.user, /WRITEBACK_NOTICE_MUST_NOT_ENTER_CONTEXT/)
  assert.match(extractionPayload.outputLanguage, /conversation\.user/)
  assert.match(extractionRequest.system, /routing and extraction together/)
  assert.match(extractionRequest.system, /primary natural language and writing system used by conversation\.user/)
  assert.match(extractionRequest.system, /Never default to English/)
  assert.match(extractionRequest.system, /Default to skip/)
  assert.equal(extractionRequest.provider, 'mock')
  assert.equal(extractionRequest.model, 'extractor')

  const preStep = listeners.get('agent/pre-step')
  const beforeApproval = await preStep({ agent: { session }, messages: [user, writebackNotice, legacyRecall], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user, writebackNotice, legacyRecall] }))
  assert.equal(beforeApproval.messages.length, 1)
  assert.equal(beforeApproval.messages.some(message => message.source.form === 'notice'), false)
  const installationCandidate = pending.find(candidate => candidate.draft.title === 'DSH plugin installation command')
  assert.ok(installationCandidate)
  await observer.review(installationCandidate.id, { decision: 'approve' })
  const afterApproval = await preStep({ agent: { session }, messages: [user, writebackNotice, legacyRecall], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user, writebackNotice, legacyRecall] }))
  assert.equal(afterApproval.messages.length, 2)
  assert.equal(afterApproval.messages.some(message => message.source.form === 'notice'), false)
  const recalled = afterApproval.messages.find(message => message.source.form === 'recall')
  assert.ok(recalled)
  assert.match(recalled.content[0].text, /Automatically retrieved knowledge/)
  assert.match(recalled.content[0].text, /DSH plugin installation command/)
  assert.doesNotMatch(recalled.content[0].text, /LEGACY_PREFETCH/)

  const secondStep = await preStep({ agent: { session }, messages: [legacyRecall], turn: 2, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [legacyRecall] }))
  assert.equal(secondStep.messages.length, 0)

  const promptAssembly = listeners.get('system-prompt/assemble')
  assert.equal(typeof promptAssembly, 'function')
  const emptyAssembly = { sections: [], contexts: [], tools: [], variables: {} }
  const assembled = await promptAssembly(
    emptyAssembly,
    { agent: { session }, signal: new AbortController().signal },
    async () => emptyAssembly,
  )
  const catalog = assembled.contexts.find(context => context.name === 'dsh-knowledge:mounts')
  assert.ok(catalog)
  assert.match(catalog.text, /Knowledge bases mounted for this session/)
  assert.match(catalog.text, /knowledge_base_search/)
  assert.match(catalog.text, /knowledge_write/)
  assert.match(catalog.text, /Policy CONSERVATIVE/)
  assert.match(catalog.text, /Only reusable DSH plugin installation/)
  assert.doesNotMatch(catalog.text, /Install profile plugins with/)

  assert.deepEqual([...tools.keys()].sort(), [
    'knowledge_base_create',
    'knowledge_base_search',
    'knowledge_base_update',
    'knowledge_read',
    'knowledge_search',
    'knowledge_write',
  ])
  const toolExec = { agent: { session }, signal: new AbortController().signal }
  const created = JSON.parse(await tools.get('knowledge_base_create').execute({
    name: 'Tool-managed base',
    description: 'Reusable knowledge managed through DSH tools.',
    defaultTags: ['DSH', 'tools', 'dsh'],
    extractionInstructions: 'Keep only confirmed reusable conclusions.',
  }, toolExec))
  assert.equal(created.storage, 'local')
  assert.equal(created.operation, 'created')
  assert.equal(created.mountsChanged, false)
  assert.deepEqual(created.knowledgeBase.defaultTags, ['dsh', 'tools'])

  const updated = JSON.parse(await tools.get('knowledge_base_update').execute({
    base: created.knowledgeBase.id,
    name: 'Updated tool-managed base',
    description: 'Updated routing description.',
    defaultTags: ['updated', 'DSH'],
    extractionInstructions: '',
  }, toolExec))
  assert.equal(updated.storage, 'local')
  assert.equal(updated.operation, 'updated')
  assert.equal(updated.mountsChanged, false)
  assert.equal(updated.knowledgeBase.name, 'Updated tool-managed base')
  assert.equal(updated.knowledgeBase.description, 'Updated routing description.')
  assert.deepEqual(updated.knowledgeBase.defaultTags, ['dsh', 'updated'])
  assert.equal(updated.knowledgeBase.extractionInstructions, '')

  const baseSearchOutput = await tools.get('knowledge_base_search').execute({ query: 'DSH plugin installation' }, toolExec)
  assert.match(baseSearchOutput, /Only reusable DSH plugin installation/)
  assert.match(baseSearchOutput, /id: default/)
  assert.doesNotMatch(baseSearchOutput, /Install profile plugins with/)
  await assert.rejects(
    tools.get('knowledge_search').execute({ query: 'DSH plugin installation' }, toolExec),
    /base must be a non-empty string/,
  )
  const searchOutput = await tools.get('knowledge_search').execute({ query: 'DSH plugin installation', base: 'default' }, toolExec)
  assert.match(searchOutput, /DSH plugin installation command/)
  const handle = /handle: (k1\.[^\s]+)/.exec(searchOutput)?.[1]
  assert.ok(handle)
  const readOutput = await tools.get('knowledge_read').execute({ handle }, toolExec)
  assert.match(readOutput, /Install profile plugins with dsh plugin/)
  await assert.rejects(
    tools.get('knowledge_read').execute({ handle }, {
      agent: { session: { ...session, id: 'another-session' } },
      signal: new AbortController().signal,
    }),
    /does not belong to this session/,
  )
})

test('conservative write-back accepts durable source-backed GitHub research without raw tool transcripts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-github-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const disposers = []
  let extractionRequest
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream(request) {
        extractionRequest = request
        yield { type: 'text-delta', text: JSON.stringify({ candidates: [
          {
            action: 'create', knowledgeBaseId: 'default', documentTitle: 'lemoncat7/dsh-remote-settings-compat',
            sectionTitle: '仓库与用途',
            body: '仓库：https://github.com/lemoncat7/dsh-remote-settings-compat\n\n用于解决 DSH 远程浏览器设置访问兼容问题。',
            type: 'fact', tags: ['github', 'dsh'], scope: { kind: 'global' }, confidence: .92,
            retention: { durable: true, evidence: 'inferred' }, reason: '带来源的仓库用途。',
          },
          {
            action: 'create', knowledgeBaseId: 'default', documentTitle: 'lemoncat7/dsh-remote-settings-compat',
            sectionTitle: 'License 与维护状态', body: '采用 MIT License，最近仍有维护。',
            type: 'fact', tags: ['license', '维护状态'], scope: { kind: 'global' }, confidence: .93,
            retention: { durable: true, evidence: 'verified' }, reason: '补充授权和维护状态。',
          },
          {
            action: 'create', knowledgeBaseId: 'default', documentTitle: 'lemoncat7/dsh-remote-settings-compat',
            sectionTitle: '风险与结论', body: '适合解决受信任反向代理下的远程设置兼容问题，部署前仍应限制可信来源。',
            type: 'fact', tags: ['风险', '结论'], scope: { kind: 'global' }, confidence: .91,
            retention: { durable: true, evidence: 'inferred' }, reason: '补充风险和采用结论。',
          },
        ] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tools: { register() { return () => {} } },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(factory) { disposers.push(factory()) },
    get() { return undefined },
  }
  apply(ctx, {
    backend: 'local', databasePath, remoteTimeoutMs: 5000, exposeApi: false,
    apiPrefix: '/knowledge-api/v1', extractionEnabled: true, extractionMaxTokens: 1200,
    extractionTimeoutMs: 5000, extractionMaxInputChars: 10000, defaultScope: 'global',
  })
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })

  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(() => observer.close())
  await observer.patchKnowledgeBase('default', {
    name: 'GitHub 项目收藏',
    description: '收集 GitHub 项目的仓库链接、技术栈、License、版本、维护状态、优缺点、风险和试用结论。',
  })
  await observer.upsertMount({
    targetKind: 'session', targetId: 'github-session', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  const session = {
    id: 'github-session', header: {}, events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { id: 'u-github', role: 'user', content: [{ type: 'text', text: '帮我搜索并评估这个 GitHub 项目。' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, data: { turn: 1, message: {
        id: 'a-github', role: 'assistant',
        content: [{ type: 'text', text: '已查询 https://github.com/lemoncat7/dsh-remote-settings-compat 。项目采用 MIT License，下面是维护状态、风险和适用建议。' }],
        source: { kind: 'model', provider: 'mock', model: 'research-model' },
      } } },
    ],
    append(type, data, options) { const event = { type, seq: this.events.length, data, ...options }; this.events.push(event); return event },
  }
  await listeners.get('agent/turn-stopping')({ agent: { session }, turn: 1, signal: new AbortController().signal })

  const payload = JSON.parse(extractionRequest.messages[0].content[0].text)
  assert.deepEqual(payload.sourceReferences, ['https://github.com/lemoncat7/dsh-remote-settings-compat'])
  assert.match(extractionRequest.system, /Do not reject a durable source-backed research result/)
  assert.equal((await observer.listCandidates('approved', 10)).length, 1)
  const entries = (await observer.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })).items
  assert.equal(entries.length, 1)
  assert.match(entries[0].body, /github\.com\/lemoncat7/)
  assert.match(entries[0].body, /## 仓库与用途/)
  assert.match(entries[0].body, /## License 与维护状态/)
  assert.match(entries[0].body, /## 风险与结论/)
  assert.deepEqual(entries[0].tags, ['dsh', 'github', 'license', '结论', '维护状态', '风险'])
  assert.equal((await observer.listDocuments('default')).length, 1)
  assert.match(session.events.at(-1).data.source.summary, /直写 1/)
})

test('knowledge_write uses the active mounted provider and preserves merge and scope policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-tool-write-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const disposers = []
  const tools = new Map()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: { async *stream() {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(factory) { disposers.push(factory()) },
    get() { return undefined },
  }
  apply(ctx, {
    backend: 'local', databasePath, remoteTimeoutMs: 5000, exposeApi: false,
    apiPrefix: '/knowledge-api/v1', extractionEnabled: false,
  })
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })

  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(() => observer.close())
  await observer.patchKnowledgeBase('default', { name: 'GitHub 项目收藏', description: '收集 GitHub 项目资料。' })
  await observer.upsertMount({
    targetKind: 'project', targetId: '/workspace/github', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: ['github'], excludeTags: ['temporary'], extractionInstructions: '',
  })
  const session = { id: 'tool-session', header: { cwd: '/workspace/github' }, events: [{ type: 'turn/start', seq: 0, data: { turn: 3 } }] }
  const exec = { agent: { session }, signal: new AbortController().signal }
  const created = JSON.parse(await tools.get('knowledge_write').execute({
    base: 'GitHub 项目收藏', title: 'example/repository', type: 'fact', scope: 'project',
    tags: ['repository', 'temporary'], content: '仓库地址：https://github.com/example/repository\n\n这是一个可复用的项目调研结论。',
  }, exec))
  assert.equal(created.storage, 'local')
  assert.equal(created.outcome, 'created')
  const first = (await observer.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })).items[0]
  assert.deepEqual(first.tags, ['github', 'repository'])
  assert.deepEqual(first.scope, { kind: 'project', id: '/workspace/github' })

  const search = await tools.get('knowledge_search').execute({ query: 'example repository', base: 'default' }, exec)
  const handle = /handle: (k1\.[^\s]+)/.exec(search)?.[1]
  assert.ok(handle)
  const updated = JSON.parse(await tools.get('knowledge_write').execute({
    handle, content: '适合在后续选型时作为候选项目参考。', tags: ['selection'],
  }, exec))
  assert.equal(updated.outcome, 'merged')
  const merged = await observer.get(first.id)
  assert.match(merged.body, /后续选型/)
  assert.deepEqual(merged.tags, ['github', 'repository', 'selection'])

  await assert.rejects(
    tools.get('knowledge_write').execute({ base: 'not-mounted', title: 'x', type: 'fact', content: 'x' }, exec),
    /not mounted for write-back/,
  )
})

test('direct write approves all non-conflicts and skips unmounted sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-direct-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const disposers = []
  const tools = new Map()
  let targetId = ''
  let streamCalls = 0
  let extractionCalls = 0
  const streamBudgets = []
  const streamRoutes = []
  const streamReasoning = []
  const streamPolicies = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream(request) {
        streamCalls += 1
        streamBudgets.push(request.maxTokens)
        streamRoutes.push([request.provider, request.model])
        streamReasoning.push(request.reasoningEffort)
        streamPolicies.push(JSON.parse(request.messages[0].content[0].text).writebackPolicy)
        extractionCalls += 1
        if (extractionCalls === 1) {
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
          return
        }
        yield { type: 'text-delta', text: JSON.stringify({ candidates: [
          {
            action: 'create', knowledgeBaseId: 'default', title: 'Confirmed high confidence',
            body: 'This durable fact can be written immediately.', type: 'fact', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.94,
            retention: { durable: true, evidence: 'explicit' }, reason: 'Explicitly confirmed.',
          },
          {
            action: 'create', knowledgeBaseId: 'default', title: 'Uncertain detail',
            body: 'This may be correct but still needs review.', type: 'fact', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.74,
            retention: { durable: true, evidence: 'inferred' }, reason: 'Inferred reusable detail.',
          },
          {
            action: 'conflict', knowledgeBaseId: 'default', targetId, title: 'Conflicting policy',
            body: 'This contradicts the existing policy.', type: 'decision', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.99,
            retention: { durable: true, evidence: 'explicit' }, reason: 'Contradiction detected.',
          },
        ] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
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
  await observer.updateSettings({ writebackPolicy: 'proactive' })
  const direct = sessionFor('direct', 1)
  await listeners.get('agent/turn-stopping')({ agent: { session: direct }, turn: 1, signal: new AbortController().signal })
  assert.equal(streamCalls, 2)
  assert.deepEqual(streamBudgets, [1200, 2400])
  assert.deepEqual(streamRoutes, [['mock', 'extractor'], ['mock', 'extractor']])
  assert.deepEqual(streamReasoning, [undefined, 'low'])
  assert.deepEqual(streamPolicies, ['proactive', 'proactive'])
  assert.equal((await observer.listCandidates('approved', 10)).length, 1)
  const pending = await observer.listCandidates('pending', 10)
  assert.equal(pending.length, 2)
  assert.ok(pending.some(candidate => candidate.action === 'conflict'))
  assert.ok(pending.some(candidate => candidate.draft.source?.evidence === 'inferred'))
  assert.equal((await observer.list({ status: 'active', limit: 10 })).items.length, 2)
  assert.match(direct.events.at(-1).data.source.summary, /直写 1/)
  assert.match(direct.events.at(-1).data.source.summary, /待审 2/)
})
