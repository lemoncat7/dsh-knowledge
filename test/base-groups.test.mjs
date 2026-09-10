import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { groupKnowledgeBases, knowledgeBasePathLabel, sortKnowledgeBasesByGroup } from '../web/base-groups.js'

const draft = { name: '工作规范', description: '工作', defaultTags: ['rules'], extractionInstructions: '', writebackPolicy: 'conservative' }

test('mount labels and sorting use group then natural library name without mutating input', () => {
  const bases = [{ id: 'u', name: '默认' }, { id: '10', name: '规范10', group: '工作' }, { id: '2', name: '规范2', group: '工作' }, { id: 'a', name: '设备', group: '家里助手' }]
  const original = [...bases]
  const sorted = sortKnowledgeBasesByGroup(bases)
  assert.deepEqual(sorted.map(base => base.id), ['2', '10', 'a', 'u'])
  assert.deepEqual(bases, original)
  assert.equal(knowledgeBasePathLabel(bases[0]), '未分组 / 默认')
  assert.equal(knowledgeBasePathLabel(bases[1]), '工作 / 规范10')
})

test('group assignment is atomic, durable and independent of mounts; old editors preserve it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-groups-'))
  const path = join(root, 'knowledge.sqlite')
  let provider = new LocalKnowledgeProvider(path)
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const base = await provider.createKnowledgeBase({ ...draft, group: ' 工作 ' })
  assert.equal(base.group, '工作')
  const mount = await provider.upsertMount({ targetKind: 'session', targetId: 's', knowledgeBaseId: base.id, enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '' })
  await provider.updateKnowledgeBase(base.id, { ...draft, name: '旧客户端编辑' })
  assert.equal((await provider.getKnowledgeBase(base.id)).group, '工作')
  await assert.rejects(provider.assignKnowledgeBaseGroup([base.id, 'missing'], '个人'))
  assert.equal((await provider.getKnowledgeBase(base.id)).group, '工作')
  await provider.assignKnowledgeBaseGroup([base.id, 'default', base.id], '家里助手')
  assert.deepEqual(await provider.listMounts(), [mount])
  await provider.close()
  provider = new LocalKnowledgeProvider(path)
  assert.equal((await provider.getKnowledgeBase(base.id)).group, '家里助手')
  await provider.patchKnowledgeBase(base.id, { group: null })
  assert.equal((await provider.getKnowledgeBase(base.id)).group, undefined)
  await assert.rejects(provider.assignKnowledgeBaseGroup([base.id], 'x'.repeat(65)))
  await assert.rejects(provider.assignKnowledgeBaseGroup([base.id], 'bad\nname'))
  await assert.rejects(provider.assignKnowledgeBaseGroup([], '工作'))
})

test('schema 13 upgrades existing bases to ungrouped without changing metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-groups-migration-'))
  const path = join(root, 'knowledge.sqlite')
  let provider = new LocalKnowledgeProvider(path)
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const base = await provider.createKnowledgeBase(draft)
  await provider.close()
  const db = new DatabaseSync(path)
  db.exec('ALTER TABLE knowledge_bases DROP COLUMN group_name; PRAGMA user_version=13;')
  db.close()
  provider = new LocalKnowledgeProvider(path)
  assert.deepEqual(await provider.getKnowledgeBase(base.id), base)
  await provider.assignKnowledgeBaseGroup([base.id], '迁移后')
  assert.equal((await provider.getKnowledgeBase(base.id)).group, '迁移后')
})

test('group create, move, clear and batch assignment work through remote API', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-groups-api-'))
  const local = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const token = 'group_test_token_longer_than_24_chars'
  local.ensureBootstrapToken(token)
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, get() {} }, local, '/api')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remote = new RemoteKnowledgeProvider({ url: `http://127.0.0.1:${server.address().port}/api`, token, timeoutMs: 5000 })
  t.after(async () => { await remote.close(); await new Promise(resolve => server.close(resolve)); await local.close(); await rm(root, { recursive: true, force: true }) })
  const base = await remote.createKnowledgeBase({ ...draft, group: '工作' })
  await remote.updateKnowledgeBase(base.id, draft)
  assert.equal((await remote.getKnowledgeBase(base.id)).group, '工作')
  await remote.updateKnowledgeBase(base.id, { ...draft, group: '' })
  assert.equal((await remote.getKnowledgeBase(base.id)).group, undefined)
  await remote.assignKnowledgeBaseGroup([base.id, 'default'], '个人')
  assert.equal((await remote.getKnowledgeBase('default')).group, '个人')
  await remote.patchKnowledgeBase(base.id, { group: null })
  assert.equal((await remote.getKnowledgeBase(base.id)).group, undefined)
  await assert.rejects(remote.assignKnowledgeBaseGroup([base.id], 'x'.repeat(65)))
})

test('grouped lists preserve cards and safely handle arbitrary group names', () => {
  const bases = [{ id: '1', group: '__proto__' }, { id: '2' }, { id: '3', group: '__proto__' }, { id: '4', group: '工作' }]
  const groups = groupKnowledgeBases(bases)
  assert.deepEqual(groups.find(([name]) => name === '__proto__')[1].map(b => b.id), ['1', '3'])
  assert.equal(groups.at(-1)[0], '')
  assert.equal(groups.flatMap(([, items]) => items).length, bases.length)
})
