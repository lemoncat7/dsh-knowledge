import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/index.js'
import { createKnowledgeTrackingService } from '../lib/tracking.js'

test('records knowledge-linked partner observations through the mounted write policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-tracking-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  await provider.patchKnowledgeBase('default', { name: 'DSH', description: 'DSH 项目记录' })
  await provider.upsertMount({
    targetKind: 'project', targetId: '/workspace/dsh', knowledgeBaseId: 'default', enabled: true,
    recallEnabled: true, writeMode: 'direct', includeTags: ['dsh'], excludeTags: [], extractionInstructions: '',
  })
  const service = createKnowledgeTrackingService(provider)
  const agent = { session: { id: 'partner-session', header: { cwd: '/workspace/dsh' }, snapshotEvents() { return this.events }, events: [] } }
  const result = await service.record(agent, {
    id: 'observation-1', subject: 'Canvas 拖动稳定性', event: '新版修复了拖动丢帧', evidence: '发行说明与测试一致',
    source: 'release notes', reference: 'DSH/Canvas 稳定性', at: Date.parse('2026-08-28T08:00:00Z'),
  })
  assert.deepEqual(result, { storage: 'knowledge', outcome: 'written', knowledgeBaseId: 'default' })
  const entries = await provider.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })
  assert.equal(entries.items.length, 1)
  assert.equal(entries.items[0]?.title, 'Canvas 稳定性')
  assert.match(entries.items[0]?.body ?? '', /新版修复了拖动丢帧/)
  assert.deepEqual(entries.items[0]?.tags, ['dsh', 'partner-observation'])

  const guarded = await service.record(agent, {
    id: 'observation-2', subject: '临时接入凭证', event: 'password: actual-secret-value', evidence: '用户消息',
    source: 'conversation', reference: 'DSH/临时接入凭证', at: Date.parse('2026-08-28T08:01:00Z'),
  })
  assert.deepEqual(guarded, { storage: 'knowledge', outcome: 'pending-review', knowledgeBaseId: 'default' })
  assert.equal((await provider.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })).items.length, 1)
  assert.equal((await provider.listCandidates('pending', 10)).length, 1)
})

test('lists only recallable documents mounted for the partner session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-tracking-list-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  await provider.patchKnowledgeBase('default', { name: '工作资料' })
  const hidden = await provider.createKnowledgeBase({
    name: '未挂载资料', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative',
  })
  await provider.create({
    knowledgeBaseId: 'default', title: '路线图', body: '后续计划', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 1,
  })
  await provider.create({
    knowledgeBaseId: hidden.id, title: '隐藏文档', body: '不可见', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 1,
  })
  await provider.upsertMount({
    targetKind: 'session', targetId: 'partner-session', knowledgeBaseId: 'default', enabled: true,
    recallEnabled: true, writeMode: 'none', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  const service = createKnowledgeTrackingService(provider)
  const agent = { session: { id: 'partner-session', header: {}, snapshotEvents() { return this.events }, events: [] } }
  const items = await service.list(agent, '路线', 20)
  assert.deepEqual(items, [{
    kind: 'knowledge', label: '工作资料 / 路线图', detail: '已挂载知识文档 · 1 条知识', token: '@知识库[工作资料/路线图]',
  }])
})
