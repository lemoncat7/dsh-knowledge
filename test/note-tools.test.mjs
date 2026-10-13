import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, LocalKnowledgeProvider } from '../lib/index.js'

const config = {
  backend: 'local', remoteTimeoutMs: 5000, exposeApi: false,
  apiPrefix: '/knowledge-api/v1', extractionEnabled: false,
}

function directUserTurn(session, turn, text) {
  session.events.push(
    { type: 'turn/start', seq: session.events.length, data: { turn } },
    { type: 'user/message', seq: session.events.length + 1, data: {
      id: `user-${turn}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
    } },
  )
}

test('note changes require later conversational confirmation and preserve exact content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'note-chat-confirm-'))
  const p = new LocalKnowledgeProvider(join(root, 'db.sqlite'))
  const { registerKnowledgeNoteTools } = await import('../lib/note-tools.js')
  const { KnowledgeNoteHandleCodec } = await import('../lib/note-reference-handle.js')
  const { KnowledgeHandleCodec } = await import('../lib/retrieval.js')
  const tools = new Map()
  registerKnowledgeNoteTools({ tools: { register(d) { tools.set(d.name, d) } }, get() { throw Error('must not call popup service') } }, p, new KnowledgeNoteHandleCodec(Buffer.alloc(32, 1)), new KnowledgeHandleCodec(Buffer.alloc(32, 2)))
  t.after(async () => { await p.close(); await rm(root, { recursive: true, force: true }) })
  const session = { id: 'chat', events: [], snapshotEvents() { return this.events }, header: {} }
  const exec = { agent: { session }, signal: new AbortController().signal }
  const run = async (name, args) => JSON.parse(await tools.get(name).execute(args, exec))
  const confirm = id => run('knowledge_note_confirm', { confirmationId: id })
  directUserTurn(session, 1, '整理一下吧')
  const plan = await run('knowledge_note_create', { kind: 'document', name: '课程', content: '保留原文' })
  assert.equal(plan.modified, false)
  assert.deepEqual(await p.listNotes({ parentId: null }), [])
  await assert.rejects(() => confirm(plan.confirmationId), /下一轮/)
  directUserTurn(session, 2, '可以')
  const created = await confirm(plan.confirmationId)
  await assert.rejects(() => confirm(plan.confirmationId), /失效/)
  const handle = created.note.handle
  const initial = await run('knowledge_note_read', { noteHandle: handle })
  const change = await run('knowledge_note_update', { noteHandle: handle, operation: 'append_content', expectedVersion: initial.note.version, value: '\\n补充图文' })
  directUserTurn(session, 3, '按这个改')
  await confirm(change.confirmationId)
  assert.equal((await run('knowledge_note_read', { noteHandle: handle })).content, '保留原文\\n补充图文')
  const rename = await run('knowledge_note_update', { noteHandle: handle, operation: 'rename', value: '新标题' })
  directUserTurn(session, 4, '取消')
  await assert.rejects(() => confirm(rename.confirmationId), /取消/)
  const stale = await run('knowledge_note_update', { noteHandle: handle, operation: 'rename', value: '新标题' })
  const node = (await p.listNotes({ parentId: null }))[0]
  await p.updateNoteContent(node.id, new TextEncoder().encode('他人新内容'))
  directUserTurn(session, 5, '确认')
  await assert.rejects(() => confirm(stale.confirmationId), /变化/)
  assert.equal((await p.getNote(node.id)).name, '课程.md')
  const replacement = await run('knowledge_note_update', { noteHandle: handle, operation: 'replace_content', expectedVersion: (await p.getNote(node.id)).version, value: '全文' })
  assert.match(replacement.summary, /整篇覆盖/)
  const other = { ...exec, agent: { session: { ...session, id: 'other' } } }
  await assert.rejects(() => tools.get('knowledge_note_confirm').execute({ confirmationId: replacement.confirmationId }, other), /失效/)
  directUserTurn(session, 6, '好的')
  await confirm(replacement.confirmationId)
  assert.equal((await run('knowledge_note_read', { noteHandle: handle })).content, '全文')
  const version = (await p.getNote(node.id)).version
  await assert.rejects(() => run('knowledge_note_update', { noteHandle: handle, operation: 'append_content', expectedVersion: version, value: '\n\n' }), /空白变化/)
  await assert.rejects(() => run('knowledge_note_update', { noteHandle: handle, operation: 'replace_range', expectedVersion: version, oldText: '不存在', value: '新' }), /唯一匹配/)
  await p.updateNoteContent(node.id, new TextEncoder().encode('前十三节原文\n十四节旧规范\n十五节旧规范\n后文原样'))
  const partial = await run('knowledge_note_update', { noteHandle: handle, operation: 'replace_range', expectedVersion: (await p.getNote(node.id)).version, oldText: '十四节旧规范\n十五节旧规范', value: '十四节通用规范' })
  assert.match(partial.summary, /范围外.*原样保留/)
  directUserTurn(session, 7, '空行那个不需要。合并内容我确认了')
  await confirm(partial.confirmationId)
  assert.equal((await run('knowledge_note_read', { noteHandle: handle })).content, '前十三节原文\n十四节通用规范\n后文原样')
})

test('conversational confirmation rejects changed or negated instructions', async () => {
  const { isNoteConfirmation } = await import('../lib/note-confirmation.js')
  for (const text of ['可以', '合并内容我确认了', '空行那个不需要。合并内容我确认了']) assert.equal(isNoteConfirmation(text), true, text)
  for (const text of ['我不确认了', '可以，但是改成另外的标题', '如果我确认了', '你说我确认了', '可以吗']) assert.equal(isNoteConfirmation(text), false, text)
})

test('AI note deletion preserves notes referenced by knowledge documents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-note-delete-tools-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const seed = new LocalKnowledgeProvider(databasePath)
  const entry = await seed.create({ group: '测试分组',
    knowledgeBaseId: 'default', title: '部署依据', body: '部署依据引用原始笔记。',
    type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .9,
  })
  const note = await seed.createNoteDocument('原始依据', null, '# 原始依据')
  await seed.addKnowledgeNoteReference(entry.id, note.id, 'user')
  await seed.close()

  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: { async *stream() {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    on() { return () => {} },
    effect(factory) { disposers.push(factory()) },
    get() { return undefined },
  }
  apply(ctx, { ...config, databasePath })
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })
  const session = { id: 'protected-note-session', header: { cwd: '/workspace/demo' }, snapshotEvents() { return this.events }, events: [] }
  const exec = { agent: { session }, signal: new AbortController().signal }
  directUserTurn(session, 1, '请搜索并删除原始依据笔记。')
  const search = await tools.get('knowledge_note_search').execute({ query: '原始依据' }, exec)
  const handle = /handle: (n1\.[^\s,)]+)/.exec(search)?.[1]
  assert.ok(handle)
  await assert.rejects(
    () => tools.get('knowledge_note_delete').execute({ noteHandle: handle }, exec),
    /referenced by 1 knowledge document/,
  )
})
