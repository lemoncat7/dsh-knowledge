import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, unlink, truncate } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const PYTHON = process.env.DSH_TEST_PYTHON || (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  : 'python3')

const oversized = 257 * 1024 * 1024
async function bigFile(path, size = oversized) {
  await writeFile(path, Buffer.alloc(64, 7))
  await truncate(path, size)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-changes-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'archive'), workspaceRoot = join(root, 'ws')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  await writeFile(join(workspaceRoot, 'schema.md'), '# 约定\n\n一素材一页。\n')
  const base = await provider.createKnowledgeBase({ name: '变化检测', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return { provider, kb: base.id, sourceDir, workspaceRoot }
}

async function settle(ingest, kb, job) {
  for (let i = 0; i < 200; i++) {
    if (ingest.jobs(kb).find(j => j.id === job.id).state !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  return ingest.jobs(kb).find(j => j.id === job.id)
}

/** Every source file's size, mtime and sha, keyed by source-relative path. */
async function snapshot(root) {
  const result = {}
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const info = await stat(path)
        result[relative(root, path).replaceAll('\\', '/')] = { size: info.size, mtimeMs: info.mtimeMs, sha: createHash('sha256').update(await readFile(path)).digest('hex') }
      }
    }
  }
  await walk(root)
  return result
}

/** Run the real pipeline once so receipts and the archive ledger exist. */
async function archiveBaseline(f) {
  const ingest = f.provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '01_资料', confidence: 0.95 })
  ingest.distill = async () => []
  await writeFile(join(f.sourceDir, '甲.txt'), '甲资料正文，超过二十个字符以满足抽取质量判定要求。')
  await writeFile(join(f.sourceDir, '乙.txt'), '乙资料正文，超过二十个字符以满足抽取质量判定要求。')
  const job = await ingest.start(f.kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  const done = await settle(ingest, f.kb, job)
  assert.deepEqual(done.items.map(item => item.stage), ['done', 'done'], done.items.map(item => item.error).join(' | '))
  return ingest
}

test('new source files and delivery folders are reported without touching any file', async t => {
  const f = await fixture(t)
  await writeFile(join(f.sourceDir, '根层新增.txt'), '根层新增正文，超过二十个字符。')
  await mkdir(join(f.sourceDir, '新投递', '子目录'), { recursive: true })
  await writeFile(join(f.sourceDir, '新投递', '甲.txt'), '甲正文，超过二十个字符。')
  await writeFile(join(f.sourceDir, '新投递', '子目录', '乙.txt'), '乙正文，超过二十个字符。')
  const before = await snapshot(f.sourceDir)

  const report = await f.provider.wiki.ingest.changes(f.kb)

  assert.deepEqual(await snapshot(f.sourceDir), before, 'change detection must not modify source files')
  assert.deepEqual(report.new.map(entry => [entry.folder, entry.relPath]).sort(),
    [[undefined, '根层新增.txt'], ['新投递', '新投递/甲.txt'], ['新投递', '新投递/子目录/乙.txt']].sort())
  assert.ok(report.new.every(entry => entry.name && entry.size > 0))
  assert.deepEqual(report.changed, [])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.skipped, [], 'nothing is skipped in a normal round')
  assert.equal(report.skippedRound, undefined)
  assert.match(report.scannedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('an externally changed archive record is reported as changed and never repaired or rewritten', async t => {
  const f = await fixture(t)
  const ingest = await archiveBaseline(f)
  const quiet = await ingest.changes(f.kb)
  assert.deepEqual([quiet.new, quiet.changed, quiet.missing, quiet.skipped], [[], [], [], []], 'unchanged library has no findings')

  const archived = join(f.sourceDir, '01_资料', '甲.txt')
  const original = await readFile(archived, 'utf8')
  await writeFile(archived, original + '外部追改内容')
  const report = await ingest.changes(f.kb)

  assert.deepEqual(report.changed.map(entry => entry.relPath), ['01_资料/甲.txt'])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.new, [])
  assert.equal(await readFile(archived, 'utf8'), original + '外部追改内容', 'the check never rewrites archives')
  assert.deepEqual(ingest.changeReport(f.kb).changed, report.changed, 'the report is persisted for the interface')
})

test('a deleted archive record is reported as missing and nothing is recreated', async t => {
  const f = await fixture(t)
  const ingest = await archiveBaseline(f)
  const archived = join(f.sourceDir, '01_资料', '乙.txt')
  await unlink(archived)

  const report = await ingest.changes(f.kb)

  assert.deepEqual(report.missing.map(entry => entry.relPath), ['01_资料/乙.txt'])
  await assert.rejects(() => stat(archived), /ENOENT/)
  assert.deepEqual(await readdir(join(f.sourceDir, '01_资料')), ['甲.txt'])
  assert.deepEqual(report.changed, [])
  assert.deepEqual(report.new, [])
})

test('root inventory manifests are archive evidence for changed and missing records', async t => {
  const f = await fixture(t)
  await mkdir(join(f.sourceDir, '01_资料'), { recursive: true })
  const content = '在册内容'
  await writeFile(join(f.sourceDir, '01_资料', '在册.txt'), content)
  const sameSize = 'ABCD'
  await writeFile(join(f.sourceDir, '01_资料', '同尺寸.txt'), sameSize)
  const sha = createHash('sha256').update(content).digest('hex')
  const drifted = createHash('sha256').update('EFGH').digest('hex')
  await writeFile(join(f.sourceDir, '归档清单.csv'),
    'id,category_dir,archive_file,archive_rel_path,size_bytes,sha256\r\n'
    + `1,"01_资料","在册.txt","01_资料\\在册.txt",${Buffer.byteLength(content)},"${sha}"\r\n`
    + `2,"01_资料","缺失.txt","01_资料\\缺失.txt",6,"${'0'.repeat(64)}"\r\n`
    + `3,"01_资料","同尺寸.txt","01_资料\\同尺寸.txt",${Buffer.byteLength(sameSize)},"${drifted}"\r\n`)

  const report = await f.provider.wiki.ingest.changes(f.kb)

  assert.deepEqual(report.missing.map(entry => entry.relPath), ['01_资料/缺失.txt'])
  assert.deepEqual(report.changed.map(entry => entry.relPath), ['01_资料/同尺寸.txt'], 'same-size edits are caught by the recorded hash')
  assert.deepEqual(report.new, [], 'the manifest itself and recorded files are not new work')
})

test('a running ingest job skips the change round', async t => {
  const f = await fixture(t)
  const ingest = f.provider.wiki.ingest
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  ingest.modelFor = () => async () => { entered(); await new Promise(resolve => { release = resolve }); return { category: '01_资料', confidence: 0.99 } }
  ingest.distill = async () => []
  await writeFile(join(f.sourceDir, '阻塞.txt'), '阻塞资料正文，超过二十个字符以满足抽取质量判定要求。')
  const job = await ingest.start(f.kb, { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } })
  await waiting

  const report = await ingest.changes(f.kb)
  assert.equal(report.skippedRound, true)
  assert.equal(report.reason, 'job-running')
  assert.deepEqual([report.new, report.changed, report.missing, report.skipped], [[], [], [], []])

  release()
  await settle(ingest, f.kb, job)
})

test('files the scan skips are reported by changes() instead of looking clean', async t => {
  const f = await fixture(t)
  await bigFile(join(f.sourceDir, '超大扫描件.pdf'))

  const report = await f.provider.wiki.ingest.changes(f.kb)

  assert.deepEqual(report.new, [], 'an oversized extractable file is never queued as new')
  assert.equal(report.skipped.length, 1)
  assert.equal(report.skipped[0].name, '超大扫描件.pdf')
  assert.equal(report.skipped[0].size, oversized)
  assert.equal(report.skipped[0].relPath, '超大扫描件.pdf')
  assert.match(report.skipped[0].reason, /256 MB/)
  assert.deepEqual([report.changed, report.missing], [[], []])
  assert.deepEqual(f.provider.wiki.ingest.changeReport(f.kb).skipped, report.skipped, 'the skipped list is persisted too')
})
