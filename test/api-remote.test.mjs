import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'

test('remote provider interoperates with the authenticated local API', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-api-'))
  const local = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const token = 'remote_test_token_longer_than_24_chars'
  local.ensureBootstrapToken(token)
  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerKnowledgeApi(ctx, local, '/knowledge-api/v1')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const remote = new RemoteKnowledgeProvider({
    url: `http://127.0.0.1:${address.port}/knowledge-api/v1`,
    token,
    timeoutMs: 5000,
  })
  t.after(async () => {
    await remote.close()
    await new Promise(resolve => server.close(resolve))
    await local.close()
    await rm(root, { recursive: true, force: true })
  })

  const health = await fetch(`http://127.0.0.1:${address.port}/knowledge-api/v1/health`).then(response => response.json())
  assert.deepEqual(health, { ok: true, service: 'dsh-knowledge', schemaVersion: 13 })

  assert.equal((await remote.getSettings()).writebackPolicy, 'conservative')
  assert.equal((await remote.updateSettings({ writebackPolicy: 'proactive' })).writebackPolicy, 'proactive')

  const entry = await remote.create({
    knowledgeBaseId: 'default',
    title: 'Central knowledge service',
    body: 'Other clients connect to the central knowledge API over HTTPS.',
    type: 'decision',
    tags: ['remote'],
    scope: { kind: 'global' },
    confidence: 0.9,
  })
  assert.equal((await remote.get(entry.id))?.title, 'Central knowledge service')
  assert.equal((await remote.search({ text: 'central knowledge', limit: 5 })).length, 1)
  assert.equal((await remote.stats()).entries.active, 1)
  const folder = await remote.createNoteFolder('Central references')
  const note = await remote.createNoteDocument('Central service source', folder.id, '# Private source note\n\nDo not expose this body through metadata search.')
  assert.deepEqual((await remote.listNotes({ parentId: null })).map(item => item.id), [folder.id])
  assert.deepEqual((await remote.listNotes({ parentId: folder.id })).map(item => item.id), [note.id])
  assert.equal((await remote.getNote(note.id))?.name, 'Central service source.md')
  assert.match(new TextDecoder().decode((await remote.readNote(note.id)).content), /Private source note/)
  await remote.updateNoteContent(note.id, new TextEncoder().encode('# Revised source note'))
  assert.match(new TextDecoder().decode((await remote.readNote(note.id)).content), /Revised source note/)
  const renamedNote = await remote.renameNote(note.id, 'Central source.md')
  assert.equal(renamedNote.name, 'Central source.md')
  assert.equal((await remote.moveNote(note.id, null)).parentId, null)
  const noteMatches = await remote.searchNotes('Central service', 10)
  assert.deepEqual(noteMatches, [])
  const renamedMatches = await remote.searchNotes('Central source', 10)
  assert.deepEqual(renamedMatches.map(item => item.id), [note.id])
  assert.equal(Object.hasOwn(renamedMatches[0], 'content'), false)
  const linked = await remote.addKnowledgeNoteReference(entry.id, note.id, 'agent', 'remote-session')
  assert.equal(linked.note.id, note.id)
  assert.equal(linked.source, 'agent')
  assert.equal(linked.sourceSessionId, 'remote-session')
  assert.deepEqual((await remote.listKnowledgeNoteReferences(entry.id)).map(item => item.note.id), [note.id])
  await remote.deleteKnowledgeNoteReference(entry.id, note.id)
  assert.deepEqual(await remote.listKnowledgeNoteReferences(entry.id), [])
  await remote.deleteNote(note.id)
  assert.equal(await remote.getNote(note.id), undefined)
  await remote.deleteNote(folder.id)
  const documents = await remote.listDocuments('default', 'central knowledge')
  assert.match(documents[0]?.relPath || '', /^Central-knowledge-service--[a-zA-Z0-9]+\.md$/)
  assert.equal(documents[0]?.id, entry.id)
  assert.match((await remote.getDocument(documents[0].id))?.content || '', /Central knowledge service/)
  const documentIndex = await remote.listDocumentIndex({ knowledgeBaseIds: ['default'], query: 'central knowledge', limit: 10 })
  assert.deepEqual(documentIndex.items.map(item => item.id), [entry.id])
  assert.equal(Object.hasOwn(documentIndex.items[0], 'content'), false)

  const base = await remote.createKnowledgeBase({
    name: 'Shared project knowledge', description: 'Mounted by remote clients.',
    defaultTags: ['shared'], extractionInstructions: 'Keep cross-client decisions.',
    writebackProvider: 'kimi', writebackModel: 'kimi-k2.7-code',
  })
  assert.deepEqual(
    [base.writebackProvider, base.writebackModel],
    ['kimi', 'kimi-k2.7-code'],
  )
  const patched = await remote.patchKnowledgeBase(base.id, {
    description: 'Only conversations about the shared project qualify.',
    defaultTags: ['shared', 'project'],
    writebackProvider: null,
    writebackModel: null,
  })
  assert.equal(patched.description, 'Only conversations about the shared project qualify.')
  assert.deepEqual(patched.defaultTags, ['project', 'shared'])
  assert.equal(patched.writebackProvider, undefined)
  assert.equal(patched.writebackModel, undefined)
  await remote.upsertMount({
    targetKind: 'project', targetId: '/workspace/demo', knowledgeBaseId: base.id,
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: ['shared'], excludeTags: [], extractionInstructions: '',
  })
  assert.equal((await remote.resolveMounts('remote-session', '/workspace/demo'))[0]?.knowledgeBaseId, base.id)
  assert.equal((await remote.archiveKnowledgeBase(base.id)).status, 'archived')
  assert.equal((await remote.restoreKnowledgeBase(base.id)).status, 'active')

  const candidate = await remote.propose({
    action: 'create',
    draft: {
      ...entry,
      body: 'Other clients connect to the central knowledge API over authenticated HTTPS.',
      source: { sessionId: 'remote-session', turn: 1, evidence: 'verified' },
    },
    reason: 'Clarifies authentication.',
  }, 'remote-session:1')
  assert.equal(candidate.draft.source?.evidence, 'verified')
  await remote.review(candidate.id, { decision: 'approve' })
  assert.equal((await remote.get(entry.id))?.version, 2)
  assert.equal((await remote.get(entry.id))?.source?.evidence, 'verified')
  assert.match((await remote.get(entry.id))?.body || '', /over HTTPS/)
  assert.match((await remote.get(entry.id))?.body || '', /authenticated HTTPS/)
  for (let index = 0; index < 3; index += 1) {
    await remote.propose({
      action: 'create',
      draft: {
        knowledgeBaseId: 'default', title: `Remote batch ${index}`, body: `Remote batch body ${index}.`,
        type: 'fact', tags: ['remote-batch'], scope: { kind: 'global' }, confidence: 0.91,
      },
      reason: 'Remote batch contract.',
    }, `remote-batch:${index}`)
  }
  const batch = await remote.approvePendingBatch(2)
  assert.deepEqual(batch, {
    selected: 2, approved: 2, deferred: 0, failed: [],
    remainingReviewable: 1, remainingManual: 0,
  })
  assert.equal((await remote.approvePendingBatch(2)).approved, 1)
  const batchEntries = (await remote.list({ knowledgeBaseId: 'default', status: 'active', limit: 100 })).items
    .filter(item => item.tags.includes('remote-batch'))
  assert.equal(batchEntries.length, 3)
  for (const batchEntry of batchEntries) await remote.delete(batchEntry.id)
  assert.equal((await remote.list({ knowledgeBaseId: 'default', status: 'active', limit: 10 })).items.length, 1)
  const direct = await remote.writeDirect({
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', title: 'Central knowledge service',
      body: 'Other clients connect to the central knowledge API over authenticated HTTPS. Keep client tokens private.',
      type: 'decision', tags: ['remote', 'security'], scope: { kind: 'global' }, confidence: 0.96,
    },
    reason: 'Adds compatible security guidance.',
  }, 'remote-direct:1')
  assert.equal(direct.outcome, 'merged')
  assert.match((await remote.get(entry.id))?.body || '', /tokens private/)
  assert.equal((await remote.search({ text: 'authenticated HTTPS tokens private', limit: 5 }))[0]?.entry.id, entry.id)
  assert.equal((await remote.listDocuments('default')).length, 1)
  assert.equal(await remote.claimExtraction('remote-writeback:1'), true)
  await remote.completeExtraction('remote-writeback:1', {
    outcome: 'completed', candidateCount: 1, directCount: 1, auditCount: 0,
    destinations: [{
      knowledgeBaseId: 'default', knowledgeBaseName: '默认知识库', documentId: entry.id,
      documentTitle: entry.title, documentPath: 'Central-knowledge-service--remote.md', disposition: 'written',
    }],
  })
  assert.equal((await remote.extractionJob('remote-writeback:1'))?.completion?.destinations[0]?.documentTitle, entry.title)
  const finalized = await remote.finalize(entry.id, 'complete', 'The central-service documentation is complete.')
  assert.equal(finalized.documentState, 'complete')
  assert.equal((await remote.getDocument(entry.id))?.documentState, 'complete')
  const moved = await remote.moveDocument(entry.id, base.id)
  assert.equal(moved.knowledgeBaseId, base.id)
  assert.equal(moved.documentState, 'complete')
  assert.deepEqual((await remote.listDocuments(base.id)).map(document => document.id), [entry.id])
  assert.deepEqual(await remote.listDocuments('default'), [])
  await remote.moveDocument(entry.id, 'default')
  await assert.rejects(
    () => remote.update(entry.id, { ...entry, body: 'Finalized documents cannot be edited.' }),
    /is finalized as collection complete/,
  )
  const finalizedWrite = await remote.writeDirect({
    action: 'create',
    draft: { ...entry, body: 'Additional material for the same finalized topic.' },
    reason: 'Must not modify a finalized document.',
  })
  assert.equal(finalizedWrite.outcome, 'finalized')
  assert.equal((await remote.reopen(entry.id)).documentState, 'open')
  await assert.rejects(() => remote.deleteKnowledgeBase(base.id), /must be archived/)
  await remote.archiveKnowledgeBase(base.id)
  await remote.deleteKnowledgeBase(base.id)
  assert.equal(await remote.getKnowledgeBase(base.id), undefined)
})
