import test from 'node:test'
import assert from 'node:assert/strict'
import { createNoteRecording } from '../lib/note-recording.js'

test('host note recording rejects stale content, folders and unchanged updates', async () => {
  let content = 'original'
  let writes = 0
  const provider = {
    async getNote(id) { return id === 'note' ? { id, name: '记录', editable: true, kind: 'document' } : undefined },
    async readNote(id) { return { node: await this.getNote(id), content: new TextEncoder().encode(content) } },
    async updateNoteContent(_id, bytes) { writes++; content = new TextDecoder().decode(bytes) },
  }
  const service = createNoteRecording(provider)
  const baseline = await service.read('note')
  await assert.rejects(service.read('missing'), /不存在/)
  await assert.rejects(service.update('note', 'bad', 'stale'), /已变化/)
  assert.equal((await service.update('note', content, baseline.revision)).changed, false)
  assert.equal(writes, 0)
  await service.update('note', 'updated', baseline.revision)
  assert.equal(content, 'updated')
  await assert.rejects(service.update('note', 'bad', baseline.revision), /已变化/)
})
