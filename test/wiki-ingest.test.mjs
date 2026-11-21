import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, truncate, stat, rename } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const PYTHON = process.env.DSH_TEST_PYTHON || (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  : 'python3')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-ingest-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'archive'), workspaceRoot = join(root, 'ws')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  await writeFile(join(workspaceRoot, 'schema.md'), '# 高素库约定\n\n一素材一页；矛盾显式标注。\n')
  const base = await provider.createKnowledgeBase({ name: 'Wiki', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return { provider, kb: base.id, sourceDir, workspaceRoot, root }
}

/** Archive results are recorded by the library's own manifest: those categories are baseline, never deliveries. */
async function seedArchiveCategory(sourceDir, category) {
  await mkdir(join(sourceDir, category), { recursive: true })
  const manifest = join(sourceDir, '归档清单.csv')
  const rows = 'id,category_dir,archive_file,archive_rel_path,size_bytes,sha256\r\n'
    + `1,"${category}","旧资料.txt","${category}\\旧资料.txt",0,"${'0'.repeat(64)}"\r\n`
  await writeFile(manifest, rows)
}

async function settle(ingest, kb, job, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (ingest.jobs(kb).find(j => j.id === job.id).state !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  return ingest.jobs(kb).find(j => j.id === job.id)
}

const oversized = 257 * 1024 * 1024
/** Oversized file without holding hundreds of MB in memory: small write, then extend the size. */
async function bigFile(path, size = oversized) {
  await writeFile(path, Buffer.alloc(64, 7))
  await truncate(path, size)
}

/** Streamed sha for large test files. */
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

test('one job classifies, archives without renaming, extracts and records sources', async t => {
  const { provider, kb, sourceDir, workspaceRoot } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '01_产品说明书', confidence: 0.93 })
  const distillerCalls = []
  ingest.distill = async (_kb, item) => { distillerCalls.push(item.sha); return ['wiki/notes/x.md'] }

  await seedArchiveCategory(sourceDir, '01_产品说明书')
  const original = '这是原件正文，含二十个以上字符以满足 full 质量判定。'
  await writeFile(join(sourceDir, '示例说明.txt'), original)

  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  assert.equal(job.items.length, 1)
  // Wait for the background job to settle.
  for (let i = 0; i < 100; i++) {
    const current = ingest.jobs(kb).find(j => j.id === job.id)
    if (current.state !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  const done = ingest.jobs(kb).find(j => j.id === job.id)
  assert.equal(done.items[0].stage, 'done', done.items[0].error)
  assert.equal(done.state, 'done')

  // Original basename preserved inside the category folder; root copy retired.
  const archived = join(sourceDir, '01_产品说明书', '示例说明.txt')
  assert.equal(await readFile(archived, 'utf8'), original)
  assert.deepEqual((await readdir(sourceDir)).filter(n => n === '示例说明.txt'), [])

  const rawDir = join(workspaceRoot, 'raw')
  const rawFiles = await readdir(rawDir)
  assert.equal(rawFiles.length, 1)
  assert.match(rawFiles[0], /^示例说明\.txt--[a-f0-9]{16}\.md$/)
  const raw = await readFile(join(rawDir, rawFiles[0]), 'utf8')
  assert.match(raw, /source_file:/)
  assert.match(raw, /含二十个以上字符/)

  assert.deepEqual(distillerCalls.length, 1)
  const csv = await readFile(join(sourceDir, 'knowledge-archive.csv'), 'utf8')
  assert.match(csv, /^operation_id,sha256/m)
  assert.match(csv, /01_产品说明书/)

  // Second run must not reprocess the same bytes.
  const again = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  assert.equal(again.items.length, 0, 'already processed source must not be queued again')
})

test('low confidence stops only that item and stays resumable', async t => {
  const { provider, kb, sourceDir } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '不确定类别', confidence: 0.2 })
  ingest.distill = async () => []
  await writeFile(join(sourceDir, '模糊.txt'), '内容不足以判断分类，需要人工。')
  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  for (let i = 0; i < 80; i++) {
    if (ingest.jobs(kb).find(j => j.id === job.id).state !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  const settled = ingest.jobs(kb).find(j => j.id === job.id)
  assert.equal(settled.items[0].stage, 'review')
  // Manual category resumes the same item instead of re-classifying.
  const resumed = ingest.classify(kb, job.id, settled.items[0].id, '人工分类')
  assert.ok(resumed)
  for (let i = 0; i < 100; i++) {
    if (ingest.jobs(kb).find(j => j.id === job.id).state !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(ingest.jobs(kb).find(j => j.id === job.id).items[0].stage, 'done')
})

test('same basename with different bytes is never overwritten', async t => {
  const { provider, kb, sourceDir } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '01_产品说明书', confidence: 0.95 })
  ingest.distill = async () => []
  await seedArchiveCategory(sourceDir, '01_产品说明书')
  await writeFile(join(sourceDir, '01_产品说明书', '同名.txt'), '已归档的旧内容，不能被覆盖。')
  await writeFile(join(sourceDir, '同名.txt'), '新投递的不同内容。')
  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  for (let i = 0; i < 80; i++) {
    if (ingest.jobs(kb).find(j => j.id === job.id).state !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  const item = ingest.jobs(kb).find(j => j.id === job.id).items[0]
  assert.equal(item.stage, 'failed')
  assert.match(item.error, /WIKI_FILENAME_CONFLICT/)
  assert.equal(await readFile(join(sourceDir, '01_产品说明书', '同名.txt'), 'utf8'), '已归档的旧内容，不能被覆盖。')
  assert.equal(await readFile(join(sourceDir, '同名.txt'), 'utf8'), '新投递的不同内容。')
})

test("job exposes persisted activity while waiting for classification model",async t=>{const {provider,kb,sourceDir}=await fixture(t);let release,entered;const waiting=new Promise(r=>entered=r);provider.wiki.ingest.modelFor=()=>async()=>{entered();await new Promise(r=>release=r);return{category:"说明",confidence:.99}};provider.wiki.ingest.distill=async()=>[];await writeFile(join(sourceDir,"progress.txt"),"这是用于检测模型等待期间可见进度的正常原始文本资料。");const job=await provider.wiki.ingest.start(kb,{python:PYTHON,provider:"p",model:"m",allowModel:true,scope:{kind:"global"}});await waiting;const snapshot=provider.wiki.ingest.jobs(kb).find(j=>j.id===job.id);assert.equal(snapshot.items[0].activity,"正在由模型分类");assert.equal(snapshot.state,"running");release();});

test("catalog and index files at the source root are never treated as source material",async t=>{const {provider,kb,sourceDir}=await fixture(t);provider.wiki.ingest.modelFor=()=>async()=>({category:"说明",confidence:.99});provider.wiki.ingest.distill=async()=>[];for(const name of ["资料索引.md","归档目录树.md","归档清单.csv","README.md","index.md","资料目录.txt"])await writeFile(join(sourceDir,name),"目录文件内容，不应进入蒸馏。");await writeFile(join(sourceDir,"真实原件.txt"),"这是真正的资料正文，超过二十个字符以满足抽取质量判定要求。");const found=await provider.wiki.ingest.discover(kb);assert.deepEqual(found.map(f=>f.source.split(/[\\\\/]/).pop()),["真实原件.txt"]);});

test('a new root-level delivery folder is discovered and archived below the category with its relative layout', async t => {
  const { provider, kb, sourceDir } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '01_产品说明书', confidence: 0.93 })
  const distilled = []
  ingest.distill = async (_kb, item) => { distilled.push(item.relPath); return [] }
  // Established archive categories are read from the library manifest; unrelated root folders are deliveries.
  await seedArchiveCategory(sourceDir, '01_产品说明书')
  await writeFile(join(sourceDir, '01_产品说明书', '旧资料.txt'), '既有归档内容')
  const first = '甲资料正文，超过二十个字符以满足抽取质量判定要求。'
  const second = '乙资料正文，超过二十个字符以满足抽取质量判定要求。'
  await mkdir(join(sourceDir, '外部汇图ai', '说明', '子目录'), { recursive: true })
  await writeFile(join(sourceDir, '外部汇图ai', '说明', '甲.txt'), first)
  await writeFile(join(sourceDir, '外部汇图ai', '说明', '子目录', '乙.txt'), second)

  const found = await ingest.discover(kb)
  assert.deepEqual(found.map(file => [file.delivery, file.relPath]).sort(),
    [['外部汇图ai', '说明/子目录/乙.txt'], ['外部汇图ai', '说明/甲.txt']])
  assert.deepEqual(found.map(file => file.duplicate), [false, false])

  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  assert.equal(job.items.length, 2, 'only the delivery folder is queued; the existing archive category is baseline')
  assert.deepEqual(job.discovery, { found: 2, duplicates: 0 })
  const done = await settle(ingest, kb, job)
  assert.deepEqual(done.items.map(item => item.stage), ['done', 'done'], done.items.map(item => item.error).join(' | '))

  // Archive path keeps <category>/<delivery>/<relative path> and never renames the original.
  assert.equal(await readFile(join(sourceDir, '01_产品说明书', '外部汇图ai', '说明', '甲.txt'), 'utf8'), first)
  assert.equal(await readFile(join(sourceDir, '01_产品说明书', '外部汇图ai', '说明', '子目录', '乙.txt'), 'utf8'), second)
  await assert.rejects(() => readFile(join(sourceDir, '外部汇图ai', '说明', '甲.txt')), /ENOENT/)
  assert.equal(await readFile(join(sourceDir, '01_产品说明书', '旧资料.txt'), 'utf8'), '既有归档内容')
  assert.deepEqual(distilled.sort(), ['说明/子目录/乙.txt', '说明/甲.txt'])

  // Everything already receipted: the next scan has nothing new and never rescans the archive category.
  assert.deepEqual((await ingest.discover(kb)).filter(file => !file.duplicate), [])
})

test('delivery scanning ignores inventory files, hidden entries and reserved folders', async t => {
  const { provider, kb, sourceDir } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '杂项', confidence: 0.99 })
  ingest.distill = async () => []
  await mkdir(join(sourceDir, '投递', '_meta'), { recursive: true })
  await mkdir(join(sourceDir, '投递', '_归档工作区'), { recursive: true })
  await mkdir(join(sourceDir, '投递', '.cache'), { recursive: true })
  await mkdir(join(sourceDir, '投递', '章节'), { recursive: true })
  await mkdir(join(sourceDir, '_暂存'), { recursive: true })
  await writeFile(join(sourceDir, '投递', '真实.txt'), '真实资料正文，超过二十个字符以满足抽取质量判定要求。')
  await writeFile(join(sourceDir, '投递', '章节', '深入.txt'), '章节资料正文，超过二十个字符以满足抽取质量判定要求。')
  for (const name of ['README.md', '资料索引.md', '归档目录树.md', 'index.md']) await writeFile(join(sourceDir, '投递', name), '清单内容，不应作为资料。')
  await writeFile(join(sourceDir, '投递', '.隐藏.txt'), '隐藏文件')
  await writeFile(join(sourceDir, '投递', '_meta', '内部.txt'), '保留目录')
  await writeFile(join(sourceDir, '投递', '_归档工作区', '中间产物.txt'), '团队中间产物')
  await writeFile(join(sourceDir, '投递', '.cache', '缓存.txt'), '隐藏目录')
  await writeFile(join(sourceDir, '_暂存', '暂存.txt'), '下划线目录不是投递')
  const found = await ingest.discover(kb)
  assert.deepEqual(found.map(file => file.relPath).sort(), ['真实.txt', '章节/深入.txt'].sort())
})

test('a delivery file never overwrites archived bytes at the same relative path', async t => {
  const { provider, kb, sourceDir } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '01_产品说明书', confidence: 0.95 })
  ingest.distill = async () => []
  await seedArchiveCategory(sourceDir, '01_产品说明书')
  await mkdir(join(sourceDir, '01_产品说明书', '外部汇图ai', '说明'), { recursive: true })
  await writeFile(join(sourceDir, '01_产品说明书', '外部汇图ai', '说明', '同名.txt'), '已归档的旧内容，不能被覆盖。')
  await mkdir(join(sourceDir, '外部汇图ai', '说明'), { recursive: true })
  await writeFile(join(sourceDir, '外部汇图ai', '说明', '同名.txt'), '新投递的不同内容。')
  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  const settled = await settle(ingest, kb, job)
  assert.equal(settled.items.length, 1)
  assert.equal(settled.items[0].stage, 'failed')
  assert.match(settled.items[0].error, /WIKI_FILENAME_CONFLICT/)
  assert.equal(await readFile(join(sourceDir, '01_产品说明书', '外部汇图ai', '说明', '同名.txt'), 'utf8'), '已归档的旧内容，不能被覆盖。')
  assert.equal(await readFile(join(sourceDir, '外部汇图ai', '说明', '同名.txt'), 'utf8'), '新投递的不同内容。')
})

test('a delivery folder is never filed into itself and stays manually classifiable', async t => {
  const { provider, kb, sourceDir } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '外部汇图ai', confidence: 0.99 })
  ingest.distill = async () => []
  await mkdir(join(sourceDir, '外部汇图ai'), { recursive: true })
  await writeFile(join(sourceDir, '外部汇图ai', '说明.txt'), '投递资料正文，超过二十个字符以满足抽取质量判定要求。')
  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  const settled = await settle(ingest, kb, job)
  assert.equal(settled.items[0].stage, 'review')
  assert.match(settled.items[0].error, /WIKI_CATEGORY_IS_DELIVERY/)
  await assert.rejects(() => readFile(join(sourceDir, '外部汇图ai', '外部汇图ai', '说明.txt')), /ENOENT/)
  // The review item is actionable: a manual category archives it and retires the original.
  const resumed = ingest.classify(kb, job.id, settled.items[0].id, '说明')
  assert.ok(resumed)
  const finished = await settle(ingest, kb, job)
  assert.equal(finished.items[0].stage, 'done', finished.items[0].error)
  assert.equal(await readFile(join(sourceDir, '说明', '外部汇图ai', '说明.txt'), 'utf8'), '投递资料正文，超过二十个字符以满足抽取质量判定要求。')
})

test('a register-only video is recorded in place without copying, extraction or classification', async t => {
  const { provider, kb, sourceDir, workspaceRoot } = await fixture(t)
  const ingest = provider.wiki.ingest
  let modelCalls = 0, distilled = 0
  ingest.modelFor = () => async () => { modelCalls++; return { category: '09_视频教程', confidence: 0.95 } }
  ingest.distill = async () => { distilled++; return [] }
  const video = join(sourceDir, '外部汇图ai', '检测流程', 'VID_超大.mp4')
  await mkdir(join(sourceDir, '外部汇图ai', '检测流程'), { recursive: true })
  await bigFile(video)
  const before = { size: (await stat(video)).size, sha: await sha256(video) }

  const scan = await ingest.scanSources(kb)
  assert.deepEqual(scan.skipped, [], 'register-only formats have no size cap')
  assert.deepEqual(scan.files.map(file => [file.delivery, file.relPath, file.size]),
    [['外部汇图ai', '检测流程/VID_超大.mp4', oversized]])

  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  assert.equal(job.items.length, 1)
  const done = await settle(ingest, kb, job, 600)
  const item = done.items[0]
  assert.equal(item.stage, 'done', item.error)
  assert.equal(item.registered, true, 'the item is marked as registered')
  assert.equal(item.inPlace, true, 'the item is registered where it is, not archived')
  assert.equal(item.activity, '已登记（原位，不搬运）')
  assert.equal(item.raw, undefined, 'no raw markdown is produced')
  assert.equal(item.archived, undefined, 'no archive copy is made')
  assert.equal(modelCalls, 0, 'register-only files never reach the classification model')
  assert.equal(distilled, 0, 'distillation never runs for register-only files')

  // The original stays exactly where it was, with the same bytes; nothing was copied or moved.
  assert.equal((await stat(video)).size, before.size)
  assert.equal(await sha256(video), before.sha)
  assert.deepEqual(await readdir(join(sourceDir, '外部汇图ai', '检测流程')), ['VID_超大.mp4'])
  assert.deepEqual(await readdir(join(workspaceRoot, 'raw')), [])
  assert.deepEqual(await readdir(join(workspaceRoot, '_meta', '待补抽')).catch(() => []), [])
  const receipt = JSON.parse(await readFile(join(workspaceRoot, '_meta', 'knowledge', 'sources', item.sha + '.json'), 'utf8'))
  assert.equal(receipt.registered, true)
  assert.equal(receipt.inPlace, true)
  assert.equal(receipt.stage, 'done')
  assert.equal(receipt.source, video, 'the receipt keeps the original absolute path')
  assert.equal(receipt.size, oversized)
  assert.equal(typeof receipt.discoveredAt, 'string')

  // Repeated scans skip the same sha instead of registering it again.
  const rescan = await ingest.scanSources(kb)
  assert.equal(rescan.files.length, 1)
  assert.equal(rescan.files[0].duplicate, true)
  assert.deepEqual(rescan.skipped, [])
  const again = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  assert.equal(again.items.length, 0)
  assert.deepEqual([(await ingest.changes(kb)).new, (await ingest.changes(kb)).changed, (await ingest.changes(kb)).missing], [[], [], []])

  // Moving the original later is reported as missing; it is not silently registered again.
  const movedPath = join(sourceDir, '外部汇图ai', '检测流程', '改名.mp4')
  await rename(video, movedPath)
  const moved = await ingest.changes(kb)
  assert.deepEqual(moved.missing.map(entry => entry.relPath), ['外部汇图ai/检测流程/VID_超大.mp4'])
  assert.deepEqual(moved.new, [])
  assert.deepEqual(moved.changed, [])
  assert.equal(await sha256(movedPath), before.sha, 'the moved original is untouched')
})

test('an oversized extractable file is skipped with an explicit reason', async t => {
  const { provider, kb, sourceDir } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '说明', confidence: 0.99 })
  ingest.distill = async () => []
  const pdf = join(sourceDir, '超大扫描件.pdf')
  await bigFile(pdf)

  const scan = await ingest.scanSources(kb)
  assert.deepEqual(scan.files, [])
  assert.equal(scan.skipped.length, 1)
  assert.equal(scan.skipped[0].name, '超大扫描件.pdf')
  assert.equal(scan.skipped[0].size, oversized)
  assert.match(scan.skipped[0].reason, /256 MB/)
  assert.deepEqual(await ingest.discover(kb), [], 'the candidate view only lists processable files')

  const job = await ingest.start(kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  assert.equal(job.items.length, 0, 'an oversized extractable file is never queued')
  const settled = await settle(ingest, kb, job)
  assert.equal(settled.state, 'done')
  assert.equal((await stat(pdf)).size, oversized, 'the untouched original stays in place')
})
