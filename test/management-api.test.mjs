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
  const attachment = await fetch(`${base}/notes/${note.id}/content?download=1`, { headers })
  assert.equal(attachment.headers.get('content-type'), 'text/markdown')
  assert.match(attachment.headers.get('content-disposition'), /attachment/)
  assert.match(attachment.headers.get('content-disposition'), /filename\*=UTF-8''%E9%83%A8%E7%BD%B2%E7%AC%94%E8%AE%B0\.md/)
  const revisedNoteContent = Buffer.from('# 更新后的部署笔记\n\n现在可以在笔记工作区直接编辑。')
  const updatedNoteResponse = await fetch(`${base}/notes/${note.id}/content`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'text/markdown' }, body: revisedNoteContent,
  })
  assert.equal(updatedNoteResponse.status, 200)
  const updatedNote = await updatedNoteResponse.json()
  assert.equal(updatedNote.size, revisedNoteContent.byteLength)
  assert.equal(updatedNote.version, 2)
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/notes/${note.id}/content`, { headers })).arrayBuffer()), revisedNoteContent)
  const versions = await (await fetch(`${base}/notes/${note.id}/versions`, { headers })).json()
  assert.deepEqual(versions.map(version => version.version), [2, 1])
  assert.equal(Object.hasOwn(versions[0], 'content'), false)
  const originalVersion = await fetch(`${base}/notes/${note.id}/versions/1/content`, { headers })
  assert.deepEqual(Buffer.from(await originalVersion.arrayBuffer()), noteContent)
  const restoredResponse = await fetch(`${base}/notes/${note.id}/versions/1/restore`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 2 }),
  })
  assert.equal(restoredResponse.status, 200)
  assert.equal((await restoredResponse.json()).version, 3)
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/notes/${note.id}/content`, { headers })).arrayBuffer()), noteContent)

  const shareResponse = await fetch(`${base}/notes/${folder.id}/share`, { method: 'POST', headers })
  assert.equal(shareResponse.status, 201)
  const share = await shareResponse.json()
  assert.match(share.token, /^share_[A-Za-z0-9_-]{32}$/)
  assert.equal(share.node.id, folder.id)
  const shares = await (await fetch(`${base}/notes/shares`, { headers })).json()
  assert.deepEqual(shares.map(item => item.noteId), [folder.id])
  const sharedPage = await fetch(`${base}/shared/${share.token}?note=${note.id}`)
  assert.equal(sharedPage.status, 200)
  assert.match(sharedPage.headers.get('content-type'), /text\/html/)
  assert.match(sharedPage.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const sharedHtml = await sharedPage.text()
  assert.match(sharedHtml, /项目资料/)
  assert.match(sharedHtml, /部署笔记\.md/)
  assert.match(sharedHtml, /内容默认不参与知识索引/)
  assert.match(sharedHtml, /class="markdown-body"/)
  assert.match(sharedHtml, /<h1 id="原始部署笔记">/)
  assert.match(sharedHtml, /class="share-panel directory-panel" open/)
  assert.match(sharedHtml, /class="share-panel outline-panel" open/)
  assert.match(sharedHtml, /href="#原始部署笔记"/)
  assert.match(sharedHtml, /grid-template-rows:auto minmax\(0,1fr\) auto/)
  assert.match(sharedHtml, /\.share-content\{min-height:0;display:block;overflow:auto/)
  const sharedDownload = await fetch(`${base}/shared/${share.token}/content?noteId=${note.id}&download=1`)
  assert.equal(sharedDownload.status, 200)
  assert.match(sharedDownload.headers.get('content-disposition'), /attachment/)
  assert.deepEqual(Buffer.from(await sharedDownload.arrayBuffer()), noteContent)
  const manifestResponse = await fetch(`${base}/shared/${share.token}/manifest`)
  assert.equal(manifestResponse.status, 200)
  const manifest = await manifestResponse.json()
  assert.equal(manifest.version, 1)
  assert.equal(manifest.share.name, '项目资料')
  assert.equal(manifest.share.fileCount, 1)
  assert.deepEqual(manifest.nodes.map(item => item.path), ['项目资料', '项目资料/部署笔记.md'])
  const inspectResponse = await fetch(`${base}/notes/import-share/inspect`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${base}/shared/${share.token}` }),
  })
  assert.equal(inspectResponse.status, 200)
  assert.equal((await inspectResponse.json()).manifest.share.name, '项目资料')
  const blockedInspectResponse = await fetch(`${base}/notes/import-share/inspect`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${address.port}${LOCAL_MANAGEMENT_API_PREFIX}/shared/share_${'x'.repeat(32)}` }),
  })
  assert.equal(blockedInspectResponse.status, 400)
  assert.match((await blockedInspectResponse.json()).error, /私有网络/)
  const importResponse = await fetch(`${base}/notes/import-share`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${base}/shared/${share.token}`, parentId: null }),
  })
  assert.equal(importResponse.status, 201)
  const imported = await importResponse.json()
  assert.equal(imported.root.name, '项目资料 副本')
  assert.equal(imported.importedNodes, 2)
  assert.equal((await provider.notes.read(provider.notes.list({ parentId: imported.root.id })[0].id)).content.toString('utf8'), noteContent.toString('utf8'))
  await provider.notes.delete(imported.root.id)
  assert.equal((await fetch(`${base}/shared/${share.token}?note=not-a-note`)).status, 404)

  const entry = await (await fetch(`${base}/entries`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ draft: {
      knowledgeBaseId: 'default', title: '笔记引用测试',
      body: '依据独立关联的原始部署资料。',
      type: 'fact', tags: ['note'], scope: { kind: 'global' }, confidence: 0.9,
    } }),
  })).json()
  const linkedResponse = await fetch(`${base}/entries/${entry.id}/note-references`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ noteId: note.id }),
  })
  assert.equal(linkedResponse.status, 201)
  const linked = await linkedResponse.json()
  assert.equal(linked.note.id, note.id)
  assert.equal(linked.source, 'user')
  assert.equal((await (await fetch(`${base}/entries/${entry.id}/note-references`, { headers })).json())[0].note.id, note.id)
  assert.doesNotMatch((await (await fetch(`${base}/entries/${entry.id}`, { headers })).json()).body, /note:\/\//)
  const documentIndex = await (await fetch(`${base}/document-index?knowledgeBaseId=default&limit=1`, { headers })).json()
  assert.equal(documentIndex.total, 1)
  assert.equal(documentIndex.items[0].id, entry.id)
  assert.equal(Object.hasOwn(documentIndex.items[0], 'content'), false)
  const candidate = await provider.propose({
    action: 'update', targetId: entry.id,
    draft: { ...entry, body: '候选更新内容。' },
    reason: '验证审核页批量加载目标文档',
  })
  const candidatePayload = await (await fetch(`${base}/candidates?status=pending&limit=100&includeTargets=1`, { headers })).json()
  assert.deepEqual(candidatePayload.items.map(item => item.id), [candidate.id])
  assert.deepEqual(candidatePayload.targets.map(item => item.id), [entry.id])
  const bulkResponse = await fetch(`${base}/candidates/bulk-review`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 25, excludeIds: [] }),
  })
  assert.equal(bulkResponse.status, 200)
  assert.deepEqual(await bulkResponse.json(), {
    selected: 1, approved: 1, deferred: 0, failed: [], remainingReviewable: 0, remainingManual: 0,
  })
  assert.equal((await fetch(`${base}/candidates/bulk-review`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 0 }),
  })).status, 400)
  const references = await (await fetch(`${base}/notes/${folder.id}/references`, { headers })).json()
  assert.deepEqual(references.map(item => item.documentId), [entry.id])
  assert.equal((await fetch(`${base}/notes/${folder.id}`, { method: 'DELETE', headers })).status, 409)
  assert.equal((await fetch(`${base}/entries/${entry.id}/note-references/${note.id}`, { method: 'DELETE', headers })).status, 204)
  assert.deepEqual(await (await fetch(`${base}/entries/${entry.id}/note-references`, { headers })).json(), [])
  assert.equal((await fetch(`${base}/notes/${folder.id}/share`, { method: 'DELETE', headers })).status, 204)
  assert.equal((await fetch(`${base}/shared/${share.token}`)).status, 404)
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
