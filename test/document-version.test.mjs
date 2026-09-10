import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { createNoteRecording } from '../lib/note-recording.js'

test('concurrent note writes compare their version inside the mutation queue', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-version-'))
  const p = new LocalKnowledgeProvider(join(root, 'db.sqlite'))
  t.after(async () => { await p.close(); await rm(root, { recursive: true, force: true }) })
  const note = await p.createNoteDocument('test', null, 'initial')
  const results = await Promise.allSettled([
    p.updateNoteContent(note.id, Buffer.from('A'), undefined, note.version),
    p.updateNoteContent(note.id, Buffer.from('B'), undefined, note.version),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409)
  assert.equal((await p.readNote(note.id)).content.toString(), 'A')
  assert.deepEqual((await p.listNoteVersions(note.id)).map(v => v.version), [2, 1])
  // Simulate another writer after the recording bridge reads, before it writes.
  const bridge = createNoteRecording({
    readNote: id => p.readNote(id),
    async updateNoteContent(id, bytes, signal, version) {
      await p.updateNoteContent(id, Buffer.from('human edit'))
      return p.updateNoteContent(id, bytes, signal, version)
    },
  })
  const baseline = await bridge.read(note.id)
  await assert.rejects(bridge.update(note.id, 'recording edit', baseline.revision), e => e.status === 409)
  assert.equal((await p.readNote(note.id)).content.toString(), 'human edit')

  const draft = { knowledgeBaseId: 'default', title: 'Version test', body: 'original', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 0.8 }
  const entry = await p.create(draft)
  const saved = await p.update(entry.id, { ...draft, body: 'first edit' }, undefined, entry.version)
  await assert.rejects(p.update(entry.id, { ...draft, body: 'stale edit' }, undefined, entry.version), e => e.code === 'CONFLICT')
  assert.equal((await p.get(entry.id)).body, 'first edit')
  assert.equal(saved.version, entry.version + 1)
})
