import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { JournalService } from '../worklog/service.js'
import { defaults, dayOf } from '../worklog/domain.js'
import { createCentral, incomingRecord } from '../worklog/central.js'
import { requestCentral, destination } from '../worklog/remote.js'
import { Outbox } from '../worklog/outbox.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const config = { ...defaults, enabled: true, scope: 'all', provider: 'central', model: 'central-model' }
const session = id => ({ id, header: { cwd: '/local/project' }, snapshotEvents: () => [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '修复问题' }] } },
  { type: 'assistant/message', data: { turn: 1, message: { source: { provider: 'client-only', model: 'client-model' }, content: [{ type: 'text', text: '已完成' }] } } },
] })

async function central(t) {
  const root = mkdtempSync(join(tmpdir(), 'journal-central-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const tokens = Object.fromEntries(['read', 'write', 'admin'].map(level => [level, provider.createApiToken(level, [level]).token]))
  const store = new Store(join(root, 'journal.sqlite')); store.configure(config)
  let calls = 0
  const worker = new Worker(store, {}, async () => { calls++; return '# 中央日报' })
  const service = new JournalService(store, worker, async () => [{ id: 'central', models: [{ id: 'central-model' }] }])
  let route
  registerKnowledgeApi({ webServer: { register(value) { route = value.handler; return () => {} } }, get() {} }, provider, '/knowledge-api/v1', {
    worklog: (...args) => service.serveCentral(...args),
  })
  const server = createServer((req, res) => route(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = { backend: 'remote', remoteUrl: `http://127.0.0.1:${server.address().port}/knowledge-api/v1`, remoteToken: tokens.admin, remoteTimeoutMs: 1000 }
  t.after(async () => { await service.close(); store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await provider.close(); rmSync(root, { recursive: true, force: true }) })
  return { connection, tokens, store, worker, service, calls: () => calls }
}
function client(t, connection, path = ':memory:', request) {
  const store = new Store(path); store.configure({ ...defaults, enabled: true, scope: 'all' })
  let calls = 0
  const worker = new Worker(store, {}, async () => { calls++; return '# 不应本地生成' })
  const service = new JournalService(store, worker, async () => [], () => connection, request)
  t.after(async () => { await service.close(); store.close() })
  return { store, service, worker, calls: () => calls }
}

test('multiple collectors share central records, model catalog and report; never run local models', async t => {
  const c = await central(t), a = client(t, c.connection), b = client(t, c.connection)
  a.service.collect(session('same-id'), 1); b.service.collect(session('same-id'), 1)
  await a.service.outbox.tick(); await b.service.outbox.tick()
  const day = dayOf(Date.now(), config.timezone)
  assert.equal(c.store.records(day).length, 2, 'same session IDs from independent instances must not collide')
  assert.equal(a.store.records(day).length, 0, 'remote collectors only retain transport backlog')
  assert.equal(c.store.records(day)[0].route, null, 'client model routes must not run centrally')
  assert.equal((await a.service.browser('GET', '/models')).providers[0].id, 'central')
  await a.service.browser('POST', '/generate', { day }); await c.worker.running
  const first = await a.service.browser('GET', '/day', {}, new URLSearchParams({ day }))
  const second = await b.service.browser('GET', '/day', {}, new URLSearchParams({ day }))
  assert.equal(first.report.markdown, '# 中央日报'); assert.deepEqual(first, second)
  await a.worker.tick(); await b.worker.tick()
  assert.equal(a.calls() + b.calls(), 0); assert.equal(c.calls(), 1)
  assert.equal(a.service.outbox.status(destination(c.connection)).pending, 0)
})

test('central settings are shared while local capture scope stays local', async t => {
  const c = await central(t), a = client(t, c.connection), b = client(t, c.connection)
  const state = await a.service.browser('GET', '/state')
  const publicState = await requestCentral(c.connection, 'GET', '/state')
  assert.equal(publicState.config.enabled, undefined, 'central API must not disclose central local capture settings')
  await a.service.browser('POST', '/settings', { ...state.config, sharedRevision: state.sharedRevision, enabled: false, projects: ['/only-a'], timezone: 'UTC', scheduleEnabled: true, scheduleTime: '22:30' })
  const bs = await b.service.browser('GET', '/state')
  assert.equal(bs.config.timezone, 'UTC'); assert.equal(bs.config.scheduleTime, '22:30')
  assert.equal(bs.config.enabled, true); assert.deepEqual(bs.config.projects, [])
  assert.equal(a.store.config().enabled, false)
  assert.equal(a.store.config().scheduleEnabled, false, 'central scheduler is not installed locally')
  assert.equal(c.store.config().enabled, true, 'remote UI cannot alter central collection authorization')
  await assert.rejects(b.service.browser('POST', '/settings', { ...state.config, sharedRevision: state.sharedRevision, scheduleTime: '21:00' }), e => e.status === 409)
  assert.equal(c.store.config().scheduleTime, '22:30', 'stale settings must not overwrite another client')
})

test('central APIs enforce bearer auth and read/write/admin permissions', async t => {
  const c = await central(t)
  const url = `${c.connection.remoteUrl}/worklog`
  assert.equal((await fetch(url + '/state')).status, 401)
  const read = { ...c.connection, remoteToken: c.tokens.read }
  const write = { ...c.connection, remoteToken: c.tokens.write }
  assert.equal((await requestCentral(read, 'GET', '/state')).canManage, false)
  await assert.rejects(requestCentral(read, 'POST', '/generate', { day: '2026-09-30' }), e => e.status === 403)
  await assert.rejects(requestCentral(write, 'POST', '/settings', config), e => e.status === 403)
  await assert.rejects(requestCentral(write, 'POST', '/archive', {}), e => e.status === 403)
  const a = client(t, write), state = await a.service.browser('GET', '/state')
  await a.service.browser('POST', '/settings', { ...state.config, enabled: false })
  assert.equal(a.store.config().enabled, false, 'capture-only update must not require central admin')
  await assert.rejects(a.service.browser('POST', '/ingest', {}), e => e.status === 404)
  await assert.rejects(a.service.browser('POST', '/migrate', { confirm: true }), e => e.status === 403)
})

test('lost ACK and restart replay are deduplicated without undoing central exclusions', async t => {
  const c = await central(t), dir = mkdtempSync(join(tmpdir(), 'journal-replay-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'collector.sqlite'), connection = c.connection
  let lost = true
  const a = client(t, connection, path, async (...args) => {
    const result = await requestCentral(...args)
    if (args[2] === '/ingest' && lost) { lost = false; throw new Error('lost ACK') }
    return result
  })
  a.service.collect(session('replay'), 1); await a.service.outbox.tick()
  const day = dayOf(Date.now(), config.timezone), record = c.store.records(day)[0]
  c.store.exclude(record.id, true)
  assert.equal(a.service.outbox.status(destination(connection)).pending, 1)
  await a.service.close(); a.store.close()
  const b = client(t, connection, path)
  b.store.db.prepare('UPDATE journal_outbox SET due=0').run()
  await b.service.outbox.tick()
  assert.equal(c.store.records(day, true).length, 1)
  assert.equal(c.store.records(day, true)[0].excluded, true)
  assert.equal(b.service.outbox.status(destination(connection)).pending, 0)
  assert.equal(b.store.db.prepare('SELECT body FROM journal_outbox').get().body, '')
})

test('old backlog remains pinned to its original central destination', async t => {
  const c = await central(t), other = await central(t), connection = { ...c.connection }
  const a = client(t, connection)
  a.service.collect(session('pinned'), 1)
  Object.assign(connection, other.connection)
  await a.service.outbox.tick()
  assert.equal(a.service.collectorState().sync.otherDestinations, 1)
  const day = dayOf(Date.now(), config.timezone)
  assert.equal(other.store.records(day).length, 0)
  Object.assign(connection, c.connection); await a.service.outbox.tick()
  assert.equal(c.store.records(day).length, 1)
})

test('changed server identity at the same URL halts upload', async t => {
  const c = await central(t), a = client(t, c.connection)
  a.service.collect(session('first'), 1); await a.service.outbox.tick()
  a.service.collect(session('second'), 1)
  a.store.db.prepare('UPDATE journal_targets SET central_id=?').run('different-server')
  await a.service.outbox.tick()
  assert.match(a.service.collectorState().sync.error, /实例已变更/)
  assert.equal(c.store.records(dayOf(Date.now(), config.timezone)).length, 1)
})

test('migration is explicit, restartable, keeps originals and archives without overwriting central reports', async t => {
  const c = await central(t), a = client(t, c.connection), day = dayOf(Date.now(), config.timezone)
  a.store.note(day, '历史素材')
  a.store.save(day, '# 本地日报', 0)
  c.store.save(day, '# 中央原稿', 0)
  await a.service.outbox.tick()
  assert.equal(c.store.records(day).length, 0)
  await assert.rejects(a.service.browser('POST', '/migrate', {}), e => e.status === 409)
  await a.service.browser('POST', '/migrate', { confirm: true }); await a.service.outbox.running
  assert.equal(c.store.records(day).length, 1); assert.equal(c.store.report(day).markdown, '# 中央原稿')
  assert.equal(c.store.detail(day).history[0].markdown, '# 本地日报')
  await a.service.browser('POST', '/migrate', { confirm: true }); await a.service.outbox.running
  assert.equal(c.store.detail(day).history.length, 1)
  assert.equal(a.store.records(day).length, 1); assert.equal(a.store.report(day).markdown, '# 本地日报')
})

test('uploaded dates use central timezone and malicious model routes are discarded', () => {
  const record = incomingRecord({ id: 's:1', sessionId: 's', turn: 1, time: Date.parse('2026-09-29T18:00Z'), day: '2099-01-01', project: '/x', user: '任务', answer: '完成', route: { provider: 'evil', model: 'evil' } }, 'a-valid-source-id-1234', 'Asia/Shanghai')
  assert.equal(record.day, '2026-09-30'); assert.equal(record.route, null)
  assert.throws(() => incomingRecord({ ...record, time: Infinity }, 'a-valid-source-id-1234', 'UTC'))
})

test('old central or network failure never falls back to local generation', async t => {
  const c = await central(t), a = client(t, c.connection, ':memory:', async () => { throw Object.assign(new Error('中央未升级'), { status: 502 }) })
  a.service.collect(session('offline'), 1); await a.service.outbox.tick()
  assert.equal(a.service.collectorState().sync.pending, 1)
  await assert.rejects(a.service.browser('GET', '/state'), /中央未升级/)
  await a.worker.tick(); assert.equal(a.calls(), 0)
  await a.service.browser('POST', '/capture-settings', { ...a.store.config(), enabled: false })
  assert.equal(a.store.config().enabled, false, 'local collection can be disabled even when central is offline')
})

test('only central schedules; old local scheduled jobs remain dormant in remote mode', async t => {
  const c = await central(t), a = client(t, c.connection), day = dayOf(Date.now(), config.timezone)
  a.store.configure({ ...config, scheduleEnabled: true, scheduleTime: '00:00' }, Date.now() - 2 * 86400000)
  a.store.note(day, '旧本地任务'); const localJob = a.store.enqueue(day)
  a.service.collect(session('scheduled'), 1); await a.service.outbox.tick()
  c.store.configure({ ...config, scheduleEnabled: true, scheduleTime: '00:00' }, Date.now() - 2 * 86400000)
  await a.worker.tick(); await c.worker.tick(); await c.worker.tick()
  assert.equal(a.calls(), 0); assert.equal(a.store.job(localJob).status, 'queued')
  assert.equal(c.calls(), 1); assert.equal(c.store.report(day).markdown, '# 中央日报')
})

test('central redirect is rejected without forwarding authorization to another server', async t => {
  let leaked = false
  const target = createServer((_req, res) => { leaked = true; res.end('{}') })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  const redirect = createServer((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/steal` }).end())
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const server of [redirect, target]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } })
  await assert.rejects(requestCentral({ backend: 'remote', remoteUrl: `http://127.0.0.1:${redirect.address().port}`, remoteToken: 'private-token-for-test', remoteTimeoutMs: 1000 }, 'GET', '/state'), /重定向/)
  assert.equal(leaked, false)
})
