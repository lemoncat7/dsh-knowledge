import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { createWikiDistiller } from '../lib/wiki/distill.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-distill-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'archive'), workspaceRoot = join(root, 'ws')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  await writeFile(join(workspaceRoot, 'schema.md'), '# 约定\n')
  const base = await provider.createKnowledgeBase({ name: 'Wiki', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  await mkdir(join(workspaceRoot, 'wiki', 'notes'), { recursive: true })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return { provider, kb: base.id, sourceDir, workspaceRoot, root }
}

function itemFor(sha, raw) {
  return { id: 'item-1', source: 'x', sha, size: 10, stage: 'extracted', archived: '/archive/cat/a.txt', raw }
}

const modelReturning = value => async () => value

test('distillation publishes a page plus index and log, and is replay-safe', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  const rawPath = join(workspaceRoot, 'raw', 'a.txt--abc.md')
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  await writeFile(rawPath, '# 原件\n\n提取出的正文，具备成文价值。\n')
  const item = itemFor('a'.repeat(64), rawPath)
  const model = modelReturning({ title: '导出步骤', body: '1. 打开软件\n2. 导出参数', tags: ['导出'], keywords: ['导出', '参数'] })
  const distill = createWikiDistiller(provider.wiki, model)
  const settings = { python: 'py', provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }

  const pages = await distill(kb, item, settings, 'op-d1', new AbortController().signal)
  assert.equal(pages.length, 1)
  const manifest = await provider.wiki.store(kb).manifest()
  assert.equal(manifest.pages.length, 1)
  assert.equal(manifest.pages[0].relPath, pages[0])
  const body = await readFile(join(workspaceRoot, pages[0]), 'utf8')
  assert.match(body, /导出步骤/)
  assert.match(body, /sources:/)
  const index = await readFile(join(workspaceRoot, 'index.md'), 'utf8')
  assert.match(index, /导出步骤/)
  const log = await readFile(join(workspaceRoot, 'log.md'), 'utf8')
  assert.match(log, /op-d1/)
  const entry = await provider.get(manifest.pages[0].entryId)
  assert.equal(entry.title, '导出步骤')
  assert.equal(entry.type, 'fact')

  const replay = await distill(kb, item, settings, 'op-d1', new AbortController().signal)
  assert.deepEqual(replay, pages)
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 1)
  assert.equal((await readFile(join(workspaceRoot, 'log.md'), 'utf8')).match(/op-d1/g).length, 1)
})

test('updating an existing page needs explicit approval before the file changes', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  const rawPath = join(workspaceRoot, 'raw', 'b.md')
  await writeFile(rawPath, '# 原件\n\n同一主题的新版本内容。\n')
  const settings = { python: 'py', provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }
  const create = createWikiDistiller(provider.wiki, modelReturning({ title: '既有页', body: '原始正文内容。', tags: [], keywords: [] }))
  await create(kb, itemFor('b'.repeat(64), rawPath), settings, 'op-new', new AbortController().signal)
  const target = (await provider.wiki.store(kb).manifest()).pages[0]
  const targetPath = join(workspaceRoot, target.relPath)
  const before = await readFile(targetPath, 'utf8')

  const update = createWikiDistiller(provider.wiki, modelReturning({ title: '既有页', body: '补充后的正文内容。', tags: [], keywords: [], targetPageId: target.pageId }))
  await assert.rejects(() => update(kb, itemFor('c'.repeat(64), rawPath), settings, 'op-upd', new AbortController().signal), /WIKI_DISTILL_UPDATE_REQUIRES_REVIEW/)
  assert.equal(await readFile(targetPath, 'utf8'), before, 'unapproved update must not touch the page')
  const pending = provider.wiki.proposals.list(kb)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].state, 'pending')

  await provider.wiki.proposals.review(kb, pending[0].id, true)
  assert.match(await readFile(targetPath, 'utf8'), /补充后的正文内容/)
  assert.equal(provider.wiki.proposals.list(kb)[0].state, 'approved')

  const replay = await update(kb, itemFor('c'.repeat(64), rawPath), settings, 'op-upd', new AbortController().signal)
  assert.deepEqual(replay, [target.relPath])
  assert.equal(provider.wiki.proposals.list(kb).length, 1)

  const rejected = createWikiDistiller(provider.wiki, modelReturning({ title: '既有页', body: '再来一版。', tags: [], keywords: [], targetPageId: target.pageId }))
  await assert.rejects(() => rejected(kb, itemFor('d'.repeat(64), rawPath), settings, 'op-rej', new AbortController().signal), /WIKI_DISTILL_UPDATE_REQUIRES_REVIEW/)
  const second = provider.wiki.proposals.list(kb).find(p => p.state === 'pending')
  await provider.wiki.proposals.review(kb, second.id, false)
  await assert.rejects(() => rejected(kb, itemFor('d'.repeat(64), rawPath), settings, 'op-rej', new AbortController().signal), /WIKI_DISTILL_PROPOSAL_REJECTED/)
})

test('a model answer that is not a usable page is rejected without writing', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  await writeFile(join(workspaceRoot, 'raw', 'c.md'), '正文')
  const settings = { python: 'py', provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }
  for (const bad of [{ title: '', body: 'x' }, { title: 'x', body: '' }, { title: 'x', body: 'y', targetPageId: 'missing' }]) {
    const distill = createWikiDistiller(provider.wiki, modelReturning(bad))
    await assert.rejects(() => distill(kb, itemFor('e'.repeat(64), join(workspaceRoot, 'raw', 'c.md')), settings, 'op-bad-' + JSON.stringify(bad).length, new AbortController().signal))
  }
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 0)
})
