import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { ExtractionCoordinator } from '../lib/extraction.js'
import { contentHash } from '../lib/domain.js'

const draft = { knowledgeBaseId: 'default', title: 'Deployment policy', body: 'Keep the persistent volume.', type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: .99, source: { evidence: 'verified' } }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-receipt-'))
  const path = join(root, 'knowledge.sqlite')
  const providers = []
  const open = () => { const provider = new LocalKnowledgeProvider(path); providers.push(provider); return provider }
  t.after(async () => { for (const provider of providers) await provider.close(); await rm(root, { recursive: true, force: true }) })
  return { open, provider: open() }
}

for (const kind of ['create', 'append', 'revise']) test(`lost acknowledgment for ${kind} replays the original receipt after restart, with no extra version`, async t => {
  const { provider, open } = await fixture(t)
  const entry = kind === 'create' ? undefined : await provider.create(draft)
  const proposal = entry ? {
    action: 'update', targetId: entry.id, reason: 'Confirmed operation',
    draft: { ...draft, body: 'Back up the volume before upgrading.' },
    change: kind === 'append' ? { kind } : { kind, baseVersion: entry.version, baseHash: contentHash(entry), edits: [{ oldText: draft.body, newText: 'Back up the persistent volume.' }] },
  } : { action: 'create', draft, reason: 'Confirmed operation' }
  const committed = await provider.writeDirect(proposal, 'session:1')
  await provider.close()
  const reopened = open()
  const replay = await reopened.writeDirect(proposal, 'session:1')
  assert.deepEqual(replay, committed)
  assert.equal((await reopened.get(committed.entry.id)).version, kind === 'create' ? 1 : 2)
  assert.equal((await reopened.listCandidates('approved', 10)).length, 1)
})

test('a file projection failure after SQL commit retries projection without repeating the write', async t => {
  const { provider } = await fixture(t)
  const sync = provider.syncKnowledgeEntryQueued.bind(provider)
  let failed = false
  provider.syncKnowledgeEntryQueued = async id => {
    if (!failed) { failed = true; throw new Error('EIO projecting Markdown') }
    return sync(id)
  }
  const proposal = { action: 'create', draft, reason: 'Confirmed operation' }
  await assert.rejects(provider.writeDirect(proposal, 'projection:1'), /EIO/)
  const replay = await provider.writeDirect(proposal, 'projection:1')
  assert.equal(replay.entry.version, 1)
  assert.equal((await provider.list({ status: 'active', limit: 10 })).items.length, 1)
})

test('partial execution retains the full plan and delivery mode, without rerunning the model', async t => {
  const { provider } = await fixture(t)
  await provider.upsertMount({ targetKind: 'session', targetId: 's', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '' })
  let modelCalls = 0
  const ctx = { logger: { debug() {} }, llm: {
    async *stream() {
      modelCalls++
      yield { type: 'text-delta', text: JSON.stringify({ candidates: [
        { ...draft, action: 'create', retention: { durable: true, evidence: 'verified' }, reason: 'Confirmed durable operation' },
      ] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } }
  const coordinator = new ExtractionCoordinator(ctx, provider, { extractionMaxInputChars: 10000, extractionMaxTokens: 1000, extractionTimeoutMs: 5000, defaultScope: 'global' })
  t.after(() => coordinator.close())
  const snapshot = { sourceKey: 's:1', sessionId: 's', turn: 1, userText: 'Remember this confirmed deployment policy.', userTextTruncated: false, assistantText: draft.body, route: { provider: 'mock', model: 'mock' } }
  let plan
  const checkpoint = { load: () => plan, save: value => { plan = structuredClone(value) } }
  const write = provider.writeDirect.bind(provider)
  let lost = true
  provider.writeDirect = async (...args) => { const result = await write(...args); if (lost) { lost = false; throw new Error('EOF after commit') } return result }
  const signal = new AbortController().signal
  await assert.rejects(coordinator.runSnapshot(snapshot, signal, checkpoint), /EOF/)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].delivery, 'direct')
  const result = await coordinator.runSnapshot(snapshot, signal, checkpoint)
  assert.equal(result.directCount, 1)
  assert.equal(result.destinations.length, 1)
  assert.equal(modelCalls, 1)
  assert.equal((await provider.listCandidates('approved', 10)).length, 1)
})

test('old remote protocol and revoked direct permission cannot silently write or change frozen plans', async t => {
  const { provider } = await fixture(t)
  const mount = { targetKind: 'session', targetId: 's', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '' }
  await provider.upsertMount(mount)
  const plan = [{ delivery: 'direct', proposal: { action: 'create', draft, reason: 'Confirmed operation' } }]
  const checkpoint = { load: () => plan, save: () => assert.fail('must not recreate plan') }
  const remote = new Proxy(provider, { get(target, key) {
    if (key === 'mode') return 'remote'
    if (key === 'writebackProtocol') return async () => ({ idempotentDirectWrites: false })
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
  } })
  const coordinator = new ExtractionCoordinator({ logger: { debug() {} } }, remote, {})
  const snapshot = { sourceKey: 's:2', sessionId: 's', turn: 2, userText: 'confirmed', assistantText: 'confirmed', userTextTruncated: false }
  const signal = new AbortController().signal
  await assert.rejects(coordinator.runSnapshot(snapshot, signal, checkpoint), /远端知识库需升级/)
  assert.equal((await provider.listCandidates('approved', 10)).length, 0)
  await coordinator.close()
  await provider.upsertMount({ ...mount, writeMode: 'audit' })
  const local = new ExtractionCoordinator({ logger: { debug() {} } }, provider, {})
  await assert.rejects(local.runSnapshot(snapshot, signal, checkpoint), /直接写入权限已撤回/)
  assert.equal((await provider.listCandidates('pending', 10)).length, 0)
  await local.close()
})
