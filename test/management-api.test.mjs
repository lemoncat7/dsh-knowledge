import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LOCAL_MANAGEMENT_API_PREFIX, registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('same-origin management API controls public access and deletes revoked tokens', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-management-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  let enabled = false
  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, {
    authMode: 'same-origin',
    service: {
      current: () => ({ publicApiEnabled: enabled, publicApiPrefix: '/knowledge-api/v1' }),
      async update(patch) {
        enabled = patch.publicApiEnabled ?? enabled
        return { publicApiEnabled: enabled, publicApiPrefix: '/knowledge-api/v1', ...(patch.writebackProvider && patch.writebackModel ? { writebackProvider: patch.writebackProvider, writebackModel: patch.writebackModel } : {}) }
      },
    },
  })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}${LOCAL_MANAGEMENT_API_PREFIX}`
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal((await fetch(`${base}/service`)).status, 401)
  assert.equal((await fetch(`${base}/service`, {
    headers: { 'x-dsh-knowledge-client': 'management-web', 'sec-fetch-site': 'cross-site' },
  })).status, 403)

  const headers = { 'x-dsh-knowledge-client': 'management-web' }
  const folderResponse = await fetch(`${base}/notes/folders`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '项目资料', parentId: null }),
  })
  assert.equal(folderResponse.status, 201)
  const folder = await folderResponse.json()
  const noteContent = Buffer.from('# 原始部署笔记\n\n内容默认不参与知识索引。')
  const uploadedResponse = await fetch(`${base}/notes/files?name=${encodeURIComponent('部署笔记.md')}&parentId=${folder.id}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'text/markdown' }, body: noteContent,
  })
  assert.equal(uploadedResponse.status, 201)
  const note = await uploadedResponse.json()
  assert.match(note.id, /^note_[a-f0-9]{32}$/)
  assert.equal(note.name, '部署笔记.md')
  assert.equal((await (await fetch(`${base}/notes?parentId=${folder.id}&limit=20`, { headers })).json())[0].id, note.id)
  const downloaded = await fetch(`${base}/notes/${note.id}/content`, { headers })
  assert.equal(downloaded.headers.get('content-type'), 'text/markdown')
  assert.match(downloaded.headers.get('content-disposition'), /inline/)
  assert.equal(downloaded.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), noteContent)
  const revisedNoteContent = Buffer.from('# 更新后的部署笔记\n\n现在可以在笔记工作区直接编辑。')
  const updatedNoteResponse = await fetch(`${base}/notes/${note.id}/content`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'text/markdown' }, body: revisedNoteContent,
  })
  assert.equal(updatedNoteResponse.status, 200)
  assert.equal((await updatedNoteResponse.json()).size, revisedNoteContent.byteLength)
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/notes/${note.id}/content`, { headers })).arrayBuffer()), revisedNoteContent)

  const entry = await (await fetch(`${base}/entries`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ draft: {
      knowledgeBaseId: 'default', title: '笔记引用测试',
      body: `依据 @[部署笔记.md](note://${note.id})。`,
      type: 'fact', tags: ['note'], scope: { kind: 'global' }, confidence: 0.9,
    } }),
  })).json()
  const documentIndex = await (await fetch(`${base}/document-index?knowledgeBaseId=default&limit=1`, { headers })).json()
  assert.equal(documentIndex.total, 1)
  assert.equal(documentIndex.items[0].id, entry.id)
  assert.equal(Object.hasOwn(documentIndex.items[0], 'content'), false)
  const references = await (await fetch(`${base}/notes/${folder.id}/references`, { headers })).json()
  assert.deepEqual(references.map(item => item.documentId), [entry.id])
  assert.equal((await fetch(`${base}/notes/${folder.id}`, { method: 'DELETE', headers })).status, 409)
  assert.equal((await fetch(`${base}/entries/${entry.id}`, { method: 'DELETE', headers })).status, 204)
  assert.equal((await fetch(`${base}/notes/${folder.id}`, { method: 'DELETE', headers })).status, 204)

  assert.equal((await (await fetch(`${base}/settings`, { headers })).json()).writebackPolicy, 'conservative')
  const policy = await (await fetch(`${base}/settings`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { writebackPolicy: 'proactive' } }),
  })).json()
  assert.equal(policy.writebackPolicy, 'proactive')
  const initial = await (await fetch(`${base}/service`, { headers })).json()
  assert.deepEqual(initial, { publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' })
  const updated = await (await fetch(`${base}/service`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ publicApiEnabled: true }),
  })).json()
  assert.equal(updated.publicApiEnabled, true)

  const created = await (await fetch(`${base}/tokens`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test client', permissions: ['read'] }),
  })).json()
  const tokenId = created.record.id
  assert.equal((await fetch(`${base}/tokens/${tokenId}`, { method: 'DELETE', headers })).status, 204)
  assert.ok(provider.listApiTokens().find(token => token.id === tokenId)?.revokedAt)
  assert.equal((await fetch(`${base}/tokens/${tokenId}`, { method: 'DELETE', headers })).status, 204)
  assert.equal(provider.listApiTokens().some(token => token.id === tokenId), false)
})
