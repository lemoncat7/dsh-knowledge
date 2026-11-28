import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const PYTHON = process.env.DSH_TEST_PYTHON || (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  : 'python3')

const settings = { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-standalone-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'work')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  await writeFile(join(workspaceRoot, 'schema.md'), '# 约定\n\n一素材一页。\n')
  const base = await provider.createKnowledgeBase({ name: '不归档库', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  return { provider, ingest: provider.wiki.ingest, kb: base.id, sourceDir, workspaceRoot }
}

async function settle(ingest, kb, id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = ingest.jobs(kb, true).find(item => item.id === id)
    if (job !== undefined && job.state !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('job did not settle: ' + id)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** python-docx builds a real DOCX so the extractor takes the normal document path. */
async function writeDocx(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const script = [
    'import docx',
    'document = docx.Document()',
    `document.add_paragraph(${JSON.stringify(text)})`,
    `document.save(${JSON.stringify(path)})`,
    '',
  ].join('\n')
  const file = join(tmpdir(), 'dsh-make-docx-' + Math.random().toString(16).slice(2) + '.py')
  await writeFile(file, script, 'utf8')
  await new Promise((resolve, reject) => execFile(PYTHON, [file], { windowsHide: true }, error => error === null ? resolve() : reject(error)))
}

async function receiptOf(workspaceRoot, sha) {
  const path = join(workspaceRoot, '_meta', 'knowledge', 'sources', sha + '.json')
  return JSON.parse(await readFile(path, 'utf8'))
}

function stubDistiller(ingest) {
  const distilled = []
  let modelCalls = 0
  ingest.modelFor = () => async () => { modelCalls++; return { category: '01_资料', confidence: 0.93 } }
  ingest.distill = async (_kb, item) => { distilled.push(item); return ['wiki/notes/x.md'] }
  return { distilled, modelCalls: () => modelCalls }
}

test('a delivery folder with a no-split notice is extracted in place and never archived', async t => {
  const f = await fixture(t)
  const { distilled, modelCalls } = stubDistiller(f.ingest)
  const original = '这是不归档投递夹中的原始资料正文，内容足够长以满足抽取质量判定。'
  const docx = join(f.sourceDir, '外部汇图ai', '原始资料.docx')
  await mkdir(join(f.sourceDir, '外部汇图ai'), { recursive: true })
  await writeDocx(docx, original)
  await writeFile(join(f.sourceDir, '外部汇图ai', '说明.txt'), '本文件夹内容不拆分，请单独分类处理。')
  const before = await sha256(docx)

  const beforeChanges = await f.ingest.changes(f.kb)
  assert.equal(beforeChanges.new.length, 1, 'a standalone file is reported as new before processing')
  assert.equal(beforeChanges.new[0].folder, '外部汇图ai')

  const job = await f.ingest.start(f.kb, settings)
  assert.equal(job.items.length, 1, 'the notice file itself is never a source candidate')
  assert.equal(job.items[0].standalone, true)
  assert.match(job.items[0].standaloneReason, /不拆分/)
  const done = await settle(f.ingest, f.kb, job.id)
  const item = done.items[0]
  assert.equal(item.stage, 'done', item.error)
  assert.equal(modelCalls(), 0, 'standalone files skip model classification')
  assert.equal(item.category, '外部汇图ai')
  assert.equal(item.standalone, true)
  assert.equal(item.inPlace, true)
  assert.equal(item.archived, docx)
  assert.ok(item.raw, 'the extracted raw markdown is recorded')
  assert.deepEqual(item.pages, ['wiki/notes/x.md'])
  assert.equal(distilled.length, 1)

  // The original stays byte-identical where it was; nothing is copied into a category or logged in CSV.
  assert.equal(await sha256(docx), before)
  assert.deepEqual(await readdir(f.sourceDir), ['外部汇图ai'])
  assert.deepEqual((await readdir(join(f.sourceDir, '外部汇图ai'))).sort(), ['原始资料.docx', '说明.txt'].sort())
  assert.equal((await readdir(join(f.workspaceRoot, 'raw'))).filter(name => name.endsWith('.md')).length, 1)
  assert.equal(await readFile(join(f.sourceDir, 'knowledge-archive.csv'), 'utf8').catch(() => undefined), undefined, 'standalone items never write archive CSV rows')

  const receipt = await receiptOf(f.workspaceRoot, item.sha)
  assert.equal(receipt.stage, 'done')
  assert.equal(receipt.standalone, true)
  assert.equal(receipt.inPlace, true)
  assert.equal(receipt.archived, docx)

  // A repeated scan sees the same sha and does not queue it again.
  const rescan = await f.ingest.scanSources(f.kb)
  assert.equal(rescan.files.length, 1)
  assert.equal(rescan.files[0].duplicate, true)
  assert.deepEqual(rescan.standaloneFolders.map(entry => entry.folder), ['外部汇图ai'])
  const afterChanges = await f.ingest.changes(f.kb)
  assert.deepEqual(afterChanges.new, [], 'the receipt sha deduplicates a processed standalone file')
  assert.deepEqual([afterChanges.changed, afterChanges.missing], [[], []], 'an untouched in-place file is neither changed nor missing')
  const again = await f.ingest.start(f.kb, settings)
  assert.equal(again.items.length, 0, 'already-processed standalone content is not queued twice')
})

test('a folder whose name says no-archive is handled standalone without a notice file', async t => {
  const f = await fixture(t)
  const { modelCalls } = stubDistiller(f.ingest)
  const docx = join(f.sourceDir, '不归档资料', '现场记录.docx')
  await writeDocx(docx, '文件夹名声明不归档时的原始资料正文，内容足够长以满足抽取质量判定。')
  const before = await sha256(docx)

  const job = await f.ingest.start(f.kb, settings)
  const done = await settle(f.ingest, f.kb, job.id)
  const item = done.items[0]
  assert.equal(item.stage, 'done', item.error)
  assert.equal(item.standalone, true)
  assert.match(item.standaloneReason, /不归档/)
  assert.equal(item.category, '不归档资料')
  assert.equal(modelCalls(), 0)
  assert.equal(await sha256(docx), before)
  assert.deepEqual(await readdir(f.sourceDir), ['不归档资料'])
  assert.equal(await readFile(join(f.sourceDir, 'knowledge-archive.csv'), 'utf8').catch(() => undefined), undefined)
  assert.equal((await receiptOf(f.workspaceRoot, item.sha)).inPlace, true)
})

test('an ordinary delivery folder still files its content into a category', async t => {
  const f = await fixture(t)
  const { modelCalls } = stubDistiller(f.ingest)
  const original = join(f.sourceDir, '普通投递', '说明资料.txt')
  await mkdir(dirname(original), { recursive: true })
  await writeFile(original, '普通投递夹里的资料正文，超过二十个字符以满足抽取质量判定要求。')

  const job = await f.ingest.start(f.kb, settings)
  const done = await settle(f.ingest, f.kb, job.id)
  const item = done.items[0]
  assert.equal(item.stage, 'done', item.error)
  assert.equal(item.standalone, undefined)
  assert.equal(modelCalls(), 1, 'ordinary deliveries keep model classification')
  const archived = join(f.sourceDir, '01_资料', '普通投递', '说明资料.txt')
  assert.equal(item.archived, archived)
  assert.ok((await stat(archived)).isFile())
  await assert.rejects(() => readFile(original), /ENOENT/)
  assert.match(await readFile(join(f.sourceDir, 'knowledge-archive.csv'), 'utf8'), /普通投递/)
})

test('register-only files in a standalone folder carry the delivery ownership fields', async t => {
  const f = await fixture(t)
  const { distilled, modelCalls } = stubDistiller(f.ingest)
  const folder = join(f.sourceDir, '外部汇图ai')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, '说明.txt'), '本目录不归档，请单独处理。')
  const zip = join(folder, '资料包.zip')
  const video = join(folder, '演示.mp4')
  await writeFile(zip, Buffer.from('PK\u0003\u0004 stand-in archive'))
  await writeFile(video, Buffer.alloc(2048, 3))
  const before = { zip: await sha256(zip), video: await sha256(video) }

  const job = await f.ingest.start(f.kb, settings)
  assert.equal(job.items.length, 2)
  const done = await settle(f.ingest, f.kb, job.id)
  for (const item of done.items) {
    assert.equal(item.stage, 'done', item.error)
    assert.equal(item.standalone, true)
    assert.equal(item.registered, true)
    assert.equal(item.inPlace, true)
    assert.equal(item.category, '外部汇图ai', 'a register-only standalone file names its delivery folder')
    assert.equal(item.archived, item.source, 'the archive path is the original source path')
    const receipt = await receiptOf(f.workspaceRoot, item.sha)
    assert.equal(receipt.category, '外部汇图ai')
    assert.equal(receipt.archived, item.source)
    assert.equal(receipt.inPlace, true)
  }
  assert.equal(modelCalls(), 0)
  assert.equal(distilled.length, 0, 'register-only formats never extract or distill')
  assert.equal(await sha256(zip), before.zip)
  assert.equal(await sha256(video), before.video)
  assert.deepEqual((await readdir(folder)).sort(), ['说明.txt', '演示.mp4', '资料包.zip'].sort())
  assert.equal(await readFile(join(f.sourceDir, 'knowledge-archive.csv'), 'utf8').catch(() => undefined), undefined)
})

test('register-only files in an ordinary delivery keep the existing register-in-place behaviour', async t => {
  const f = await fixture(t)
  const { modelCalls } = stubDistiller(f.ingest)
  const zip = join(f.sourceDir, '普通投递', '资料包.zip')
  await mkdir(dirname(zip), { recursive: true })
  await writeFile(zip, Buffer.from('PK\u0003\u0004 stand-in archive'))
  const before = await sha256(zip)

  const job = await f.ingest.start(f.kb, settings)
  const done = await settle(f.ingest, f.kb, job.id)
  const item = done.items[0]
  assert.equal(item.stage, 'done', item.error)
  assert.equal(item.registered, true)
  assert.equal(item.inPlace, true)
  assert.equal(item.standalone, undefined)
  assert.equal(item.category, undefined, 'ordinary register-only files keep no category')
  assert.equal(item.archived, undefined, 'ordinary register-only files keep no archive path')
  assert.equal(await sha256(zip), before)
  assert.deepEqual(await readdir(join(f.sourceDir, '普通投递')), ['资料包.zip'])
  assert.equal(await readFile(join(f.sourceDir, 'knowledge-archive.csv'), 'utf8').catch(() => undefined), undefined)
  assert.equal(modelCalls(), 0)
})
