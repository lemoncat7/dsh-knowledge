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

function signedHandle(output, prefix) {
  const handle = new RegExp(`handle: (${prefix}\\.[^\\s,)]+)`).exec(output)?.[1]
  assert.ok(handle, `expected ${prefix} handle in tool output`)
  return handle
}

test('AI note-reference tools use session handles, mounted write policy, and metadata-only note search', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-note-tools-'))
  const databasePath = join(root, 'knowledge.sqlite')
  const seed = new LocalKnowledgeProvider(databasePath)
  const entry = await seed.create({
    knowledgeBaseId: 'default', title: '生产部署流程', body: '发布服务前先备份数据并检查部署清单。',
    type: 'procedure', tags: ['deployment'], scope: { kind: 'global' }, confidence: .95,
  })
  const note = await seed.notes.createDocument('部署清单', null, '# 仅限笔记正文\n\nSECRET_NOTE_BODY_MUST_NOT_LEAK')
  await seed.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
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
  const observer = new LocalKnowledgeProvider(databasePath)
  t.after(async () => {
    await observer.close()
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })

  const session = { id: 'note-tool-session', header: { cwd: '/workspace/demo' }, snapshotEvents() { return this.events }, events: [] }
  directUserTurn(session, 1, '请把生产部署知识文档关联到部署清单笔记。')
  const exec = { agent: { session }, signal: new AbortController().signal }
  const knowledgeOutput = await tools.get('knowledge_search').execute({ query: '生产部署', base: 'default' }, exec)
  const knowledgeHandle = signedHandle(knowledgeOutput, 'k1')
  const noteOutput = await tools.get('knowledge_note_search').execute({ query: '部署清单' }, exec)
  const noteHandle = signedHandle(noteOutput, 'n1')
  assert.match(noteOutput, /部署清单\.md/)
  assert.doesNotMatch(noteOutput, /SECRET_NOTE_BODY_MUST_NOT_LEAK/)

  const added = JSON.parse(await tools.get('knowledge_note_references').execute({
    knowledgeHandle, operation: 'add', noteHandles: [noteHandle],
  }, exec))
  assert.equal(added.changed, 1)
  assert.equal(added.references[0].name, '部署清单.md')
  assert.equal((await observer.listKnowledgeNoteReferences(entry.id))[0].sourceSessionId, session.id)

  const listed = JSON.parse(await tools.get('knowledge_note_references').execute({
    knowledgeHandle, operation: 'list',
  }, exec))
  assert.equal(listed.changed, 0)
  assert.equal(listed.references.length, 1)

  const otherSession = { id: 'other-note-session', header: { cwd: '/workspace/demo' }, snapshotEvents() { return this.events }, events: [] }
  directUserTurn(otherSession, 1, '请把生产部署知识文档关联到部署清单笔记。')
  const otherExec = { agent: { session: otherSession }, signal: new AbortController().signal }
  const otherKnowledgeOutput = await tools.get('knowledge_search').execute({ query: '生产部署', base: 'default' }, otherExec)
  const otherKnowledgeHandle = signedHandle(otherKnowledgeOutput, 'k1')
  await assert.rejects(
    () => tools.get('knowledge_note_references').execute({
      knowledgeHandle: otherKnowledgeHandle, operation: 'add', noteHandles: [noteHandle],
    }, otherExec),
    /knowledge note handle does not belong to this session/,
  )

  directUserTurn(session, 2, '继续处理部署问题。')
  await assert.rejects(
    () => tools.get('knowledge_note_references').execute({
      knowledgeHandle, operation: 'add', noteHandles: [noteHandle],
    }, exec),
    /requires an explicit request in the current direct user message/,
  )

  await observer.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'none', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  directUserTurn(session, 3, '请再把生产部署知识文档关联到部署清单笔记。')
  await assert.rejects(
    () => tools.get('knowledge_note_references').execute({
      knowledgeHandle, operation: 'add', noteHandles: [noteHandle],
    }, exec),
    /mounted read-only/,
  )

  await observer.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  directUserTurn(session, 4, '请移除生产部署知识文档和部署清单笔记的关联。')
  const removed = JSON.parse(await tools.get('knowledge_note_references').execute({
    knowledgeHandle, operation: 'remove', noteHandles: [noteHandle],
  }, exec))
  assert.equal(removed.changed, 1)
  assert.deepEqual(removed.references, [])
})
