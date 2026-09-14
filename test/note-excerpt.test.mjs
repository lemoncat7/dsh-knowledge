import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { DEFAULT_KNOWLEDGE_BASE_ID } from '../lib/domain.js'
import { noteExcerptMarkdown } from '../lib/note-excerpt.js'
import { createServer } from 'node:http'
import { registerKnowledgeApi } from '../lib/api.js'

test('note excerpt creates/appends atomically, preserves links and rejects conflicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-excerpt-'))
  let provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const note = await provider.createNoteDocument('来源.md', null, '第一段\n第二段')
  const input = { requestId: 'excerpt-request-000001', noteId: note.id, text: '第一段\n第二段', knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID, title: '摘录知识' }
  const entry = await provider.excerptNote(input)
  assert.equal(entry.title, '摘录知识')
  assert.equal(entry.body, `[第一段](note://${note.id})\n\n[第二段](note://${note.id})`)
  assert.equal((await provider.listKnowledgeNoteReferences(entry.id)).length, 1)
  assert.equal((await provider.readNote(note.id)).content.toString(), '第一段\n第二段')
  assert.equal((await provider.excerptNote(input)).id, entry.id)
  await provider.close()
  provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  assert.equal((await provider.excerptNote(input)).version, 1)
  await assert.rejects(provider.excerptNote({ ...input, text: 'different' }), /已提交/)
  const append = { ...input, requestId: 'excerpt-request-000002', documentId: entry.id, expectedVersion: entry.version, text: '新增' }
  const updated = await provider.excerptNote(append)
  assert.equal(updated.version, 2)
  assert.ok(updated.body.startsWith(entry.body))
  assert.equal((await provider.excerptNote(append)).version, 2)
  assert.equal((await provider.listKnowledgeNoteReferences(entry.id)).length, 1)
  await assert.rejects(provider.excerptNote({ ...append, requestId: 'excerpt-request-000003' }), /已更新/)
  await provider.renameNote(note.id, '改名.md')
  assert.equal((await provider.listKnowledgeNoteReferences(entry.id))[0].note.name, '改名.md')
  assert.ok((await provider.get(entry.id)).body.includes(`note://${note.id}`))
  await provider.finalize(entry.id, 'complete')
  await assert.rejects(provider.excerptNote({ ...append, requestId: 'excerpt-request-000004', expectedVersion: 3 }), /定稿/)
  await assert.rejects(provider.excerptNote({ ...input, requestId: 'excerpt-request-000005', noteId: 'note_' + '0'.repeat(32) }), /不可用/)
  assert.equal((await provider.list({ limit: 100 })).items.length, 1)
})

test('excerpt link labels escape Markdown and HTML rather than executing selected text', () => {
  const id = 'note_' + 'a'.repeat(32)
  const result = noteExcerptMarkdown(id, '[链接](javascript:bad) <script> *强调*')
  assert.ok(result.includes('\\[链接\\]'))
  assert.ok(result.includes('\\<script\\>'))
  assert.ok(result.endsWith(`](note://${id})`))
})

test('a reference write failure rolls back new content and receipt together', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-excerpt-rollback-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const note = await provider.createNoteDocument('来源.md', null, '内容')
  const input = { requestId: 'excerpt-rollback-0001', noteId: note.id, text: '内容', knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID }
  provider.db.exec("CREATE TRIGGER fail_excerpt_reference BEFORE INSERT ON knowledge_note_references BEGIN SELECT RAISE(ABORT, 'reference failure'); END;")
  await assert.rejects(provider.excerptNote(input), /reference failure/)
  assert.equal((await provider.list({ limit: 100 })).items.length, 0)
  provider.db.exec('DROP TRIGGER fail_excerpt_reference')
  const entry = await provider.excerptNote(input)
  assert.equal(entry.version, 1)
  assert.equal((await provider.listKnowledgeNoteReferences(entry.id)).length, 1)
})

test('excerpt HTTP endpoint enforces read/write permissions and version conflicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-excerpt-api-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, get() {} }, provider, '/api')
  const server = createServer((req,res) => void handler(req,res))
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{ await new Promise(resolve=>server.close(resolve));await provider.close();await rm(root,{recursive:true,force:true}) })
  const read = provider.createApiToken('read', ['read']).token
  const write = provider.createApiToken('read/write', ['read','write']).token
  const note = await provider.createNoteDocument('来源.md', null, '内容')
  const input = { requestId:'excerpt-http-request-1', noteId:note.id, text:'内容', knowledgeBaseId:DEFAULT_KNOWLEDGE_BASE_ID }
  const post=(token,body)=>fetch(`http://127.0.0.1:${server.address().port}/api/note-excerpts`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
  assert.equal((await post(read,input)).status,403)
  const response=await post(write,input)
  assert.equal(response.status,200)
  const entry=await response.json()
  const append={...input,requestId:'excerpt-http-request-2',documentId:entry.id,expectedVersion:5}
  assert.equal((await post(write,append)).status,409)
  assert.equal((await post(write,{...append,expectedVersion:1})).status,200)
  assert.equal((await post(write,{...append,expectedVersion:1})).status,200)
  assert.equal((await provider.get(entry.id)).version,2)
})
