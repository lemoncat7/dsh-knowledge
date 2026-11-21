import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
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

test('one job classifies, archives without renaming, extracts and records sources', async t => {
  const { provider, kb, sourceDir, workspaceRoot } = await fixture(t)
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => ({ category: '01_产品说明书', confidence: 0.93 })
  const distillerCalls = []
  ingest.distill = async (_kb, item) => { distillerCalls.push(item.sha); return ['wiki/notes/x.md'] }

  await mkdir(join(sourceDir, '01_产品说明书'), { recursive: true })
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
  await mkdir(join(sourceDir, '01_产品说明书'), { recursive: true })
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
