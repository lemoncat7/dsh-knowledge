import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { KnowledgeHandleCodec } from '../lib/retrieval.js'
import { recallIncidentTool } from '../lib/recall-incident-tool.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'recall-feedback-'))
  const provider = new LocalKnowledgeProvider(join(dir, 'db.sqlite'))
  t.after(async () => { await provider.close(); await rm(dir, { recursive: true, force: true }) })
  const entry = await provider.create({ group: '部署', knowledgeBaseId: 'default', title: '部署流程', body: '重启后检查健康状态', type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: .95 })
  const mount = { targetKind: 'session', targetId: 'session', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '' }
  await provider.upsertMount(mount)
  const codec = new KnowledgeHandleCodec(Buffer.alloc(32, 9))
  const exec = { agent: { session: { id: 'session', header: { cwd: '/project' }, snapshotEvents: () => [] } }, signal: new AbortController().signal }
  const args = { handle: codec.encode('session', entry), incidentKey: 'missing-health-check', evidence: '部署后健康检查失败，用户指出尚未恢复', lesson: '不能将重启成功当作服务健康', severity: 3 }
  return { provider, entry, mount, codec, exec, args }
}

test('agent feedback records evidence without confirmation or document edits, and retries deduplicate', async t => {
  const { provider, entry, codec, exec, args } = await fixture(t)
  const tool = recallIncidentTool(provider, codec)
  const first = JSON.parse(await tool.execute(args, exec))
  assert.equal(JSON.parse(await tool.execute(args, exec)).incidentId, first.incidentId)
  assert.equal(provider.recallRanking.list().items[0].incidents, 1)
  assert.equal(provider.recallRanking.list().items[0].friction, 30)
  assert.equal((await provider.get(entry.id)).version, entry.version)
  assert.equal((await provider.get(entry.id)).body, entry.body)
  await assert.rejects(tool.execute({ ...args, evidence: 'changed evidence' }, exec), /内容已改变/)
  assert.equal(provider.recallRanking.list().items[0].incidents, 1)
  await tool.execute({ ...args, incidentKey: 'independent-recurrence' }, exec)
  assert.equal(provider.recallRanking.list().items[0].incidents, 2)
})

test('invalid, cross-session and revoked/read-only references cannot record', async t => {
  const { provider, mount, codec, exec, args } = await fixture(t)
  const tool = recallIncidentTool(provider, codec)
  await assert.rejects(tool.execute({ ...args, severity: 100 }, exec), /severity/)
  await assert.rejects(tool.execute({ ...args, evidence: '' }, exec), /evidence/)
  await assert.rejects(tool.execute(args, { ...exec, agent: { session: { ...exec.agent.session, id: 'other' } } }))
  await provider.upsertMount({ ...mount, writeMode: 'none' })
  await assert.rejects(tool.execute(args, exec), /只读/)
  assert.equal(provider.recallRanking.list().items[0].incidents, 0)
})

test('remote feedback supports write tokens but rejects read-only tokens', async t => {
  const { provider, entry } = await fixture(t)
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, get() {} }, provider, '/api')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api`
  const value = { requestId: 'a'.repeat(64), reason: 'Verified failure and lesson', severity: 1 }
  const reader = new RemoteKnowledgeProvider({ url, token: provider.createApiToken('reader', ['read']).token, timeoutMs: 5000 })
  await assert.rejects(reader.recordRecallIncident(entry.id, value))
  const writer = new RemoteKnowledgeProvider({ url, token: provider.createApiToken('writer', ['read', 'write']).token, timeoutMs: 5000 })
  const result = await writer.recordRecallIncident(entry.id, value)
  assert.equal((await writer.recordRecallIncident(entry.id, value)).id, result.id)
  assert.equal(provider.recallRanking.list().items[0].incidents, 1)
  const hits = await writer.search({ text: '部署', limit: 10 })
  const hit = hits.find(value => value.entry.id === entry.id)
  assert.ok(hit.rankScore > hit.score, 'central search must return friction-adjusted rankScore')
})

test('tool incident changes real search order, retry does not inflate, retraction restores it', async t => {
  const { provider, entry, codec, exec, args } = await fixture(t)
  await provider.create({ group: '部署', knowledgeBaseId: 'default', title: entry.title, body: `${entry.body}\n另一个环境的操作记录。`, type: entry.type, tags: entry.tags, scope: entry.scope, confidence: entry.confidence })
  const request = { text: '部署', limit: 10 }
  const before = await provider.search(request)
  assert.equal(before.length, 2)
  assert.equal(before[0].score, before[1].score)
  const target = before[1].entry
  const tool = recallIncidentTool(provider, codec)
  const input = { ...args, handle: codec.encode('session', target) }
  const result = JSON.parse(await tool.execute(input, exec))
  const after = await provider.search(request)
  assert.equal(after[0].entry.id, target.id)
  assert.equal(after[0].score, before[1].score, 'admission relevance must remain unchanged')
  assert.ok(Math.abs(after[0].rankScore - after[0].score - .0054) < .000001)
  await tool.execute(input, exec)
  assert.equal(provider.recallRanking.list().items.find(row => row.id === target.id).incidents, 1)
  provider.recallRanking.retract(target.id, result.incidentId, 'test retraction')
  assert.deepEqual((await provider.search(request)).map(hit => hit.entry.id), before.map(hit => hit.entry.id))
})
