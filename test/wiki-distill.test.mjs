import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { createWikiDistiller } from '../lib/wiki/distill.js'
import { wikiHash } from '../lib/wiki/commit.js'

const PYTHON = process.env.DSH_TEST_PYTHON || (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  : 'python3')

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
const settings = { python: 'py', provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }
const signal = () => new AbortController().signal

/** The archive manifest marks a folder as an existing category rather than a delivery. */
async function seedCategory(sourceDir, category) {
  await mkdir(join(sourceDir, category), { recursive: true })
  await writeFile(join(sourceDir, '归档清单.csv'),
    'id,category_dir,archive_file,archive_rel_path,size_bytes,sha256\r\n'
    + `1,"${category}","旧资料.txt","${category}\\旧资料.txt",0,"${'0'.repeat(64)}"\r\n`)
}

async function settle(ingest, kb, job, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (ingest.jobs(kb).find(j => j.id === job.id).state !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return ingest.jobs(kb).find(j => j.id === job.id)
}

test('distillation publishes a page plus index and log, and is replay-safe', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  const rawPath = join(workspaceRoot, 'raw', 'a.txt--abc.md')
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  await writeFile(rawPath, '# 原件\n\n提取出的正文，具备成文价值。\n')
  const item = itemFor('a'.repeat(64), rawPath)
  const distill = createWikiDistiller(provider.wiki, modelReturning({ title: '导出步骤', body: '1. 打开软件\n2. 导出参数', tags: ['导出'], keywords: ['导出', '参数'] }))

  const produced = await distill(kb, item, settings, 'op-d1', signal())
  assert.deepEqual(produced.updated, [])
  const pages = produced.pages
  assert.equal(pages.length, 1)
  assert.match(pages[0], /^wiki\/notes\/[a-f0-9]{64}\.md$/, '新建页面路径保持为既有形态')
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

  const replay = await distill(kb, item, settings, 'op-d1', signal())
  assert.deepEqual(replay, produced)
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 1)
  assert.equal((await readFile(join(workspaceRoot, 'log.md'), 'utf8')).match(/op-d1/g).length, 1)
})

test('a suggested update is written directly, keeps the page identity and leaves no pending candidate', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  const rawPath = join(workspaceRoot, 'raw', 'b.md')
  await writeFile(rawPath, '# 原件\n\n同一主题的新版本内容。\n')
  const create = createWikiDistiller(provider.wiki, modelReturning({ title: '既有页', body: '原始正文内容。', tags: [], keywords: [] }))
  await create(kb, itemFor('b'.repeat(64), rawPath), settings, 'op-new', signal())

  const before = (await provider.wiki.store(kb).manifest()).pages[0]
  const targetPath = join(workspaceRoot, before.relPath)
  const beforeBytes = await readFile(targetPath)
  const update = createWikiDistiller(provider.wiki, modelReturning({ title: '既有页', body: '补充后的正文内容。', tags: ['更新'], keywords: [], targetPageId: before.pageId }))
  const result = await update(kb, itemFor('c'.repeat(64), rawPath), settings, 'op-upd', signal())

  assert.deepEqual(result, { pages: [before.relPath], updated: [before.relPath] }, 'item.pages 记录被更新的页')
  const afterBytes = await readFile(targetPath)
  assert.notDeepEqual(afterBytes, beforeBytes)
  assert.match(afterBytes.toString('utf8'), /补充后的正文内容/)
  const after = (await provider.wiki.store(kb).manifest()).pages[0]
  assert.equal(after.pageId, before.pageId, '更新复用同一页面身份')
  assert.equal(after.relPath, before.relPath, '更新不改变页面路径')
  assert.equal(after.version, before.version + 1, 'version 递增')
  assert.equal(after.fileSha256, wikiHash(afterBytes))
  assert.equal(after.provenance.kind, 'distill')
  assert.equal(after.provenance.sourceSha256, 'c'.repeat(64))
  assert.deepEqual(after.scope, { kind: 'global' })
  assert.equal(provider.wiki.proposals.list(kb).length, 0, '不再生成待审候选')

  const log = await readFile(join(workspaceRoot, 'log.md'), 'utf8')
  assert.match(log, /更新 wiki\/notes\/[a-f0-9]{64}\.md/)
  assert.match(log, new RegExp('来源 sha256 ' + 'c'.repeat(64)), 'log.md 记录来源 sha')
  assert.match(log, /op-upd/)

  const entry = await provider.get(after.entryId)
  assert.match(entry.body, /补充后的正文内容/, '重建索引后内容为新版本')

  const replay = await update(kb, itemFor('c'.repeat(64), rawPath), settings, 'op-upd', signal())
  assert.deepEqual(replay, result)
  assert.equal((await readFile(join(workspaceRoot, 'log.md'), 'utf8')).match(/op-upd/g).length, 1, '重放不重复写审计行')
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 1)
})

test('an externally modified page fails the hash guard without being overwritten', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  const rawPath = join(workspaceRoot, 'raw', 'd.md')
  await writeFile(rawPath, '# 原件\n\n冲突保护用正文。\n')
  const create = createWikiDistiller(provider.wiki, modelReturning({ title: '既有页', body: '原始正文内容。', tags: [], keywords: [] }))
  await create(kb, itemFor('d'.repeat(64), rawPath), settings, 'op-new', signal())
  const target = (await provider.wiki.store(kb).manifest()).pages[0]
  const targetPath = join(workspaceRoot, target.relPath)
  const external = '# 外部改过\n\n外部正文，不能被覆盖。\n'
  await writeFile(targetPath, external)

  const update = createWikiDistiller(provider.wiki, modelReturning({ title: '既有页', body: '模型正文。', tags: [], keywords: [], targetPageId: target.pageId }))
  await assert.rejects(() => update(kb, itemFor('e'.repeat(64), rawPath), settings, 'op-conflict', signal()), /WIKI_EXTERNAL_EDIT_CONFLICT/)
  assert.equal(await readFile(targetPath, 'utf8'), external, '外部内容必须原样保留')
  const after = (await provider.wiki.store(kb).manifest()).pages[0]
  assert.equal(after.version, target.version)
  assert.equal(after.fileSha256, target.fileSha256)
  const log = await readFile(join(workspaceRoot, 'log.md'), 'utf8')
  assert.doesNotMatch(log, /op-conflict/, '冲突时不写审计行')
  assert.equal(provider.wiki.proposals.list(kb).length, 0)
})

test('an update across scopes is refused and writes nothing', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  const rawPath = join(workspaceRoot, 'raw', 'f.md')
  await writeFile(rawPath, '# 原件\n\n范围校验正文。\n')
  const create = createWikiDistiller(provider.wiki, modelReturning({ title: '全局页', body: '全局正文。', tags: [], keywords: [] }))
  await create(kb, itemFor('f'.repeat(64), rawPath), settings, 'op-scope-new', signal())
  const target = (await provider.wiki.store(kb).manifest()).pages[0]
  const targetPath = join(workspaceRoot, target.relPath)
  const before = await readFile(targetPath)

  const update = createWikiDistiller(provider.wiki, modelReturning({ title: '全局页', body: '越界正文。', tags: [], keywords: [], targetPageId: target.pageId }))
  await assert.rejects(() => update(kb, itemFor('f'.repeat(64), rawPath), { ...settings, scope: { kind: 'project', id: 'other' } }, 'op-scope', signal()), /WIKI_DISTILL_SCOPE_MISMATCH/)
  assert.deepEqual(await readFile(targetPath), before)
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 1)
})

test('ingest records updated pages separately from created pages', async t => {
  const { provider, kb, sourceDir, workspaceRoot } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '说明', confidence: 0.95 })
  await seedCategory(sourceDir, '说明')

  ingest.distill = async () => ({ pages: ['wiki/notes/updated.md'], updated: ['wiki/notes/updated.md'] })
  await writeFile(join(sourceDir, '更新示例.txt'), '这是原件正文，含二十个以上字符以满足 full 质量判定。')
  const updatedJob = await settle(ingest, kb, await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }))
  assert.equal(updatedJob.items[0].stage, 'done', updatedJob.items[0].error)
  assert.deepEqual(updatedJob.items[0].pages, ['wiki/notes/updated.md'])
  assert.deepEqual(updatedJob.items[0].updatedPages, ['wiki/notes/updated.md'], '任务摘要可区分已更新')

  ingest.distill = async () => ['wiki/notes/created.md']
  await writeFile(join(sourceDir, '新增示例.txt'), '这是第二份原件正文，也超过二十个字符以便通过质量判定。')
  const createdJob = await settle(ingest, kb, await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }))
  assert.equal(createdJob.items[0].stage, 'done', createdJob.items[0].error)
  assert.deepEqual(createdJob.items[0].pages, ['wiki/notes/created.md'])
  assert.equal(createdJob.items[0].updatedPages, undefined, '纯新增任务不标记为更新')
})

test('a model answer that is not a usable page is rejected without writing', async t => {
  const { provider, kb, workspaceRoot } = await fixture(t)
  await mkdir(join(workspaceRoot, 'raw'), { recursive: true })
  await writeFile(join(workspaceRoot, 'raw', 'c.md'), '正文')
  for (const bad of [{ title: '', body: 'x' }, { title: 'x', body: '' }, { title: 'x', body: 'y', targetPageId: 'missing' }]) {
    const distill = createWikiDistiller(provider.wiki, modelReturning(bad))
    await assert.rejects(() => distill(kb, itemFor('e'.repeat(64), join(workspaceRoot, 'raw', 'c.md')), settings, 'op-bad-' + JSON.stringify(bad).length, signal()))
  }
  assert.equal((await provider.wiki.store(kb).manifest()).pages.length, 0)
})
