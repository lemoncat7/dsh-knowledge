import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-gate-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'archive'); await mkdir(sourceDir)
  const workspaceRoot = join(root, 'wiki-root'); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: '高素 Wiki', description: 'wiki', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return { provider, base: base.id, sourceDir, workspaceRoot, root }
}

const page = (title, body) => `---\ntitle: ${title}\nscope:\n  kind: global\ntags:\n  - 测试\n---\n\n# ${title}\n\n${body}\n`

test('same text on two paths stays two distinct pages, with index rebuild and search', async t => {
  const { provider, base, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'wiki', 'notes'), { recursive: true })
  const body = '相同正文内容，用于验证页面身份不依赖正文哈希。'
  await writeFile(join(workspaceRoot, 'wiki', 'notes', 'one.md'), page('同文页', body))
  await writeFile(join(workspaceRoot, 'wiki', 'notes', 'two.md'), page('同文页', body))
  const report = await provider.wiki.import(base, { kind: 'global' }, false)
  assert.equal(report.filter(r => r.status === 'new').length, 2)
  const pages = (await provider.wiki.store(base).manifest()).pages
  assert.equal(pages.length, 2)
  assert.notEqual(pages[0].entryId, pages[1].entryId)
  const listed = await provider.list({ knowledgeBaseId: base, limit: 10 })
  assert.equal(listed.items.length, 2)
  const hits = await provider.search({ text: '相同正文内容', limit: 10 })
  assert.ok(hits.length >= 1)
  // repeat import is idempotent
  await provider.wiki.import(base, { kind: 'global' }, false)
  assert.equal((await provider.wiki.store(base).manifest()).pages.length, 2)
})

test('conversation evidence is refused until the base opts in, then approval writes the file', async t => {
  const { provider, base, sourceDir, workspaceRoot, root } = await fixture(t)
  const draft = { knowledgeBaseId: base, title: '对话沉淀', body: '通过审核后写入文件。', type: 'procedure', tags: ['对话'], scope: { kind: 'global' }, confidence: 0.9, source: { sessionId: 's-1', turn: 3, evidence: 'explicit' } }
  const blocked = await provider.propose({ action: 'create', draft, reason: 'test' })
  await assert.rejects(() => provider.review(blocked.id, { decision: 'approve' }), /WIKI_CONVERSATION_STANDARD_NOT_ENABLED/)
  assert.equal((await provider.wiki.store(base).manifest()).pages.length, 0, 'blocked approval must not create files')

  await provider.wiki.configure({ kbId: base, sourceDir, workspaceRoot, conversationEnabled: true })
  const proposal = await provider.propose({ action: 'create', draft, reason: 'test' })
  const before = await provider.wiki.store(base).manifest()
  assert.equal(before.pages.length, 0, 'unapproved candidate must not create files')
  await provider.review(proposal.id, { decision: 'approve' })
  const after = await provider.wiki.store(base).manifest()
  assert.equal(after.pages.length, 1)
  const written = await readFile(join(root, 'wiki-root', after.pages[0].relPath))
  assert.match(written.toString(), /通过审核后写入文件/)
  const entry = await provider.get(after.pages[0].entryId)
  assert.equal(entry.title, '对话沉淀')
  assert.deepEqual(entry.scope, { kind: 'global' })
  await provider.review(proposal.id, { decision: 'approve' })
  assert.equal((await provider.wiki.store(base).manifest()).pages.length, 1)
})

test('rejected candidate leaves the workspace byte-identical', async t => {
  const { provider, base, workspaceRoot } = await fixture(t)
  const proposal = await provider.propose({ action: 'create', draft: { knowledgeBaseId: base, title: '不落盘', body: '拒绝后不应出现。', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 0.5 }, reason: 'x' })
  const snapshot = async () => (await provider.wiki.store(base).inspect()).length
  const beforeCount = await snapshot()
  await provider.review(proposal.id, { decision: 'reject' })
  assert.equal(await snapshot(), beforeCount)
  assert.equal((await provider.wiki.store(base).manifest()).pages.length, 0)
  let exists = true
  try { await stat(join(workspaceRoot, 'wiki')) } catch { exists = false }
  assert.equal((await provider.wiki.store(base).inspect()).length, 0)
})

test('unsupported Wiki mutations are refused instead of silently projecting', async t => {
  const { provider, base } = await fixture(t)
  const proposal = await provider.propose({ action: 'create', draft: { knowledgeBaseId: base, title: '受限', body: '正文。', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 0.9 }, reason: 'x' })
  await provider.review(proposal.id, { decision: 'approve' })
  const entryId = (await provider.wiki.store(base).manifest()).pages[0].entryId
  await assert.rejects(() => provider.archive(entryId), /Wiki/)
  await assert.rejects(() => provider.assignDocumentGroup(base, [entryId], '分组'), /Wiki/)
  await assert.rejects(() => provider.moveDocument(entryId, 'other'), /Wiki/)
})

test('commit conflict preserves third-party bytes and blocks later commits', async t => {
  const { provider, base, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'wiki', 'notes'), { recursive: true })
  const target = join(workspaceRoot, 'wiki', 'notes', 'x.md')
  await writeFile(target, page('原件', '初始正文'))
  await provider.wiki.import(base, { kind: 'global' }, false)
  const store = provider.wiki.store(base)
  const pageId = (await store.manifest()).pages[0].pageId
  const bytes = await readFile(target)
  // External edit happens after the caller read the hash.
  await writeFile(target, page('原件', '外部修改'), { flag: 'r+' })
  await assert.rejects(() => store.save(pageId, Buffer.from(page('原件', '提交内容')), '0'.repeat(64), { kind: 'manual', actor: 't' }, 'op-1'), /WIKI_INDEX_VERSION_CONFLICT/)
  assert.match((await readFile(target)).toString(), /外部修改/)
  assert.ok(bytes.length > 0)
})
