import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { registerRemoteManagementProxy } from '../lib/management-proxy.js'

test('authenticated HTTP, remote agent tools and browser share one durable note workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-http-')),
    local = new LocalKnowledgeProvider(join(root, 'server.sqlite'))
  const token = 'workspace_test_token_longer_than_24_characters'
  local.ensureBootstrapToken(token)
  let api, proxy
  registerKnowledgeApi(
    {
      webServer: {
        register: (r) => {
          api = r.handler
          return () => {}
        },
      },
    },
    local,
    '/api',
  )
  const server = createServer((req, res) => void (req.url.startsWith('/local') ? proxy : api)(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const settings = { backend: 'remote', remoteUrl: url + '/api', remoteToken: token, remoteTimeoutMs: 2000 }
  const remote = new RemoteKnowledgeProvider({
    url: settings.remoteUrl,
    token,
    timeoutMs: 2000,
    workspaceRoot: join(root, 'workspace'),
  })
  registerRemoteManagementProxy(
    {
      webServer: {
        register: (r) => {
          proxy = r.handler
          return () => {}
        },
      },
    },
    '/local',
    () => settings,
    { current: () => ({}), update: async () => ({}) },
    () => ({ replica: remote.noteReplica, vault: remote.noteVault }),
  )
  t.after(async () => {
    await remote.close()
    await new Promise((resolve) => server.close(resolve))
    await local.close()
    await rm(root, { recursive: true, force: true })
  })
  await remote.noteReplica.sync()
  const headers = { 'x-dsh-knowledge-client': 'management-web', 'content-type': 'application/json' }
  const unauthorized = await fetch(url + '/local/notes')
  assert.equal(unauthorized.status, 401)
  const create = await fetch(url + '/local/notes/documents', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '浏览器新建', content: '# 原文' }),
  })
  assert.equal(create.status, 201)
  const node = await create.json()
  assert.equal((await remote.readNote(node.id)).content.toString(), '# 原文')
  await remote.noteReplica.sync()
  assert.equal((await local.readNote(node.id)).content.toString(), '# 原文')
  const change = await remote.updateNoteContent(node.id, Buffer.from('# 工具编辑'), undefined, node.version)
  await remote.noteReplica.sync()
  const page = await fetch(url + `/local/notes/${node.id}/content`, { headers })
  assert.equal(await page.text(), '# 工具编辑')
  assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  // The vault intentionally waits for a stable file before replacing it, so an
  // editor's in-progress save cannot be overwritten. Verify eventual projection.
  const projectedPath = join(root, 'workspace/vault/浏览器新建.md')
  const deadline = Date.now() + 8000
  let projected
  do {
    await remote.noteVault.scan()
    projected = await readFile(projectedPath, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e })
    if (projected === '# 工具编辑') break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(projected, '# 工具编辑', JSON.stringify(remote.noteVault.status()))
  const status = await fetch(url + '/local/note-workspace', { headers }).then((r) => r.json())
  assert.equal(status.pending, 0)
  assert.equal(status.state, 'online')
  const list = await fetch(url + '/local/notes?paged=1', { headers }).then((r) => r.json())
  assert.equal(list.items[0].id, node.id)
  const readOnly = local.createApiToken('readonly', ['read'])
  const reject = await fetch(url + '/api/note-sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${readOnly.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ value: null }),
  })
  assert.equal(reject.status, 403)
})

test('retiring and replacement providers share one workspace until the last reference closes', async (t) => {
  const { acquireRemoteWorkspace } = await import('../lib/notes/remote-workspace.js')
  const root = await mkdtemp(join(tmpdir(), 'shared-note-workspace-'))
  const transport = async () => {
    throw Error('offline')
  }
  const a = acquireRemoteWorkspace(root, transport),
    b = acquireRemoteWorkspace(root, transport)
  t.after(async () => {
    await a.release()
    await b.release()
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(a.replica, b.replica)
  await a.release()
  const n = await b.replica.create('document', 'still open', null, Buffer.from('kept'))
  assert.equal(b.replica.read(n.id).content.toString(), 'kept')
})

test('a replacement connection uses its new transport without discarding the shared queue',async t=>{
 const {acquireRemoteWorkspace}=await import('../lib/notes/remote-workspace.js')
 const root=await mkdtemp(join(tmpdir(),'workspace-transport-'));let oldCalls=0,newCalls=0
 const manifest={protocol:1,instance:'same-server',revision:'empty',nodes:[]}
 const a=acquireRemoteWorkspace(root,async()=>{oldCalls++;return manifest});await a.replica.sync()
 const before=oldCalls
 const b=acquireRemoteWorkspace(root,async()=>{newCalls++;return manifest})
 t.after(async()=>{await a.release();await b.release();await rm(root,{recursive:true,force:true})})
 assert.equal(a.replica,b.replica);await a.release();await b.replica.sync();assert.ok(newCalls>0);assert.equal(oldCalls,before)
})
