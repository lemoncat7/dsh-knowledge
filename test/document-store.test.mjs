import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  parseKnowledgeMarkdown,
  renderKnowledgeMarkdown,
} from '../lib/documents/markdown.js'
import {
  KNOWLEDGE_BASE_MANIFEST,
  KnowledgeDocumentStore,
  isWindowsReplaceError,
  supportsDirectorySync,
} from '../lib/documents/store.js'

const base = {
  id: 'kb-document-test',
  name: 'DSH 开发规范',
  description: '收录 DSH 插件架构和部署规范。',
  defaultTags: ['dsh'],
  extractionInstructions: '只收录确认后的长期结论。',
  status: 'active',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-document-store-'))
  const store = new KnowledgeDocumentStore(join(root, 'bases'))
  await store.initialize()
  const directory = await store.createBase(base)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, store, directory }
}

function markdown(body = '服务使用 Docker Compose 部署。') {
  return renderKnowledgeMarkdown({
    metadata: {
      id: 'doc-deploy',
      type: 'procedure',
      tags: ['Docker', 'DSH'],
      scope: { kind: 'global' },
      confidence: 0.93,
      status: 'active',
    },
    title: 'Docker 部署规范',
    body,
  })
}

test('managed knowledge directories contain portable manifests and real Markdown documents', async (t) => {
  const { store, directory } = await fixture(t)
  const manifest = await readFile(join(directory, KNOWLEDGE_BASE_MANIFEST), 'utf8')
  assert.match(manifest, /id: kb-document-test/)
  assert.match(manifest, /name: DSH 开发规范/)

  const created = await store.createDocument(directory, 'Docker 部署规范', markdown())
  assert.equal(created.metadata.id, 'doc-deploy')
  assert.equal(created.title, 'Docker 部署规范')
  assert.deepEqual(created.metadata.tags, ['docker', 'dsh'])
  assert.match(await readFile(join(directory, created.relPath), 'utf8'), /# Docker 部署规范/)
  assert.deepEqual((await store.listDocuments(directory)).map(document => document.metadata.id), ['doc-deploy'])

  const updated = await store.updateDocument(
    directory,
    created.relPath,
    markdown('服务使用 Docker Compose 部署，更新前先备份持久卷。'),
    created.contentHash,
  )
  assert.match(updated.body, /备份持久卷/)
  await assert.rejects(
    () => store.updateDocument(directory, created.relPath, markdown('覆盖内容。'), created.contentHash),
    /changed on disk/,
  )
})

test('document parser rejects malformed metadata and store blocks path traversal', async (t) => {
  const { store, directory } = await fixture(t)
  assert.throws(() => parseKnowledgeMarkdown('# no front matter'), /front matter/)
  assert.throws(() => parseKnowledgeMarkdown('---\nid: x\ntype: fact\nscope:\n  kind: global\n---\n\n# Empty'), /body cannot be empty/)
  await assert.rejects(() => store.readDocument(directory, '../outside.md'), /escapes/)
})

test('directory durability follows platform file-system capabilities', () => {
  assert.equal(supportsDirectorySync('win32'), false)
  assert.equal(supportsDirectorySync('linux'), true)
  assert.equal(supportsDirectorySync('darwin'), true)
})

test('existing files use the Windows replacement fallback only for compatible rename errors', () => {
  const error = code => Object.assign(new Error(code), { code })
  assert.equal(isWindowsReplaceError(error('EPERM'), true, 'win32'), true)
  assert.equal(isWindowsReplaceError(error('EEXIST'), true, 'win32'), true)
  assert.equal(isWindowsReplaceError(error('EPERM'), false, 'win32'), false)
  assert.equal(isWindowsReplaceError(error('EPERM'), true, 'linux'), false)
  assert.equal(isWindowsReplaceError(error('EACCES'), true, 'win32'), false)
})
