import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { ExtractionCoordinator } from '../lib/extraction.js'
import { conversationSaveTool } from '../lib/conversation-save-tool.js'

const signal = () => new AbortController().signal

async function fixture(t, { conversationEnabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-conversation-save-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'workspace')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: '命令写入库', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot, conversationEnabled })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  return { provider, kb: base.id, sourceDir, workspaceRoot, root }
}

async function mountSession(provider, targetId, knowledgeBaseId, writeMode = 'direct') {
  await provider.upsertMount({ targetKind: 'session', targetId, knowledgeBaseId, enabled: true, recallEnabled: true, writeMode,
    includeTags: [], excludeTags: [], extractionInstructions: '' })
}

const turnEvents = turn => [
  { type: 'turn/start', seq: 1, data: { turn } },
  { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把这段内容保存到知识库' }] } },
]

test('a command write creates exactly one new page with conversation provenance and is idempotent', async t => {
  const { provider, kb } = await fixture(t)
  await mountSession(provider, 's1', kb)
  const body = '第一段正文内容，用于核对。\n\n第二段补充说明。'
  const first = await provider.saveConversation({ sessionId: 's1', turn: 2, title: '命令保存页', body, sourcePath: 'docs/source.md' })
  assert.match(first.relPath, /^wiki\/notes\/[a-f0-9]{64}\.md$/u, '页面固定新建在 wiki/notes/<hash>.md')
  assert.match(first.pageId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)
  assert.equal(first.knowledgeBaseId, kb)
  assert.equal(first.duplicate, false)
  assert.deepEqual(first.scope, { kind: 'global' })

  const manifest = await provider.wiki.store(kb).manifest()
  assert.equal(manifest.pages.length, 1)
  const page = manifest.pages[0]
  assert.equal(page.relPath, first.relPath)
  assert.equal(page.pageId, first.pageId)
  assert.deepEqual(page.provenance, { kind: 'conversation', sessionId: 's1', turn: 2, sourcePath: 'docs/source.md' })
  assert.deepEqual(page.scope, { kind: 'global' })
  const entry = await provider.get(first.entryId)
  assert.equal(entry.title, '命令保存页')
  assert.ok(entry.body.includes(body), '正文按命令写入磁盘')
  const hits = await provider.search({ text: '命令保存页', limit: 5 })
  assert.ok(hits.some(hit => hit.entry.id === first.entryId), '新页可检索')

  const before = await readFile(join(await provider.wiki.store(kb).layout.workspaceRoot, first.relPath))
  const again = await provider.saveConversation({ sessionId: 's1', turn: 2, title: '命令保存页', body, sourcePath: 'docs/source.md' })
  assert.equal(again.duplicate, true, '同 session+turn+title+body 幂等')
  assert.equal(again.pageId, first.pageId)
  assert.equal(again.relPath, first.relPath)
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 1, '重复命令不重复建页')
  assert.deepEqual(await readFile(join(await provider.wiki.store(kb).layout.workspaceRoot, first.relPath)), before)

  const project = await provider.saveConversation({ sessionId: 's1', turn: 3, title: '项目范围页', body: '项目项目项目正文。', projectId: 'proj-a' })
  assert.deepEqual(project.scope, { kind: 'project', id: 'proj-a' })
  assert.notEqual(project.pageId, first.pageId)
  const projectHits = await provider.search({ text: '项目项目项目正文', projectId: 'proj-a', limit: 5 })
  assert.ok(projectHits.some(hit => hit.entry.id === project.entryId), '项目范围内可检索')
  const globalHits = await provider.search({ text: '项目项目项目正文', limit: 5 })
  assert.equal(globalHits.some(hit => hit.entry.id === project.entryId), false, '项目范围页不会出现在全局检索里')
})

test('the command never overwrites an existing page', async t => {
  const { provider, kb } = await fixture(t)
  await mountSession(provider, 's1', kb)
  const existing = await provider.create({ knowledgeBaseId: kb, title: '既有页', body: '既有正文，不允许被命令覆盖。', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 0.9 })
  const manifest = await provider.wiki.store(kb).manifest()
  const existingPage = manifest.pages.find(item => item.entryId === existing.id)
  const path = join(await provider.wiki.store(kb).layout.workspaceRoot, existingPage.relPath)
  const before = await readFile(path)
  const saved = await provider.saveConversation({ sessionId: 's1', turn: 4, title: '既有页', body: '既有正文，不允许被命令覆盖。' })
  assert.notEqual(saved.entryId, existing.id, '同标题也只新建，不按 target 覆盖')
  assert.deepEqual(await readFile(path), before)
  assert.equal((await provider.get(existing.id)).version, existing.version)
})

test('conversation write disabled, missing selection and read-only selection are refused with reason codes', async t => {
  const disabled = await fixture(t, { conversationEnabled: false })
  await mountSession(disabled.provider, 's1', disabled.kb)
  await assert.rejects(() => disabled.provider.saveConversation({ sessionId: 's1', turn: 1, title: '拒绝页', body: '不应写入。' }),
    /WIKI_CONVERSATION_SAVE_DISABLED/u)
  assert.equal((await disabled.provider.wiki.store(disabled.kb).manifest()).pages.length, 0)

  const unselected = await fixture(t)
  // A project mount must never be used as a fallback for the session selection.
  await unselected.provider.upsertMount({ targetKind: 'project', targetId: 'proj-a', knowledgeBaseId: unselected.kb, enabled: true,
    recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '' })
  await assert.rejects(() => unselected.provider.saveConversation({ sessionId: 's1', turn: 1, title: '未选择', body: '不应写入。', projectId: 'proj-a' }),
    error => /WIKI_CONVERSATION_SAVE_NO_SELECTION/u.test(error.message) && error.message.includes('未选择知识库，未写入'))
  assert.equal((await unselected.provider.wiki.store(unselected.kb).manifest()).pages.length, 0)

  const readOnly = await fixture(t)
  await mountSession(readOnly.provider, 's1', readOnly.kb, 'audit')
  await assert.rejects(() => readOnly.provider.saveConversation({ sessionId: 's1', turn: 1, title: '只读', body: '不应写入。' }),
    /WIKI_CONVERSATION_SAVE_READ_ONLY/u)
  assert.equal((await readOnly.provider.wiki.store(readOnly.kb).manifest()).pages.length, 0)
})

test('a selected base that does not accept command writes is refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-conversation-save-normal-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  await mountSession(provider, 's1', 'default')
  await assert.rejects(() => provider.saveConversation({ sessionId: 's1', turn: 1, title: '普通库', body: '普通库不接收命令写入。' }),
    /WIKI_CONVERSATION_SAVE_UNSUPPORTED_TARGET/u)
  assert.equal((await provider.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })).items.length, 0)
})

test('the knowledge operation reports the real result and verifies the session id', async t => {
  const { provider, kb } = await fixture(t)
  await mountSession(provider, 's1', kb)
  const tool = conversationSaveTool(provider)
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(Object.hasOwn(tool.parameters.properties, 'targetPageId'), false, '不提供 targetPageId，命令只新建')
  const session = { id: 's1', header: { cwd: '/project' }, snapshotEvents: () => turnEvents(5) }
  const result = JSON.parse(await tool.execute({ sessionId: 's1', title: '工具命令页', body: '首段摘要内容。\n\n第二段。' }, { agent: { session }, signal: signal() }))
  assert.equal(result.status, 'created')
  assert.equal(result.duplicate, false)
  assert.match(result.relPath, /^wiki\/notes\/[a-f0-9]{64}\.md$/u)
  assert.deepEqual(result.provenance, { sessionId: 's1', turn: 5 })
  assert.equal(result.excerpt, '首段摘要内容。')
  const entry = await provider.get(result.entryId)
  assert.equal(entry.title, '工具命令页')
  assert.equal(result.knowledgeBaseName, '命令写入库')

  await assert.rejects(() => tool.execute({ sessionId: 'other-session', title: '串会话', body: '不应写入。' }, { agent: { session }, signal: signal() }),
    /WIKI_CONVERSATION_SAVE_SESSION_MISMATCH/u)
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 1)
})

function extractionFixture(ctx, provider) {
  const coordinator = new ExtractionCoordinator(ctx, provider, {
    extractionMaxInputChars: 20000, extractionMaxTokens: 1000, extractionTimeoutMs: 5000, defaultScope: 'global',
  })
  const snapshot = {
    sourceKey: 's1:1', sessionId: 's1', turn: 1, userText: '记住这条写入约定', userTextTruncated: false,
    assistantText: '约定内容：选库后自动回写按分类路由。', route: { provider: 'mock', model: 'mock' },
  }
  return { coordinator, snapshot }
}

const candidateFor = knowledgeBaseId => JSON.stringify({ candidates: [{
  action: 'create', knowledgeBaseId, group: '测试分组', documentTitle: '自动回写约定',
  body: '选中库后自动回写仍需按分类路由。', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 0.9,
  retention: { durable: true, evidence: 'explicit' }, reason: '用户明确要求的约定',
}] })

test('automatic writeback stays on for the session-selected library, with no library-type branch', async t => {
  const { provider, kb } = await fixture(t)
  await mountSession(provider, 's1', kb)
  const ctx = { logger: { debug() {}, info() {}, warn() {}, error() {} }, llm: { async *stream() {
    yield { type: 'text-delta', text: candidateFor(kb) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const { coordinator, snapshot } = extractionFixture(ctx, provider)
  t.after(() => coordinator.close())

  const result = await coordinator.runSnapshot(snapshot, signal())
  assert.equal(result.status, 'completed')
  assert.equal(result.directCount, 1, '选中库仍参与自动回写')
  const manifest = await provider.wiki.store(kb).manifest()
  assert.equal(manifest.pages.length, 1, '自动回写写入选中库')
  assert.equal(manifest.pages[0].provenance.kind, 'conversation')
  assert.equal(manifest.pages[0].provenance.sessionId, 's1')
})

test('automatic writeback writes nothing when no library is selected', async t => {
  const { provider, kb } = await fixture(t)
  const ctx = { logger: { debug() {}, info() {}, warn() {}, error() {} }, llm: { async *stream() {
    throw new Error('model must not run without a selected library')
  } } }
  const { coordinator, snapshot } = extractionFixture(ctx, provider)
  t.after(() => coordinator.close())

  const result = await coordinator.runSnapshot(snapshot, signal())
  assert.equal(result.status, 'unmounted')
  assert.equal(result.directCount, 0)
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 0)
})
