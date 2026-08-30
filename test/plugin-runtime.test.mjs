import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { apply, LocalKnowledgeProvider, resolveConfig } from '../lib/index.js'
import { IMPORT_MAX_BODY_CHARS, splitMarkdownByH2, titleFromMarkdown } from '../web/import-utils.js'

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
      async resolveModelInfo(provider, model) {
        if (provider === 'missing') throw new Error('provider was not found')
        return { provider, id: model, name: model }
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
    extractionMode: 'inline',
  })
  t.after(async () => {
    // node:test after-hooks run in registration order (FIFO): close the
    // harness observer before rm() tries to unlink the WAL database files.
    try { await observer.close() } catch {}
    for (const dispose of disposers.reverse()) await dispose()
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 10 || error?.code !== 'EBUSY') throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
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
  assert.equal(session.events.at(-1).type, 'assistant/message')
  const writebackNotice = staleNotice
  assert.deepEqual(extractionRequests.map(request => [request.provider, request.model]), [
    ['mock', 'extractor'],
    ['kimi', 'kimi-k2.7-code'],
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
  assert.doesNotMatch(catalog.text, /knowledge_write/)
  assert.match(catalog.text, /Response isolation rule/)
  assert.match(catalog.text, /separate plugin model call/)
  assert.match(catalog.text, /Only reusable DSH plugin installation/)
  assert.doesNotMatch(catalog.text, /Install profile plugins with/)

  assert.deepEqual([...tools.keys()].sort(), [
    'knowledge_base_create',
    'knowledge_base_search',
    'knowledge_base_update',
    'knowledge_note_create',
    'knowledge_note_delete',
    'knowledge_note_list',
    'knowledge_note_move',
    'knowledge_note_read',
    'knowledge_note_references',
    'knowledge_note_search',
    'knowledge_note_update',
    'knowledge_read',
    'knowledge_search',
  ])
  const toolExec = { agent: { session }, signal: new AbortController().signal }
  await assert.rejects(
    tools.get('knowledge_base_create').execute({ name: 'Unauthorized base' }, toolExec),
    /requires an explicit request in the current direct user message/,
  )
  session.events.push(
    { type: 'turn/start', seq: session.events.length, data: { turn: 2 } },
    { type: 'user/message', seq: session.events.length + 1, data: {
      id: 'create-base', role: 'user', content: [{ type: 'text', text: '请创建一个工具管理知识库。' }], source: { kind: 'user' },
    } },
  )
  await assert.rejects(
    tools.get('knowledge_base_create').execute({
      name: 'Invalid model base', writebackProvider: 'missing', writebackModel: 'unknown-model',
    }, toolExec),
    /write-back model missing\/unknown-model is unavailable/,
  )
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

  await assert.rejects(
    tools.get('knowledge_base_update').execute({ base: created.knowledgeBase.id, name: 'Unauthorized update' }, {
      agent: { session: { ...session, events: session.events.slice(0, 4) } },
      signal: new AbortController().signal,
    }),
    /requires an explicit request in the current direct user message/,
  )
  session.events.push(
    { type: 'turn/start', seq: session.events.length, data: { turn: 3 } },
    { type: 'user/message', seq: session.events.length + 1, data: {
      id: 'update-base', role: 'user', content: [{ type: 'text', text: '把这个知识库修改为新的名称和描述。' }], source: { kind: 'user' },
    } },
  )
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
    extractionMode: 'inline',
  })
  t.after(async () => {
    // FIFO after-hooks: close the harness observer before rm() unlinks the WAL db.
    try { await observer.close() } catch {}
    for (const dispose of disposers.reverse()) await dispose()
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 10 || error?.code !== 'EBUSY') throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
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
  assert.equal(session.events.at(-1).type, 'assistant/message')
})

test('content write-back is not exposed to the main agent tool surface', async (t) => {
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
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 10 || error?.code !== 'EBUSY') throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  })

  assert.equal(tools.has('knowledge_write'), false)
  assert.deepEqual([...tools.keys()].sort(), [
    'knowledge_base_create', 'knowledge_base_search', 'knowledge_base_update', 'knowledge_note_create',
    'knowledge_note_delete', 'knowledge_note_list', 'knowledge_note_move', 'knowledge_note_read',
    'knowledge_note_references', 'knowledge_note_search', 'knowledge_note_update', 'knowledge_read', 'knowledge_search',
  ])
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
            action: 'create', knowledgeBaseId: 'default', title: 'Credential-bearing setup',
            body: 'Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz for the service.', type: 'procedure', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.99,
            retention: { durable: true, evidence: 'explicit' }, reason: 'Explicitly supplied setup.',
          },
          {
            action: 'conflict', knowledgeBaseId: 'default', targetId, title: 'Conflicting policy',
            body: 'This contradicts the existing policy.', type: 'decision', tags: ['policy'],
            scope: { kind: 'global' }, confidence: 0.99,
            retention: { durable: true, evidence: 'explicit' }, reason: 'Contradiction detected.',
          },
          {
            action: 'update', knowledgeBaseId: 'default', targetId, title: 'Existing policy',
            body: '## Operational note\n\nKeep the compatible operational note with the existing policy.',
            type: 'lesson', tags: ['operations'], scope: { kind: 'global' }, confidence: 0.95,
            retention: { durable: true, evidence: 'explicit' }, reason: 'Adds compatible operational context.',
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
    extractionMode: 'inline',
  })
  t.after(async () => {
    // FIFO after-hooks: close the harness observer before rm() unlinks the WAL db.
    try { await observer.close() } catch {}
    for (const dispose of disposers.reverse()) await dispose()
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 10 || error?.code !== 'EBUSY') throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
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
  assert.equal(unmounted.events.at(-1).type, 'assistant/message')

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
  const defaultBase = await observer.getKnowledgeBase('default')
  await observer.updateKnowledgeBase('default', { ...defaultBase, writebackPolicy: 'proactive' })
  await observer.updateSettings({ writebackProvider: 'global-provider', writebackModel: 'global-model' })
  const direct = sessionFor('direct', 1)
  await listeners.get('agent/turn-stopping')({ agent: { session: direct }, turn: 1, signal: new AbortController().signal })
  assert.equal(streamCalls, 2)
  assert.deepEqual(streamBudgets, [1200, 2400])
  assert.deepEqual(streamRoutes, [['mock', 'extractor'], ['mock', 'extractor']])
  assert.deepEqual(streamReasoning, [undefined, 'low'])
  assert.deepEqual(streamPolicies, ['proactive', 'proactive'])
  assert.equal((await observer.listCandidates('approved', 10)).length, 2)
  const pending = await observer.listCandidates('pending', 10)
  assert.equal(pending.length, 3)
  assert.ok(pending.some(candidate => candidate.action === 'conflict'))
  assert.ok(pending.some(candidate => candidate.draft.source?.evidence === 'inferred'))
  assert.ok(pending.some(candidate => candidate.draft.title === 'Credential-bearing setup'
    && /credential-like content requires manual review/.test(candidate.reason)))
  assert.equal((await observer.list({ status: 'active', limit: 10 })).items.length, 2)
  const updatedExisting = await observer.get(existing.id)
  assert.equal(updatedExisting.type, 'decision')
  assert.match(updatedExisting.body, /Operational note/)
  assert.equal(direct.events.at(-1).type, 'assistant/message')
})

const WRITEBACK_SUCCESS_CANDIDATES = { candidates: [{
  action: 'create', knowledgeBaseId: 'default', title: 'Durable writeback conclusion',
  body: 'The durable conclusion is confirmed for reuse.', type: 'fact', tags: ['wb'],
  scope: { kind: 'project', id: '/workspace/demo' }, confidence: 0.93,
  retention: { durable: true, evidence: 'explicit' }, reason: 'Confirmed durable conclusion.',
}] }

function createControlResponse() {
  const response = { status: 0, headers: {}, body: '' }
  response.writeHead = (status, headers) => {
    response.status = status
    response.headers = headers ?? {}
    return { end: body => { response.body = body ?? '' } }
  }
  response.end = body => { response.body = body ?? '' }
  return response
}

async function controlCall(routes, path, { method = 'GET', url = '/', headers = {}, parseJson = true } = {}) {
  const route = routes.get(path)
  assert.ok(route, `missing registered route ${path}`)
  const response = createControlResponse()
  await route.handler({ method, url, headers }, response)
  const body = parseJson ? JSON.parse(response.body || '{}') : response.body
  return { status: response.status, headers: response.headers, body }
}

const writebackStatusCall = (routes, sessionId, turn, method = 'GET') => controlCall(routes, '/knowledge-control/v1/writeback-status', {
  method,
  url: `/knowledge-control/v1/writeback-status?sessionId=${sessionId}&turn=${turn}`,
  headers: { 'x-dsh-knowledge-client': 'conversation-web' },
})

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

function writebackSession(id, turn) {
  return {
    id, header: { cwd: '/workspace/demo' }, events: [
      { type: 'turn/start', seq: 0, data: { turn } },
      { type: 'user/message', seq: 1, data: { id: `u-${id}`, role: 'user', content: [{ type: 'text', text: 'Record the durable conclusion for the knowledge base.' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, data: { turn, message: {
        id: `a-${id}`, role: 'assistant', content: [{ type: 'text', text: 'The durable conclusion is confirmed for reuse.' }],
        source: { kind: 'model', provider: 'mock', model: 'extractor' },
      } } },
    ],
    append(type, data, options) { const event = { type, seq: this.events.length, data, ...options }; this.events.push(event); return event },
  }
}

async function startWritebackHarness(t, { llm, extractionMode = 'detached', extractionTimeoutMs = 5000, retryDelays = [10, 10], finalDelay = 10, finalTimeoutMs = 5000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-wb-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const disposers = []
  const routes = new Map()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm,
    tools: { register() { return () => {} } },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(factory) { disposers.push(factory()) },
    get() { return undefined },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
  }
  apply(ctx, {
    backend: 'local', databasePath, remoteTimeoutMs: 5000, exposeApi: false,
    apiPrefix: '/knowledge-api/v1', extractionEnabled: true, extractionMaxTokens: 1000,
    extractionTimeoutMs, extractionMaxInputChars: 10000, defaultScope: 'project',
    extractionMode,
    extractionRetryDelaysMs: retryDelays,
    extractionFinalRetryDelayMs: finalDelay,
    extractionFinalTimeoutMs: finalTimeoutMs,
  })
  t.after(async () => {
    // node:test after-hooks run in registration order (FIFO): close the
    // harness observer before the disposers' rm() tries to unlink the WAL db.
    try { await observer.close() } catch {}
    for (const dispose of disposers.reverse()) await dispose()
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 10 || error?.code !== 'EBUSY') throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  })
  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(() => observer.close())
  await observer.patchKnowledgeBase('default', { description: 'Reusable writeback harness knowledge.' })
  await observer.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  return { root, databasePath, listeners, routes, observer }
}

const successStream = counter => ({
  async *stream() {
    counter.calls += 1
    yield { type: 'text-delta', text: JSON.stringify(WRITEBACK_SUCCESS_CANDIDATES) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

test('detached writeback survives an aborted turn signal (user follow-up no longer kills writeback)', async (t) => {
  const counter = { calls: 0 }
  const { listeners, routes, observer } = await startWritebackHarness(t, { llm: successStream(counter) })
  const controller = new AbortController()
  listeners.get('agent/turn-stopping')({ agent: { session: writebackSession('detach-1', 1) }, turn: 1, signal: controller.signal })
  controller.abort(new Error('user follow-up canceled the turn'))
  assert.equal(await waitFor(async () => (await observer.extractionJob('detach-1:1'))?.status === 'completed'), true)
  const state = await writebackStatusCall(routes, 'detach-1', 1)
  assert.equal(state.body.status, 'completed')
  assert.match(state.body.summary, /直写|待审|无需收录|已处理/)
  assert.equal(counter.calls, 1)
})

test('failed writeback auto-retries once in the background and completes', async (t) => {
  const counter = { calls: 0 }
  const llm = {
    async *stream() {
      counter.calls += 1
      if (counter.calls === 1) throw new Error('Request was aborted')
      yield { type: 'text-delta', text: JSON.stringify(WRITEBACK_SUCCESS_CANDIDATES) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { listeners, routes, observer } = await startWritebackHarness(t, { llm })
  listeners.get('agent/turn-stopping')({ agent: { session: writebackSession('retry-1', 1) }, turn: 1, signal: new AbortController().signal })
  assert.equal(await waitFor(async () => (await observer.extractionJob('retry-1:1'))?.status === 'completed'), true)
  const job = await observer.extractionJob('retry-1:1')
  assert.equal(job.attempts, 2)
  const state = await writebackStatusCall(routes, 'retry-1', 1)
  assert.equal(state.body.status, 'completed')
  assert.match(state.body.summary, /自动重试后成功/)
})

test('inline writeback terminalizes failed+retryable when the turn signal is already aborted', async (t) => {
  const llm = { async *stream() { throw new Error('Request was aborted') } }
  const { listeners, routes, observer } = await startWritebackHarness(t, { llm, extractionMode: 'inline' })
  const controller = new AbortController()
  controller.abort(new Error('interrupt'))
  await listeners.get('agent/turn-stopping')({ agent: { session: writebackSession('inline-1', 1) }, turn: 1, signal: controller.signal })
  const state = await writebackStatusCall(routes, 'inline-1', 1)
  assert.equal(state.body.status, 'failed')
  assert.equal(state.body.retryable, true)
  assert.match(state.body.summary, /回合已中断/)
  const job = await observer.extractionJob('inline-1:1')
  assert.equal(job?.status, 'failed')
})

test('automatic chain exhausts 2 backoff retries plus the final attempt, then fails retryable and exports the payload', async (t) => {
  const counter = { calls: 0 }
  const llm = { async *stream() { counter.calls += 1; throw new Error('Request was aborted') } }
  const { root, listeners, routes, observer } = await startWritebackHarness(t, { llm })
  listeners.get('agent/turn-stopping')({ agent: { session: writebackSession('chain-1', 1) }, turn: 1, signal: new AbortController().signal })
  assert.equal(await waitFor(async () => (await writebackStatusCall(routes, 'chain-1', 1)).body.status === 'failed'), true)
  const state = await writebackStatusCall(routes, 'chain-1', 1)
  assert.equal(state.body.retryable, true)
  assert.match(state.body.summary, /自动重试后仍失败/)
  assert.equal(counter.calls, 4)
  assert.equal((await observer.extractionJob('chain-1:1'))?.attempts, 1)
  assert.ok(state.body.export?.fileName.startsWith('回写失败-1-'))
  const exportsDir = join(root, 'exports')
  const files = await readdir(exportsDir)
  assert.equal(files.length, 1)
  const markdown = await readFile(join(exportsDir, files[0]), 'utf8')
  assert.match(markdown, /dsh-knowledge: session=chain-1 turn=1/)
  assert.match(markdown, /## 用户提问/)
  assert.match(markdown, /## 助手回答/)
  const download = await controlCall(routes, '/knowledge-control/v1/writeback-export', {
    url: '/knowledge-control/v1/writeback-export?sessionId=chain-1&turn=1',
    headers: { 'x-dsh-knowledge-client': 'conversation-web' },
    parseJson: false,
  })
  assert.equal(download.status, 200)
  assert.match(String(download.headers['content-disposition']), /attachment/)
  assert.match(String(download.body), /## 助手回答/)
  const unauthorized = await controlCall(routes, '/knowledge-control/v1/writeback-export', {
    url: '/knowledge-control/v1/writeback-export?sessionId=chain-1&turn=1',
    headers: {},
  })
  assert.equal(unauthorized.status, 401)

  // Manual retry restarts the full chain; the export file is reused, not duplicated.
  const post = await writebackStatusCall(routes, 'chain-1', 1, 'POST')
  assert.equal(post.body.status, 'running')
  assert.equal(await waitFor(async () => (await writebackStatusCall(routes, 'chain-1', 1)).body.status === 'failed'), true)
  const retried = await writebackStatusCall(routes, 'chain-1', 1)
  assert.equal(retried.body.retryable, true)
  assert.equal((await readdir(exportsDir)).length, 1)
  assert.equal(retried.body.export?.fileName, state.body.export?.fileName)
})

test('extraction timeout surfaces a semantic timeout error instead of a generic abort', async (t) => {
  const llm = {
    async *stream(request) {
      await new Promise((resolve, reject) => {
        const signal = request.signal
        if (signal?.aborted) { reject(new Error('Request was aborted')); return }
        signal?.addEventListener('abort', () => reject(new Error('Request was aborted')), { once: true })
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { listeners, routes, observer } = await startWritebackHarness(t, {
    llm, extractionMode: 'inline', extractionTimeoutMs: 700, retryDelays: [10, 10], finalDelay: 10, finalTimeoutMs: 700,
  })
  listeners.get('agent/turn-stopping')({ agent: { session: writebackSession('timeout-1', 1) }, turn: 1, signal: new AbortController().signal })
  assert.equal(await waitFor(async () => (await writebackStatusCall(routes, 'timeout-1', 1)).body.status === 'failed', 15000), true)
  const state = await writebackStatusCall(routes, 'timeout-1', 1)
  assert.match(state.body.error, /知识提取超时（预算 1 秒）/)
  assert.equal((await observer.extractionJob('timeout-1:1'))?.status, 'failed')
})

test('inline mode keeps the synchronous writeback semantics for successful turns', async (t) => {
  const counter = { calls: 0 }
  const { listeners, observer, routes } = await startWritebackHarness(t, { llm: successStream(counter), extractionMode: 'inline' })
  await listeners.get('agent/turn-stopping')({ agent: { session: writebackSession('inline-ok', 1) }, turn: 1, signal: new AbortController().signal })
  assert.equal(counter.calls, 1)
  assert.equal((await observer.extractionJob('inline-ok:1'))?.status, 'completed')
  const state = await writebackStatusCall(routes, 'inline-ok', 1)
  assert.equal(state.body.status, 'completed')
})

test('writeback chain configuration resolves detached mode, 300s budget, and export fallbacks', () => {
  const base = {
    backend: 'local', databasePath: join('x', 'knowledge.sqlite'), remoteTimeoutMs: 5000,
    exposeApi: false, apiPrefix: '/knowledge-api/v1',
  }
  const defaults = resolveConfig(base)
  assert.equal(defaults.extractionMode, 'detached')
  assert.equal(defaults.extractionTimeoutMs, 300_000)
  assert.equal(defaults.extractionFinalTimeoutMs, 1_800_000)
  assert.equal(defaults.extractionFinalRetryDelayMs, 60_000)
  assert.deepEqual(defaults.extractionRetryDelaysMs, [20_000, 60_000])
  assert.equal(defaults.exportsDir, join('x', 'exports'))
  const custom = resolveConfig({
    ...base,
    extractionRetryDelaysMs: [5, 'bad', 10, 999],
    extractionFinalRetryDelayMs: 15,
    extractionFinalTimeoutMs: 1200,
    exportsDir: '  ',
  })
  assert.deepEqual(custom.extractionRetryDelaysMs, [5, 10])
  assert.equal(custom.extractionFinalRetryDelayMs, 15)
  assert.equal(custom.extractionFinalTimeoutMs, 1200)
  assert.equal(custom.exportsDir, join('x', 'exports'))
  const remote = resolveConfig({
    backend: 'remote', remoteUrl: 'https://example.com/knowledge-api/v1',
    remoteToken: 'x'.repeat(24), remoteTimeoutMs: 5000,
  })
  assert.equal(remote.exportsDir, undefined)
  assert.equal(remote.extractionMode, 'detached')
  const zero = resolveConfig({ ...base, extractionTimeoutMs: 0 })
  assert.equal(zero.extractionTimeoutMs, 0)
})

test('markdown import helpers derive titles and split oversized bodies by H2 boundaries', () => {
  assert.equal(titleFromMarkdown('deployment.md', ''), 'deployment')
  assert.equal(titleFromMarkdown('note.markdown', '前言\n\n# 真标题\n'), 'note')
  assert.equal(titleFromMarkdown('', '## H2 first'), 'H2 first')
  assert.equal(titleFromMarkdown('x.md', '   \n# spaced\n'), 'spaced')
  assert.equal(titleFromMarkdown('a/b/c.md', ''), 'a/b/c')

  const body = `## A\n\n${'x'.repeat(30_000)}\n\n## B\n\n${'y'.repeat(30_000)}`
  const chunks = splitMarkdownByH2(body)
  assert.equal(chunks.length, 2)
  assert.ok(chunks[0].startsWith('## A'))
  assert.ok(chunks[1].startsWith('## B'))
  assert.ok(chunks.every(chunk => chunk.length <= IMPORT_MAX_BODY_CHARS))

  const exact = 'z'.repeat(IMPORT_MAX_BODY_CHARS)
  assert.deepEqual(splitMarkdownByH2(exact), [exact])
  const hardChunks = splitMarkdownByH2('w'.repeat(IMPORT_MAX_BODY_CHARS + 100))
  assert.ok(hardChunks.length >= 2)
  assert.ok(hardChunks.every(chunk => chunk.length <= IMPORT_MAX_BODY_CHARS))
  assert.deepEqual(splitMarkdownByH2('   '), [])
})
