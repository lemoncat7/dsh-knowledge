import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { KNOWLEDGE_ACTIVITY_PATH, registerKnowledgeActivityControl } from '../lib/activity-control.js'

async function activityServer(provider) {
  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerKnowledgeActivityControl(ctx, provider)
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}${KNOWLEDGE_ACTIVITY_PATH}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}

const base = {
  id: 'base-a', name: '项目资料', description: '', defaultTags: [], extractionInstructions: '',
  writebackPolicy: 'conservative', status: 'active', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}
const mount = {
  id: 'mount-a', targetKind: 'session', targetId: 'session-a', knowledgeBaseId: base.id,
  enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', base,
}
const document = {
  id: 'document-a', knowledgeBaseId: base.id, relPath: 'README.md', title: '项目说明', content: '# 项目说明\n\n正文',
  entryCount: 1, contentHash: 'abc', documentState: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}
const note = {
  id: `note_${'a'.repeat(32)}`, parentId: null, kind: 'document', name: '设计记录.md', mediaType: 'text/markdown',
  editable: true, size: 24, sha256: 'def', version: 2, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
}

test('activity control exposes only mounted documents to the conversation panel', async (t) => {
  const indexRequests = []
  const server = await activityServer({
    async resolveMounts(sessionId, projectId) {
      assert.equal(sessionId, 'session-a')
      assert.equal(projectId, '/workspace/demo')
      return [mount]
    },
    async listDocumentIndex(request) {
      indexRequests.push(request)
      return { items: [{ ...document, content: undefined }].map(({ content, ...item }) => item), total: 1 }
    },
    async getDocument(id) { return id === document.id ? document : { ...document, id, knowledgeBaseId: 'base-secret' } },
  })
  t.after(server.close)
  const headers = { 'x-dsh-knowledge-client': 'conversation-web' }
  const scope = 'sessionId=session-a&projectId=%2Fworkspace%2Fdemo'

  assert.equal((await fetch(`${server.url}/mounts?${scope}`)).status, 401)
  const mounts = await (await fetch(`${server.url}/mounts?${scope}`, { headers })).json()
  assert.equal(mounts[0].base.name, '项目资料')

  const index = await (await fetch(`${server.url}/documents?${scope}&knowledgeBaseId=base-a&q=%E9%A1%B9%E7%9B%AE`, { headers })).json()
  assert.equal(index.items[0].id, document.id)
  assert.deepEqual(indexRequests[0].knowledgeBaseIds, ['base-a'])
  assert.equal(indexRequests[0].query, '项目')

  const readable = await fetch(`${server.url}/documents/document-a?${scope}`, { headers })
  assert.equal(readable.status, 200)
  assert.equal((await readable.json()).content, document.content)
  assert.equal((await fetch(`${server.url}/documents/document-secret?${scope}`, { headers })).status, 404)
  assert.equal((await fetch(`${server.url}/documents/document-a?${scope}`, { method: 'POST', headers })).status, 405)
  assert.equal((await fetch(`${server.url}/mounts?${scope}`, {
    headers: { ...headers, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
  })).status, 403)
})

test('activity control browses and reads notes without widening its read-only boundary', async (t) => {
  let resolvedMounts = false
  const server = await activityServer({
    async resolveMounts() { resolvedMounts = true; return [] },
    async listNotes(request) {
      assert.deepEqual(request, { parentId: null, limit: 200 })
      return [note]
    },
    async getNote(id) { return id === note.id ? note : undefined },
    async readNote() { return { node: note, content: Buffer.from('# 设计记录\n\n正文') } },
  })
  t.after(server.close)
  const headers = { 'x-dsh-knowledge-client': 'conversation-web' }
  const scope = 'sessionId=session-a'

  const index = await (await fetch(`${server.url}/notes?${scope}`, { headers })).json()
  assert.equal(index[0].name, note.name)
  assert.equal(resolvedMounts, false)

  const content = await (await fetch(`${server.url}/notes/${note.id}/content?${scope}`, { headers })).json()
  assert.equal(content.content, '# 设计记录\n\n正文')
  assert.equal((await fetch(`${server.url}/notes/${note.id}/content?${scope}`, { method: 'POST', headers })).status, 405)
})

test('activity control never falls back to all documents when a session has no mounts', async (t) => {
  let listed = false
  const server = await activityServer({
    async resolveMounts() { return [] },
    async listDocumentIndex() { listed = true; return { items: [document], total: 1 } },
    async getDocument() { return document },
  })
  t.after(server.close)
  const headers = { 'x-dsh-knowledge-client': 'conversation-web' }
  const response = await fetch(`${server.url}/documents?sessionId=empty`, { headers })
  assert.deepEqual(await response.json(), { items: [], total: 0 })
  assert.equal(listed, false)
  assert.equal((await fetch(`${server.url}/documents/document-a?sessionId=empty`, { headers })).status, 404)
})
