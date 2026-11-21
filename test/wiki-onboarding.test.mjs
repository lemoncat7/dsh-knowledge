import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-connect-'))
  const provider = new LocalKnowledgeProvider(join(root, 'db.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'workspace')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: '接入测试', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  const store = provider.wiki.store(base.id)
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { provider, store, base: base.id, root, sourceDir, workspaceRoot }
}
const page = '# 旧知识\n\n已有原文，不应重写。\n'

test('partial registration admits valid pages, reports bad pages, and preserves originals and identity', async t => {
  const f = await fixture(t)
  const good = join(f.workspaceRoot, 'wiki', 'good.md'), bad = join(f.workspaceRoot, 'wiki', 'bad.md')
  await writeFile(good, page); await writeFile(bad, '---\ntitle: [broken\n---\ntext')
  await writeFile(join(f.sourceDir, 'original.txt'), '原件')
  const result = await f.store.importValid({ kind: 'project', id: 'private-project' }, 'partial-1')
  assert.equal(result.registered, 1); assert.equal(result.rejected, 1)
  assert.equal(result.items.find(i => i.relPath === 'bad.md').status, 'invalid')
  const first = (await f.store.manifest()).pages[0]
  assert.deepEqual(first.scope, { kind: 'project', id: 'private-project' })
  const second = await f.store.importValid({ kind: 'global' }, 'partial-2')
  assert.equal(second.registered, 0); assert.equal(second.existing, 1)
  const again = (await f.store.manifest()).pages[0]
  assert.equal(again.pageId, first.pageId); assert.deepEqual(again.scope, first.scope)
  assert.equal(await readFile(good, 'utf8'), page)
  assert.equal(await readFile(join(f.sourceDir, 'original.txt'), 'utf8'), '原件')
})

test('registration rejects files changed after inspection instead of accepting stale bytes', async t => {
  const f = await fixture(t), target = join(f.workspaceRoot, 'wiki', 'one.md')
  await writeFile(target, page)
  const inspect = f.store.inspect.bind(f.store)
  f.store.inspect = async () => { const result = await inspect(); await writeFile(target, page + '外部修改\n'); return result }
  await assert.rejects(() => f.store.importValid({ kind: 'global' }, 'racing-import'), /WIKI_IMPORT_FILE_CHANGED/)
  assert.equal((await f.store.manifest()).pages.length, 0)
})

test('partial registration rejects a corrupt identity manifest', async t => {
  const f = await fixture(t)
  await mkdir(join(f.workspaceRoot, '_meta', 'knowledge'), { recursive: true })
  await writeFile(join(f.workspaceRoot, '_meta', 'knowledge', 'manifest.json'), '{broken')
  await assert.rejects(() => f.store.importValid({ kind: 'global' }, 'broken-import'))
})
