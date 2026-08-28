import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { noteReferenceMarkdown } from '../lib/notes/domain.js'
import { NoteStore } from '../lib/notes/store.js'

test('note store provides a stable, nested document tree independent from knowledge bases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-note-store-'))
  const store = new NoteStore(root)
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })

  const projects = await store.createFolder('项目')
  const dsh = await store.createFolder('DSH', projects.id)
  const note = await store.createDocument('部署记录', dsh.id, '# 部署记录\n\n保持原始内容。')
  const file = await store.upload({
    parentId: dsh.id,
    name: '拓扑图.png',
    mediaType: 'image/png',
    content: Buffer.from('opaque image bytes'),
  })
  const textFile = await store.upload({
    parentId: dsh.id,
    name: '环境说明.txt',
    mediaType: 'text/plain',
    content: Buffer.from('初始说明'),
  })

  assert.match(note.id, /^note_[a-f0-9]{32}$/)
  assert.equal(note.name, '部署记录.md')
  assert.equal((await store.read(note.id)).content.toString('utf8'), '# 部署记录\n\n保持原始内容。')
  assert.deepEqual(store.list({ parentId: projects.id }).map(node => node.name), ['DSH'])
  assert.deepEqual(new Set(store.list({ parentId: dsh.id }).map(node => node.name)), new Set(['部署记录.md', '拓扑图.png', '环境说明.txt']))
  assert.equal(noteReferenceMarkdown(note), `@[部署记录.md](note://${note.id})`)

  const updatedTextFile = await store.updateContent(textFile.id, Buffer.from('更新后的说明'))
  assert.equal(updatedTextFile.editable, true)
  assert.equal(file.editable, false)
  assert.equal(updatedTextFile.size, Buffer.byteLength('更新后的说明'))
  assert.equal((await store.read(textFile.id)).content.toString('utf8'), '更新后的说明')
  await assert.rejects(() => store.updateContent(file.id, Buffer.from('not an image')), /text-based note files/)

  const renamed = store.rename(note.id, '上线记录.md')
  assert.equal(renamed.name, '上线记录.md')
  const copied = await store.copy(dsh.id)
  assert.equal(copied.name, 'DSH 副本')
  assert.equal(store.list({ parentId: copied.id }).length, 3)
  store.move(file.id, projects.id)
  assert.equal(store.get(file.id)?.parentId, projects.id)
  assert.throws(() => store.move(projects.id, dsh.id), /descendants/)

  const objects = await readdir(join(root, 'objects'))
  assert.ok(objects.includes(note.id))
  await store.delete(projects.id)
  assert.equal(store.get(projects.id), undefined)
  assert.equal(store.get(note.id), undefined)
})
