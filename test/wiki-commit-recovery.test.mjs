import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WikiCommitter, wikiHash } from '../lib/wiki/commit.js'
import { listRaw, readRaw } from '../lib/wiki/raw.js'
import { resolveWikiLayout } from '../lib/wiki/paths.js'

async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wiki-commit-'))
  await mkdir(join(dir, 'wiki', 'notes'), { recursive: true })
  await mkdir(join(dir, '_meta', 'knowledge', 'commits'), { recursive: true })
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const target = (rel, bytes, expected = null) => ({ relPath: rel, expectedHash: expected, bytes: Buffer.from(bytes) })

test('a commit publishes every target and is replay-safe by operation id', async t => {
  const dir = await root(t)
  let finals = 0
  const committer = new WikiCommitter(dir, async () => { finals += 1 })
  const req = { operationId: 'op-a', targets: [target('wiki/notes/a.md', 'A'), target('index.md', 'IDX')] }
  await committer.commit(req)
  assert.equal(await readFile(join(dir, 'wiki', 'notes', 'a.md'), 'utf8'), 'A')
  assert.equal(await readFile(join(dir, 'index.md'), 'utf8'), 'IDX')
  await committer.commit(req)
  assert.equal(finals, 1, 'replaying the same operation must not finalize twice')
})

test('a commit interrupted after writing files is completed by recover', async t => {
  const dir = await root(t)
  let failFinalize = true
  const first = new WikiCommitter(dir, async () => { if (failFinalize) throw new Error('index down') })
  await assert.rejects(() => first.commit({ operationId: 'op-b', targets: [target('wiki/notes/b.md', 'B')] }), /index down/)
  assert.equal(await readFile(join(dir, 'wiki', 'notes', 'b.md'), 'utf8'), 'B')
  // Unsettled journal blocks any new work until recovery runs.
  await assert.rejects(() => first.commit({ operationId: 'op-c', targets: [target('wiki/notes/c.md', 'C')] }), /WIKI_RECOVERY_REQUIRED/)
  failFinalize = false
  const report = await first.recover()
  assert.equal(report.find(r => r.operationId === 'op-b').state, 'published')
  await first.commit({ operationId: 'op-c', targets: [target('wiki/notes/c.md', 'C')] })
  assert.equal(await readFile(join(dir, 'wiki', 'notes', 'c.md'), 'utf8'), 'C')
})

test('recovery never overwrites bytes a third party wrote in the meantime', async t => {
  const dir = await root(t)
  const first = new WikiCommitter(dir, async () => { throw new Error('down') })
  await assert.rejects(() => first.commit({ operationId: 'op-d', targets: [target('wiki/notes/d.md', 'D')] }))
  await writeFile(join(dir, 'wiki', 'notes', 'd.md'), 'HUMAN')
  const report = await first.recover()
  assert.equal(report.find(r => r.operationId === 'op-d').state, 'conflict')
  assert.equal(await readFile(join(dir, 'wiki', 'notes', 'd.md'), 'utf8'), 'HUMAN')
})

test('stale expected hash aborts before any target is written', async t => {
  const dir = await root(t)
  await writeFile(join(dir, 'index.md'), 'OLD')
  const committer = new WikiCommitter(dir)
  await assert.rejects(() => committer.commit({
    operationId: 'op-e',
    targets: [target('wiki/notes/e.md', 'E'), target('index.md', 'NEW', 'f'.repeat(64))],
  }), /WIKI_FILE_CONFLICT/)
  assert.equal(await readFile(join(dir, 'index.md'), 'utf8'), 'OLD')
  let created = true
  try { await readFile(join(dir, 'wiki', 'notes', 'e.md')) } catch { created = false }
  assert.equal(created, false, 'a rejected commit must not leave partial output')
})

test('raw browsing is read-only, paginates, and rejects escapes', async t => {
  const dir = await root(t)
  const workspace = join(dir, 'ws')
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'raw', 'sub'), { recursive: true })
  const layout = resolveWikiLayout({ kbId: 'kb', sourceDir: join(dir, 'src'), workspaceRoot: workspace })
  assert.equal(layout.rawDir, join(workspace, 'raw'))
  await mkdir(join(workspace, 'raw', 'sub'), { recursive: true })
  await writeFile(join(workspace, 'raw', 'a.md'), '安'.repeat(30))
  await writeFile(join(workspace, 'raw', 'sub', 'b.md'), 'b')
  const listed = await listRaw(layout)
  assert.deepEqual(listed.map(x => x.path).sort(), ['a.md', 'sub/b.md'])
  const first = await readRaw(layout, 'a.md', 0)
  assert.equal(first.text.length, 30)
  assert.equal(first.sha256, wikiHash(await readFile(join(workspace, 'raw', 'a.md'))))
  await assert.rejects(() => readRaw(layout, '../index.md', 0), /WIKI_RAW_PATH_INVALID|WIKI_RAW_ESCAPE/)
})
