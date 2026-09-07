import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { lifecycleProposal, assertLifecycleConfirmation } from '../lib/document-lifecycle.js'
import { documentLifecycleTool } from '../lib/document-lifecycle-tool.js'
import { KnowledgeHandleCodec } from '../lib/retrieval.js'
import { ExtractionCoordinator } from '../lib/extraction.js'

const confirmation = '异常上报问题已经解决了'
const request = { state: 'resolved', confirmation, note: '验证通过，不再等待修复', wholeDocument: true }
const draft = { knowledgeBaseId: 'default', title: '异常上报问题', body: '# 异常上报\n\n问题待修复。\n\n## 其他说明\n保持现有部署方式。', type: 'procedure', tags: ['report'], scope: { kind: 'global' }, confidence: .95 }
const signal = new AbortController().signal

async function fixture(t, mode = 'audit') {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-lifecycle-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const entry = await provider.create(draft)
  const mount = { targetKind: 'session', targetId: 'session', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: mode, includeTags: [], excludeTags: [], extractionInstructions: '' }
  await provider.upsertMount(mount)
  const codec = new KnowledgeHandleCodec(Buffer.alloc(32, 7))
  const session = { id: 'session', header: { cwd: '/project' }, snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: confirmation }] } },
  ] }
  const args = { ...request, handle: codec.encode(session.id, entry), expectedVersion: entry.version }
  const exec = { agent: { session }, signal }
  return { provider, entry, mount, codec, args, exec }
}

test('closure requires an explicit current confirmation, not a sliced question, condition or negation', () => {
  assert.doesNotThrow(() => assertLifecycleConfirmation(confirmation, confirmation, 'resolved'))
  assert.doesNotThrow(() => assertLifecycleConfirmation('资料收集完成，可以结束', '资料收集完成，可以结束', 'complete'))
  for (const [text, quote] of [
    ['好了', '好了'], ['问题未解决', '解决'], ['如果解决了就结束', '解决了'],
    ['问题解决了吗？', '解决了'], ['问题是不是已经解决了', '已经解决了'],
    ['问题应该已经解决了', '已经解决了'], ['问题解决了，但不要标记', '解决了'],
    ['这不代表问题已经解决了', '已经解决了'], ["it wasn't resolved", 'resolved'],
    ['not resolved', 'resolved'], ['查询一下状态', confirmation],
  ]) assert.throws(() => assertLifecycleConfirmation(text, quote, 'resolved'), undefined, text)
})

test('audit closure is pending until approved; preserves body and writes a state history version', async t => {
  const { provider, entry, codec, args, exec } = await fixture(t)
  const tool = documentLifecycleTool(provider, codec)
  const result = JSON.parse(await tool.execute(args, exec))
  assert.equal(result.status, 'pending-review')
  assert.equal((await provider.get(entry.id)).documentState, 'open')
  assert.equal(JSON.parse(await tool.execute(args, exec)).candidateId, result.candidateId)
  await provider.review(result.candidateId, { decision: 'approve' })
  const saved = await provider.get(entry.id)
  assert.equal(saved.body, entry.body)
  assert.equal(saved.documentState, 'resolved')
  assert.equal(saved.finalizationNote, request.note)
  assert.equal(saved.version, entry.version + 1)
  assert.equal((await provider.versions(entry.id))[0].snapshot.documentState, 'resolved')
  await assert.rejects(provider.update(entry.id, { ...draft, body: 'must not overwrite' }), /finalized/)
  await provider.reopen(entry.id)
  assert.equal((await provider.get(entry.id)).documentState, 'open')
})

test('direct closure reports applied and section resolution leaves broad documents open', async t => {
  const { provider, entry, codec, args, exec } = await fixture(t, 'direct')
  const tool = documentLifecycleTool(provider, codec)
  const section = JSON.parse(await tool.execute({ ...args, wholeDocument: false, oldText: '问题待修复。', newText: '问题已解决：验证通过。' }, exec))
  assert.equal(section.status, 'applied')
  const revised = await provider.get(entry.id)
  assert.equal(revised.documentState, 'open')
  assert.match(revised.body, /问题已解决：验证通过/)
  assert.match(revised.body, /保持现有部署方式/)
  const closed = JSON.parse(await tool.execute({ ...args, expectedVersion: revised.version }, exec))
  assert.equal(closed.status, 'applied')
  assert.equal(closed.documentState, 'resolved')
})

test('stale closure cannot seal concurrent content via direct write, manual or bulk review', async t => {
  const { provider, entry } = await fixture(t)
  const proposal = lifecycleProposal(entry, request, confirmation, {})
  const candidate = await provider.propose(proposal)
  await provider.update(entry.id, { ...draft, body: entry.body + '\n另一个未解决的问题' })
  await assert.rejects(provider.review(candidate.id, { decision: 'approve' }), /过期/)
  const direct = await provider.writeDirect(proposal)
  assert.equal(direct.outcome, 'conflict')
  await assert.rejects(provider.review(candidate.id, { decision: 'approve', draft }), /不能替换正文/)
  await provider.approvePendingBatch(50)
  assert.equal((await provider.get(entry.id)).documentState, 'open')
  assert.match((await provider.get(entry.id)).body, /另一个未解决的问题/)
  await provider.review(candidate.id, { decision: 'reject' })
})

test('status tool enforces session handles, mount filters, write revocation and direct-user evidence', async t => {
  const { provider, entry, codec, args, exec, mount } = await fixture(t, 'none')
  const tool = documentLifecycleTool(provider, codec)
  await assert.rejects(tool.execute(args, exec), /只读/)
  await provider.upsertMount({ ...mount, writeMode: 'direct' })
  await assert.rejects(tool.execute(args, { ...exec, agent: { session: { ...exec.agent.session, id: 'another' } } }), /session/)
  await assert.rejects(tool.execute(args, { ...exec, agent: { session: { ...exec.agent.session, snapshotEvents: () => [] } } }), /原话/)
  await provider.upsertMount({ ...mount, writeMode: 'direct', excludeTags: ['report'] })
  await assert.rejects(tool.execute(args, exec), /scope/)
  await provider.upsertMount({ ...mount, writeMode: 'direct' })
  let reads = 0
  const bridge = new Proxy(provider, { get(target, key) {
    if (key === 'resolveMounts') return async (...parameters) => {
      reads++
      if (reads === 2) await provider.upsertMount({ ...mount, writeMode: 'none' })
      return target.resolveMounts(...parameters)
    }
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
  } })
  await assert.rejects(documentLifecycleTool(bridge, codec).execute(args, exec), /撤回/)
  assert.equal((await provider.get(entry.id)).documentState, 'open')
  assert.equal((await provider.listCandidates('pending', 50)).length, 0)
})

test('finalize change survives remote API transport and uses existing review policy', async t => {
  const { provider: local, entry } = await fixture(t)
  const token = 'test_document_lifecycle_token_longer_than_24_chars'
  local.ensureBootstrapToken(token)
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, get() {} }, local, '/knowledge-api/v1')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remote = new RemoteKnowledgeProvider({ url: `http://127.0.0.1:${server.address().port}/knowledge-api/v1`, token, timeoutMs: 5000 })
  t.after(async () => { await remote.close(); await new Promise(resolve => server.close(resolve)) })
  const proposal = lifecycleProposal(entry, request, confirmation, {})
  const readOnly = new RemoteKnowledgeProvider({ url: `http://127.0.0.1:${server.address().port}/knowledge-api/v1`, token: local.createApiToken('reader', ['read']).token, timeoutMs: 5000 })
  const proposer = new RemoteKnowledgeProvider({ url: `http://127.0.0.1:${server.address().port}/knowledge-api/v1`, token: local.createApiToken('proposer', ['propose']).token, timeoutMs: 5000 })
  t.after(async () => { await readOnly.close(); await proposer.close() })
  await assert.rejects(readOnly.propose(proposal), error => error.status === 403)
  await assert.rejects(proposer.writeDirect(proposal), error => error.status === 403)
  const candidate = await remote.propose(proposal)
  assert.deepEqual(candidate.change, proposal.change)
  await remote.review(candidate.id, { decision: 'approve' })
  assert.equal((await remote.get(entry.id)).documentState, 'resolved')
})

test('closure review shows state and conclusion with existing components, and stale closure cannot use body-edit actions', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const declarations = source.slice(source.indexOf('function renderCandidateDiff('), source.indexOf('function renderDiffLine('))
    + source.slice(source.indexOf('function candidatePrimaryAction('), source.indexOf('function renderTokens('))
  const context = { element: (tag, attrs, ...children) => ({ tag, attrs, children }) }
  const api = runInNewContext(declarations + '; ({ renderCandidateDiff, candidatePrimaryAction })', context)
  const candidate = { status: 'pending', action: 'update', draft, change: { kind: 'finalize', baseVersion: 1, ...request } }
  const fresh = api.renderCandidateDiff(candidate, { ...draft, version: 1, documentState: 'open' })
  assert.match(JSON.stringify(fresh), /标记已解决/)
  assert.match(JSON.stringify(fresh), /正文保持不变/)
  assert.match(JSON.stringify(fresh), /验证通过/)
  assert.doesNotMatch(JSON.stringify(fresh), /diff-viewer/)
  assert.match(JSON.stringify(api.renderCandidateDiff(candidate, { ...draft, version: 2, documentState: 'open' })), /文档已变化/)
  assert.equal(api.candidatePrimaryAction({ ...candidate, action: 'conflict' }).manualOnly, true)
  assert.equal(api.candidatePrimaryAction(candidate).editLabel, undefined)
})

test('automatic writeback finalizes only explicit complete-subject confirmations and persists the destination state', async t => {
  const { provider, entry, exec } = await fixture(t, 'direct')
  let userText = '异常上报问题解决了吗？'
  let items = [{ action: 'finalize', knowledgeBaseId: 'default', targetId: entry.id, ...request, confidence: .99 }]
  const session = { ...exec.agent.session, snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] } },
    { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: '异常上报问题已经解决了，验证通过。' }] } } },
  ] }
  const ctx = { logger: { debug() {}, warn() {}, info() {}, error() {} }, llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ candidates: items }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const coordinator = new ExtractionCoordinator(ctx, provider, { extractionMaxInputChars: 20000, extractionMaxTokens: 3000, extractionTimeoutMs: 5000, defaultScope: 'global' })
  t.after(() => coordinator.close())
  await coordinator.run(session, 1, signal)
  assert.equal((await provider.get(entry.id)).documentState, 'open')
  await provider.resetExtraction('session:1')
  userText = confirmation
  items.push({ action: 'update', knowledgeBaseId: 'default', targetId: entry.id, documentTitle: '异常上报部署规则', type: 'procedure', scope: { kind: 'global' },
    change: { kind: 'revise', edits: [{ oldText: '问题待修复。', newText: '问题已解决：验证通过。' }] },
    confidence: .99, retention: { durable: true, evidence: 'explicit' }, reason: '局部确认，保留部署说明' })
  await coordinator.run(session, 1, signal)
  assert.equal((await provider.get(entry.id)).documentState, 'open')
  assert.match((await provider.get(entry.id)).body, /问题已解决/)
  await provider.resetExtraction('session:1')
  items = items.slice(0, 1)
  const result = await coordinator.run(session, 1, signal)
  assert.equal(result.directCount, 1)
  assert.equal((await provider.get(entry.id)).documentState, 'resolved')
  assert.equal((await provider.extractionJob('session:1')).completion.destinations[0].documentState, 'resolved')
})
