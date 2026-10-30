import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerKnowledgeTools } from '../lib/tools.js'
import { knowledgeEntry } from '../lib/tool-entry.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { KnowledgeHandleCodec } from '../lib/retrieval.js'
import { KnowledgeNoteHandleCodec } from '../lib/note-reference-handle.js'

async function fixture(t, writeMode = 'direct') {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-entry-'))
  const provider = new LocalKnowledgeProvider(join(root, 'db.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const registered = new Map(), codec = new KnowledgeHandleCodec(Buffer.alloc(32, 1))
  registerKnowledgeTools({ tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }, llm: {} }, provider, codec, new KnowledgeNoteHandleCodec(Buffer.alloc(32, 2)))
  const session = { id: 'entry-session', header: {}, snapshotEvents: () => [] }
  const exec = { agent: { session }, signal: new AbortController().signal }
  const mount = { targetKind: 'session', targetId: session.id, knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode, includeTags: ['allowed'], excludeTags: [], extractionInstructions: '' }
  await provider.upsertMount(mount)
  const document = await provider.create({ knowledgeBaseId: 'default', group: '旧组', title: 'private title', body: 'PRIVATE BODY', type: 'fact', tags: ['allowed'], scope: { kind: 'global' }, confidence: .9 })
  const entry = registered.get('knowledge')
  const call = (tool, args, context = exec) => entry.execute({ action: 'call', tool, arguments: args }, context)
  return { registered, provider, codec, mount, document, entry, call, exec }
}

test('one public registration, complete lazy catalog and no document/provider disclosure', async t => {
  const f = await fixture(t)
  assert.deepEqual([...f.registered.keys()], ['knowledge'])
  f.provider.resolveMounts = () => { throw new Error('discovery must not perform provider I/O') }
  const listed = await f.entry.execute({ action: 'list' }, f.exec)
  assert.doesNotMatch(listed, /PRIVATE BODY|private title/)
  const operations = JSON.parse(listed).operations
  assert.equal(operations.length, 19)
  assert.ok(operations.every(item => !('parameters' in item)))
  let expanded = 0
  for (const operation of operations) {
    const details = await f.entry.execute({ action: 'describe', tool: operation.name }, f.exec)
    const schema = JSON.parse(details)
    assert.equal(schema.name, operation.name)
    assert.equal(schema.parameters.type, 'object')
    expanded += details.length
  }
  assert.ok(JSON.stringify(f.entry.parameters).length + f.entry.description.length < expanded / 5)
  assert.equal(f.entry.isConcurrencySafe({ action: 'describe' }), true)
  assert.equal(f.entry.isConcurrencySafe({ action: 'call', tool: 'knowledge_note_confirm' }), false)
})

test('entry rejects unknown/recursive operations, invalid schemas, no owner and cancellation', async t => {
  const f = await fixture(t)
  for (const args of [null, [], {}, { action: 'bad' }, { action: 'call', tool: 'knowledge' }, { action: 'call', tool: '__proto__' }, { action: 'call', tool: 'knowledge_search', arguments: [] }, { action: 'list', arguments: {} }, { action: 'list', tool: 'knowledge_read' }, { action: 'list', extra: true }]) {
    await assert.rejects(f.entry.execute(args, f.exec))
  }
  await assert.rejects(f.call('knowledge_search', {}), /query/)
  await assert.rejects(f.call('knowledge_note_confirm', { confirmationId: 'x', approved: true }), /additional/)
  await assert.rejects(f.call('knowledge_document_group_assign', { group: 'x', documents: [] }), /fewer than 1/)
  await assert.rejects(f.entry.execute({ action: 'list' }, { signal: f.exec.signal }), /session/)
  await assert.rejects(f.entry.execute({ action: 'list' }, { ...f.exec, signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.throws(() => knowledgeEntry(new Map([['knowledge', f.entry]])), /Recursive/)
})

test('dispatch preserves mounted scope, foreign session rejection, live revocation and read-only mode', async t => {
  const f = await fixture(t, 'none')
  const handle = f.codec.encode(f.exec.agent.session.id, f.document)
  const args = { group: '新组', documents: [{ handle, expectedVersion: f.document.version }] }
  assert.match(await f.call('knowledge_read', { handle }), /PRIVATE BODY/)
  assert.equal(JSON.parse(await f.call('knowledge_document_group_assign', args)).results[0].status, 'failed')
  await assert.rejects(f.call('knowledge_read', { handle }, { ...f.exec, agent: { session: { ...f.exec.agent.session, id: 'other' } } }), /session/)
  await f.provider.upsertMount({ ...f.mount, includeTags: [], excludeTags: ['allowed'] })
  await assert.rejects(f.call('knowledge_read', { handle }), /scope/)
  await f.provider.upsertMount({ ...f.mount, writeMode: 'direct' })
  assert.equal(JSON.parse(await f.call('knowledge_document_group_assign', args)).results[0].status, 'applied')
  assert.equal((await f.provider.get(f.document.id)).body, f.document.body)
  await f.provider.upsertMount({ ...f.mount, enabled: false })
  await assert.rejects(f.call('knowledge_read', { handle }), /scope/)
  await assert.rejects(f.call('knowledge_base_create', { name: 'Not authorized' }), /explicit request/)
})

test('audit group changes still require review and reject stale versions through entry', async t => {
  const f = await fixture(t, 'audit')
  const args = { group: '新组', documents: [{ handle: f.codec.encode(f.exec.agent.session.id, f.document), expectedVersion: f.document.version }] }
  const result = JSON.parse(await f.call('knowledge_document_group_assign', args)).results[0]
  assert.equal(result.status, 'pending-review')
  assert.equal((await f.provider.get(f.document.id)).group, '旧组')
  assert.equal(JSON.parse(await f.call('knowledge_document_group_assign', args)).results[0].candidateId, result.candidateId)
  await f.provider.review(result.candidateId, { decision: 'approve' })
  assert.equal((await f.provider.get(f.document.id)).group, '新组')
  assert.equal(JSON.parse(await f.call('knowledge_document_group_assign', args)).results[0].status, 'failed')
})

test('real DSH runtime registers only entry and host denial prevents execution', async t => {
  const f = await fixture(t)
  const ctx = new Context(), prompt = ctx.plugin(SystemPrompt)
  await prompt
  const runtime = ctx.plugin(ToolRuntime)
  await runtime
  t.after(async () => { await runtime.dispose(); await prompt.dispose() })
  ctx.tools.register(f.entry)
  const request = { ...f.exec, callId: 'entry-test', name: 'knowledge', arguments: { action: 'list' } }
  assert.equal((await ctx.tools.execute(request)).isError, false)
  const dispose = ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason: 'test denial' }))
  assert.equal((await ctx.tools.execute({ ...request, callId: 'denied' })).isError, true)
  dispose()
  assert.equal((await ctx.tools.execute({ ...request, callId: 'legacy', name: 'knowledge_search' })).isError, true)
})
