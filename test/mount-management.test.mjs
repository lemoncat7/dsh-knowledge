import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { createKnowledgeMountManagement } from '../lib/mount-management.js'
import { KnowledgeProviderRouter } from '../lib/provider-router.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-mount-management-'))
  const local = new LocalKnowledgeProvider(join(dir, 'knowledge.sqlite'))
  t.after(async () => { await local.close(); await rm(dir, { recursive: true, force: true }) })
  return local
}
const targets = [{ kind: 'project', id: '/partners/worker' }, { kind: 'session', id: 'worker-session' }]
const settings = { knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '只记录已核验的结论' }

test('mount bridge uses atomic batches for current sessions and the future-session default project', async t => {
  const local = await fixture(t)
  const bridge = createKnowledgeMountManagement(local)
  assert.equal(bridge.version, 1)
  assert.ok((await bridge.catalog()).bases.some(item => item.id === 'default'))
  const before = await bridge.read(targets)
  const applied = await bridge.configure(targets, before.revision, settings)
  assert.equal(applied.applied, true)
  assert.equal(applied.mounts.length, 2)
  assert.equal((await local.resolveMounts('future-session', '/partners/worker'))[0].writeMode, 'audit')
  assert.equal((await local.resolveMounts('other-session', '/other-project')).length, 0)
  await assert.rejects(bridge.configure(targets, before.revision, settings), /已变化/)
  const current = await bridge.read(targets)
  await bridge.configure(targets, current.revision, { ...settings, enabled: false })
  assert.equal((await local.listMounts('session', 'worker-session'))[0].enabled, false)
  assert.equal((await local.listMounts('project', '/partners/worker'))[0].enabled, false)
})

test('invalid mount changes never partially alter a target group', async t => {
  const local = await fixture(t)
  const bridge = createKnowledgeMountManagement(local)
  const before = await bridge.read(targets)
  for (const patch of [{ enabled: 'true' }, { writeMode: 'unknown' }, { knowledgeBaseId: 'missing' }, { includeTags: ['same'], excludeTags: ['same'] }]) {
    await assert.rejects(bridge.configure(targets, before.revision, { ...settings, ...patch }))
    assert.deepEqual(await bridge.read(targets), before)
  }
  await assert.rejects(bridge.read([]), /数量/)
  await assert.rejects(bridge.read([targets[0], targets[0]]), /重复/)
  await assert.rejects(bridge.read([{ kind: 'arbitrary', id: 'x' }]), /无效/)
})

test('remote mounts retain bearer write permissions and do not fall back to local storage', async t => {
  const local = await fixture(t)
  const readToken = local.createApiToken('read', ['read']).token
  const writeToken = local.createApiToken('write', ['read', 'write']).token
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } } }, local, '/knowledge-api/v1')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/knowledge-api/v1/`
  const reader = createKnowledgeMountManagement(new RemoteKnowledgeProvider({ url, token: readToken, timeoutMs: 5000 }))
  const current = await reader.read(targets)
  assert.equal(current.backend, 'remote')
  await assert.rejects(reader.configure(targets, current.revision, settings), error => error.status === 403)
  assert.equal((await local.listMounts()).length, 0)
  const writer = createKnowledgeMountManagement(new RemoteKnowledgeProvider({ url, token: writeToken, timeoutMs: 5000 }))
  const result = await writer.configure(targets, current.revision, settings)
  assert.equal(result.backend, 'remote')
  assert.equal(result.mounts.length, 2)
})

test('cancellation and the final authorization guard prevent mount writes', async t => {
  const local = await fixture(t)
  const bridge = createKnowledgeMountManagement(local)
  const before = await bridge.read(targets)
  const controller = new AbortController()
  await assert.rejects(bridge.configure(targets, before.revision, settings, undefined, () => { throw new Error('revoked') }), /revoked/)
  controller.abort(new Error('canceled'))
  await assert.rejects(bridge.configure(targets, before.revision, settings, controller.signal), /canceled/)
  assert.equal((await local.listMounts()).length, 0)
})

test('switching providers during discovery cannot write to a different connection', async t => {
  const local = await fixture(t)
  const router = new KnowledgeProviderRouter(local, { owned: false })
  t.after(() => router.close())
  const bridge = createKnowledgeMountManagement(router.provider, () => router.revision)
  const before = await bridge.read(targets)
  const original = local.listMounts.bind(local)
  let switchOnce = true
  local.listMounts = async (...args) => {
    if (switchOnce) {
      switchOnce = false
      // Initiate, but do not wait for retired in-flight reads to drain here.
      void router.replace(local, { owned: false })
    }
    return original(...args)
  }
  await assert.rejects(bridge.configure(targets, before.revision, settings), /连接已切换/)
  assert.equal((await local.listMounts()).length, 0)
  await assert.rejects(bridge.configure(targets, before.revision, settings), /已变化/)
})

test('large companion scope discovery uses at most eight concurrent requests', async () => {
  let active = 0
  let maximum = 0
  const bridge = createKnowledgeMountManagement({ mode: 'remote', async listMounts() {
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => setImmediate(resolve))
    active -= 1
    return []
  } })
  const result = await bridge.read(Array.from({ length: 25 }, (_, i) => ({ kind: 'session', id: 'session-' + i })))
  assert.equal(result.scopes.length, 25)
  assert.equal(maximum, 8)
})
