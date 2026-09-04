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

test('AI note tools create, browse, read, update, move, and safely delete session-bound notes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-note-workspace-tools-'))
  const databasePath = join(root, 'knowledge.sqlite')
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
  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(async () => {
    await observer.close()
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })

  const session = { id: 'note-workspace-session', header: { cwd: '/workspace/demo' }, snapshotEvents() { return this.events }, events: [] }
  const exec = { agent: { session }, signal: new AbortController().signal }
  directUserTurn(session, 1, '请新建一个项目笔记目录，并在里面创建一篇发布计划笔记。')
  const folderResult = JSON.parse(await tools.get('knowledge_note_create').execute({ kind: 'folder', name: '项目笔记' }, exec))
  assert.equal(folderResult.storage, 'local')
  assert.equal(folderResult.note.kind, 'folder')
  const noteResult = JSON.parse(await tools.get('knowledge_note_create').execute({
    kind: 'document', name: '发布计划', parentFolderHandle: folderResult.note.handle,
    content: '# 发布计划\n\n第一阶段。',
  }, exec))
  assert.equal(noteResult.note.name, '发布计划.md')

  const folderListing = JSON.parse(await tools.get('knowledge_note_list').execute({ folderHandle: folderResult.note.handle }, exec))
  assert.deepEqual(folderListing.items.map(item => item.name), ['发布计划.md'])
  const search = JSON.parse(await tools.get('knowledge_note_list').execute({ query: '发布计划' }, exec))
  assert.equal(search.items[0].handle, noteResult.note.handle)
  const initial = JSON.parse(await tools.get('knowledge_note_read').execute({ noteHandle: noteResult.note.handle, maxChars: 8 }, exec))
  assert.equal(initial.content.length, 8)
  assert.equal(initial.nextOffset, 8)

  directUserTurn(session, 2, '请给发布计划笔记追加第二阶段，并把笔记改名为正式发布计划。')
  await tools.get('knowledge_note_update').execute({
    noteHandle: noteResult.note.handle, operation: 'append_content', value: '\n\n第二阶段。',
  }, exec)
  const renamed = JSON.parse(await tools.get('knowledge_note_update').execute({
    noteHandle: noteResult.note.handle, operation: 'rename', value: '正式发布计划.md',
  }, exec))
  assert.equal(renamed.note.name, '正式发布计划.md')
  const renamedNode = (await observer.searchNotes('正式发布计划', 10))[0]
  assert.ok(renamedNode)
  const updated = await observer.readNote(renamedNode.id)
  assert.match(new TextDecoder().decode(updated.content), /第一阶段。[\s\S]*第二阶段。/)

  const otherSession = { id: 'other-note-workspace-session', header: { cwd: '/workspace/demo' }, snapshotEvents() { return this.events }, events: [] }
  directUserTurn(otherSession, 1, '请查看正式发布计划笔记。')
  await assert.rejects(
    () => tools.get('knowledge_note_read').execute({ noteHandle: noteResult.note.handle }, {
      agent: { session: otherSession }, signal: new AbortController().signal,
    }),
    /does not belong to this session/,
  )

  directUserTurn(session, 3, '请把正式发布计划笔记移动到笔记根目录。')
  const moved = JSON.parse(await tools.get('knowledge_note_move').execute({ noteHandle: noteResult.note.handle }, exec))
  assert.equal(moved.note.name, '正式发布计划.md')
  assert.deepEqual((await observer.listNotes({ parentId: null })).map(item => item.name), ['项目笔记', '正式发布计划.md'])

  directUserTurn(session, 4, '继续讨论发布，不要修改笔记。')
  await assert.rejects(
    () => tools.get('knowledge_note_update').execute({
      noteHandle: noteResult.note.handle, operation: 'replace_content', value: '不应写入',
    }, exec),
    /requires an explicit request in the current direct user message/,
  )

  directUserTurn(session, 5, '请删除正式发布计划笔记。')
  await tools.get('knowledge_note_delete').execute({ noteHandle: noteResult.note.handle }, exec)
  assert.deepEqual(await observer.searchNotes('正式发布计划', 10), [])
})

test('AI note deletion preserves notes referenced by knowledge documents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-note-delete-tools-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const seed = new LocalKnowledgeProvider(databasePath)
  const entry = await seed.create({
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
