import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  assert.equal(note.version, 1)
  assert.equal((await store.read(note.id)).content.toString('utf8'), '# 部署记录\n\n保持原始内容。')
  assert.deepEqual(store.list({ parentId: projects.id }).map(node => node.name), ['DSH'])
  assert.deepEqual(new Set(store.list({ parentId: dsh.id }).map(node => node.name)), new Set(['部署记录.md', '拓扑图.png', '环境说明.txt']))
  assert.equal(noteReferenceMarkdown(note), `@[部署记录.md](note://${note.id})`)

  const updatedTextFile = await store.updateContent(textFile.id, Buffer.from('更新后的说明'))
  assert.equal(updatedTextFile.editable, true)
  assert.equal(file.editable, false)
  assert.equal(updatedTextFile.size, Buffer.byteLength('更新后的说明'))
  assert.equal(updatedTextFile.version, 2)
  assert.equal((await store.read(textFile.id)).content.toString('utf8'), '更新后的说明')
  assert.deepEqual(store.listVersions(textFile.id).map(version => version.version), [2, 1])
  assert.deepEqual(store.listVersions(file.id), [])
  assert.equal((await readdir(join(root, 'versions'))).includes(file.id), false)
  await assert.rejects(() => store.updateContent(file.id, Buffer.from('not an image')), /text-based note files/)

  const revised = await store.updateContent(note.id, Buffer.from('# 部署记录\n\n第二版内容。'))
  assert.equal(revised.version, 2)
  assert.equal((await store.updateContent(note.id, Buffer.from('# 部署记录\n\n第二版内容。'))).version, 2)
  assert.deepEqual(store.listVersions(note.id).map(version => version.version), [2, 1])
  assert.equal((await store.readVersion(note.id, 1)).content.toString('utf8'), '# 部署记录\n\n保持原始内容。')
  const restored = await store.restoreVersion(note.id, 1, 2)
  assert.equal(restored.version, 3)
  assert.equal((await store.read(note.id)).content.toString('utf8'), '# 部署记录\n\n保持原始内容。')
  await assert.rejects(() => store.restoreVersion(note.id, 2, 2), /changed after its history was opened/)

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
  assert.deepEqual(await readdir(join(root, 'versions')), [])
})

test('note store migrates existing files into immutable version one snapshots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-note-store-v1-'))
  const id = `note_${'a'.repeat(32)}`
  const imageId = `note_${'b'.repeat(32)}`
  const content = Buffer.from('# 旧笔记\n\n迁移后仍可恢复。')
  const image = Buffer.from('legacy opaque image bytes')
  await mkdir(join(root, 'objects'), { recursive: true })
  await writeFile(join(root, 'objects', id), content)
  await writeFile(join(root, 'objects', imageId), image)
  const database = new DatabaseSync(join(root, 'notes.sqlite'))
  database.exec(`
    CREATE TABLE note_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT, parent_key TEXT NOT NULL,
      kind TEXT NOT NULL, name TEXT NOT NULL, media_type TEXT,
      size INTEGER NOT NULL, sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `)
  const sha256 = createHash('sha256').update(content).digest('hex')
  database.prepare(`INSERT INTO note_nodes VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    id, null, '', 'document', '旧笔记.md', 'text/markdown', content.byteLength, sha256,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  )
  database.prepare(`INSERT INTO note_nodes VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    imageId, null, '', 'file', '旧图片.png', 'image/png', image.byteLength, null,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  )
  database.close()

  const store = new NoteStore(root)
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(store.get(id)?.version, 1)
  assert.deepEqual(store.listVersions(id).map(version => version.version), [1])
  assert.equal((await store.readVersion(id, 1)).content.toString('utf8'), content.toString('utf8'))
  assert.deepEqual(store.listVersions(imageId), [])
  assert.equal((await readdir(join(root, 'versions'))).includes(imageId), false)
})
