import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import {
  MOUNT_SELECTION_PATH,
  mountCandidates,
  registerMountSelectionControl,
  selectSessionKnowledgeBase,
  sessionSelectionView,
} from '../lib/mount-selection.js'

const draft = (name) => ({ name, description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-selection-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'workspace')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const regular = await provider.createKnowledgeBase(draft('普通库'))
  const wiki = await provider.createKnowledgeBase(draft('Wiki 库'))
  await provider.wiki.configure({ kbId: wiki.id, sourceDir, workspaceRoot, conversationEnabled: true })
  await provider.wiki.connect({ kbId: wiki.id, sourceDir, workspaceRoot, conversationEnabled: true })

  const unconnected = await provider.createKnowledgeBase(draft('未接入 Wiki'))
  const otherSource = join(root, 'source-2'), otherWorkspace = join(root, 'workspace-2')
  await mkdir(otherSource); await mkdir(otherWorkspace)
  await provider.wiki.configure({ kbId: unconnected.id, sourceDir: otherSource, workspaceRoot: otherWorkspace })

  const archived = await provider.createKnowledgeBase(draft('已归档库'))
  await provider.archiveKnowledgeBase(archived.id)

  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  return { provider, regular: regular.id, wiki: wiki.id, unconnected: unconnected.id, archived: archived.id, wikiName: wiki.name }
}

const mountSession = (provider, sessionId, knowledgeBaseId, writeMode = 'direct') => provider.upsertMount({
  targetKind: 'session', targetId: sessionId, knowledgeBaseId,
  enabled: true, recallEnabled: true, writeMode, includeTags: [], excludeTags: [], extractionInstructions: '',
})

test('candidates list active ordinary bases and connected Wiki libraries only', async t => {
  const f = await fixture(t)
  const candidates = await mountCandidates(f.provider)
  assert.deepEqual(candidates.map(candidate => candidate.name).sort(), ['Wiki 库', '普通库', '默认知识库'].sort())
  assert.equal(candidates.find(candidate => candidate.knowledgeBaseId === f.wiki)?.name, f.wikiName, "a connected library is listed by name")
  assert.equal(candidates.find(candidate => candidate.knowledgeBaseId === f.regular)?.name, "普通库", "ordinary libraries are listed the same way, with no type field")
  assert.equal(candidates.some(candidate => "wiki" in candidate), false, "the internal file-authoritative flag never reaches the client")
  assert.equal(candidates.find(candidate => candidate.knowledgeBaseId === f.unconnected), undefined, 'unconnected Wiki bases are not offered')
  assert.equal(candidates.find(candidate => candidate.knowledgeBaseId === f.archived), undefined, 'archived bases are not offered')
})

test('a fresh session selects nothing and recalls nothing', async t => {
  const f = await fixture(t)
  const view = await sessionSelectionView(f.provider, 'session-1')
  assert.equal(view.selected, null)
  assert.equal(view.candidates.length, 3)
  assert.deepEqual(await f.provider.resolveMounts('session-1'), [], 'no library is recalled before selection')
  assert.deepEqual(await f.provider.listMounts('session', 'session-1'), [], 'no session mount exists before selection')
})

test('selecting a library writes one session mount and switching keeps exactly one', async t => {
  const f = await fixture(t)
  const selected = await selectSessionKnowledgeBase(f.provider, 'session-1', f.wiki)
  assert.equal(selected.selected?.knowledgeBaseId, f.wiki)
  assert.equal(selected.selected?.knowledgeBaseId, f.wiki)
  const mounts = await f.provider.listMounts('session', 'session-1')
  assert.equal(mounts.filter(mount => mount.enabled).length, 1)
  assert.equal(mounts.find(mount => mount.knowledgeBaseId === f.wiki)?.recallEnabled, true)
  assert.equal(mounts.find(mount => mount.knowledgeBaseId === f.wiki)?.writeMode, 'direct', 'selecting is the session write authorization')
  assert.deepEqual((await f.provider.resolveMounts('session-1')).map(mount => mount.knowledgeBaseId), [f.wiki])

  const switched = await selectSessionKnowledgeBase(f.provider, 'session-1', f.regular)
  assert.equal(switched.selected?.knowledgeBaseId, f.regular)
  const after = await f.provider.listMounts('session', 'session-1')
  assert.deepEqual(after.filter(mount => mount.enabled).map(mount => mount.knowledgeBaseId), [f.regular], 'the previous selection is disabled')
  const previous = after.find(mount => mount.knowledgeBaseId === f.wiki)
  assert.equal(previous?.enabled, false)
  assert.equal(previous?.recallEnabled, false)

  // Switching away and back replaces the selection while keeping exactly one enabled mount.
  const reselected = await selectSessionKnowledgeBase(f.provider, 'session-1', f.wiki)
  assert.equal(reselected.selected?.knowledgeBaseId, f.wiki)
  assert.equal((await f.provider.listMounts('session', 'session-1')).find(mount => mount.knowledgeBaseId === f.wiki)?.writeMode, 'direct')
  assert.equal((await f.provider.listMounts('session', 'session-1')).filter(mount => mount.enabled).length, 1)
})

test('clearing the selection writes nothing and leaves project mounts untouched', async t => {
  const f = await fixture(t)
  await f.provider.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: f.wiki,
    enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  await selectSessionKnowledgeBase(f.provider, 'session-1', f.regular)
  const withProject = await f.provider.resolveMounts('session-1', '/workspace/demo')
  assert.equal(withProject.length, 2)
  assert.equal(withProject.find(mount => mount.knowledgeBaseId === f.wiki)?.inheritedFrom, 'project')
  assert.equal(withProject.find(mount => mount.knowledgeBaseId === f.regular)?.inheritedFrom, undefined)

  const cleared = await selectSessionKnowledgeBase(f.provider, 'session-1', null)
  assert.equal(cleared.selected, null)
  assert.ok((await f.provider.listMounts('session', 'session-1')).every(mount => !mount.enabled))
  const afterClear = await f.provider.resolveMounts('session-1', '/workspace/demo')
  assert.deepEqual(afterClear.map(mount => [mount.knowledgeBaseId, mount.inheritedFrom]), [[f.wiki, 'project']], 'the project mount survives clearing the session selection')

  // A session selection for the same base overrides the project mount for recall/write decisions.
  await selectSessionKnowledgeBase(f.provider, 'session-1', f.wiki)
  const overridden = (await f.provider.resolveMounts('session-1', '/workspace/demo')).find(mount => mount.knowledgeBaseId === f.wiki)
  assert.equal(overridden?.inheritedFrom, undefined)
  assert.equal(overridden?.writeMode, 'direct')
})

test('unreadable, unknown or archived libraries cannot be selected', async t => {
  const f = await fixture(t)
  for (const knowledgeBaseId of [f.unconnected, f.archived, 'missing-base']) {
    await assert.rejects(() => selectSessionKnowledgeBase(f.provider, 'session-1', knowledgeBaseId), /只能选择可用的知识库/)
  }
  await assert.rejects(() => sessionSelectionView(f.provider, '   '), /需要一个有效的会话标识/)
})

test('selecting a library is the session write authorization', async t => {
  const f = await fixture(t)
  await selectSessionKnowledgeBase(f.provider, 'session-1', f.wiki)
  const mount = (await f.provider.listMounts('session', 'session-1')).find(item => item.knowledgeBaseId === f.wiki)
  assert.equal(mount?.writeMode, 'direct', 'the selection itself grants direct writing for this session')
  assert.equal(mount?.recallEnabled, true)
  assert.deepEqual((await f.provider.resolveMounts('session-1')).map(item => item.knowledgeBaseId), [f.wiki])

  await selectSessionKnowledgeBase(f.provider, 'session-1', null)
  const cleared = (await f.provider.listMounts('session', 'session-1')).find(item => item.knowledgeBaseId === f.wiki)
  assert.equal(cleared?.enabled, false)
  assert.deepEqual(await f.provider.resolveMounts('session-1'), [], 'clearing leaves no recall or write target')
})

test('the conversation control serves the view and applies switches with explicit failures', async t => {
  const f = await fixture(t)
  let route
  registerMountSelectionControl({ webServer: { register(value) { route = value; return () => {} } } }, f.provider, { available: () => true })
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const endpoint = `http://127.0.0.1:${server.address().port}${MOUNT_SELECTION_PATH}`
  const headers = { 'x-dsh-knowledge-client': 'conversation-web', 'content-type': 'application/json' }

  assert.equal((await fetch(`${endpoint}?sessionId=s1`)).status, 401, 'only the conversation surface may read the selection')
  const view = await (await fetch(`${endpoint}?sessionId=s1`, { headers })).json()
  assert.equal(view.selected, null)
  assert.equal(view.candidates.length, 3)

  const selected = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', knowledgeBaseId: f.regular }) })).json()
  assert.equal(selected.selected.knowledgeBaseId, f.regular)
  const cleared = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', knowledgeBaseId: null }) })).json()
  assert.equal(cleared.selected, null)

  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{' })).status, 400)
  const rejected = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', knowledgeBaseId: 'missing' }) })
  assert.equal(rejected.status, 400)
  assert.match((await rejected.json()).error, /只能选择可用的知识库/)
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ sessionId: '', knowledgeBaseId: null }) })).status, 400)

  let unavailable
  registerMountSelectionControl({ webServer: { register(value) { unavailable = value; return () => {} } } }, f.provider, { available: () => false })
  const offline = createServer((req, res) => unavailable.handler(req, res))
  await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve))
  t.after(async () => { offline.closeAllConnections(); await new Promise(resolve => offline.close(resolve)) })
  const offlineEndpoint = `http://127.0.0.1:${offline.address().port}${MOUNT_SELECTION_PATH}`
  const blocked = await fetch(`${offlineEndpoint}?sessionId=s1`, { headers })
  assert.equal(blocked.status, 409)
  assert.match((await blocked.json()).error, /本地后端/)
})
