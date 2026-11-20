import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { WikiCommitter, wikiHash } from '../lib/wiki/commit.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-review-fix-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'workspace')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: 'Review', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot, conversationEnabled: true })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const create = async title => provider.writeDirect({ action: 'create', reason: 'review', draft: {
    knowledgeBaseId: base.id, title, body: `${title}正文`, type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .9,
    source: { sessionId: 'same-session', turn: 7, evidence: 'explicit' },
  } }, 'same-session:7')
  return { provider, base: base.id, workspaceRoot, create }
}

test('same-turn direct writes return their own entry and retries keep that entry', async t => {
  const { provider, base, create } = await fixture(t)
  const first = await create('第一篇'), second = await create('第二篇')
  assert.equal(first.entry.title, '第一篇')
  assert.equal(second.entry.title, '第二篇')
  assert.notEqual(first.entry.id, second.entry.id)
  const retry = await create('第二篇')
  assert.equal(retry.entry.id, second.entry.id)
  assert.equal((await provider.wiki.store(base).manifest()).pages.length, 2)
})

test('a stale manifest is rejected rather than overwriting a newer page version', async t => {
  const { provider, base, workspaceRoot, create } = await fixture(t)
  await create('快照页')
  const store = provider.wiki.store(base), stale = await store.manifest()
  const current = await store.page(stale.pages[0].pageId)
  const bytes = Buffer.from(current.bytes.toString() + '\n后续编辑\n')
  await store.save(current.page.pageId, bytes, wikiHash(current.bytes), { kind: 'manual', actor: 'test' }, 'edit-newer')
  const staleTarget = await store.manifestTarget(stale)
  await assert.rejects(() => new WikiCommitter(workspaceRoot).commit({ operationId: 'stale-manifest', targets: [staleTarget] }), /WIKI_FILE_CONFLICT|WIKI_MANIFEST_CONFLICT/)
  const after = await store.manifest()
  assert.equal(after.pages[0].version, 2)
  assert.equal(after.pages[0].fileSha256, wikiHash(bytes))
})

test('index finalization detects mismatched files without reentering the commit queue', { timeout: 6000 }, async t => {
  const { provider, base, workspaceRoot, create } = await fixture(t)
  await create('外部编辑')
  const store = provider.wiki.store(base), manifest = await store.manifest()
  const page = manifest.pages[0]
  await writeFile(join(workspaceRoot, page.relPath), Buffer.from('# 外部编辑\n\n外部新版本\n'))
  const target = await store.manifestTarget(manifest)
  const result = await Promise.race([
    store.committer.commit({ operationId: 'mismatch-finalize', targets: [target] }).then(() => 'published', error => error.message),
    new Promise(resolve => { const timer = setTimeout(() => resolve('SELF_DEADLOCK'), 1500); timer.unref() }),
  ])
  assert.notEqual(result, 'SELF_DEADLOCK')
  assert.match(result, /WIKI_EXTERNAL_EDIT|WIKI_INDEX_SNAPSHOT/)
})
