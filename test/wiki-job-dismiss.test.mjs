import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'

const PYTHON = process.env.DSH_TEST_PYTHON || (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  : 'python3')

const settings = { python: PYTHON, provider: 'p', model: 'm', allowModel: true, scope: { kind: 'global' } }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-jobs-'))
  const provider = new LocalKnowledgeProvider(join(root, 'db.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'work')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: '任务', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  const ingest = provider.wiki.ingest
  ingest.modelFor = () => async () => { throw new Error('model must not be called') }
  ingest.distill = async () => []
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { provider, ingest, kb: base.id, sourceDir, dbPath: join(root, 'db.sqlite'), root }
}

async function settle(ingest, kb, id) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = ingest.jobs(kb, true).find(item => item.id === id)
    if (job && !ingest.running(kb)) return job
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('job did not settle: ' + id)
}

/** A finished job without extraction: register-only formats are recorded in place. */
async function doneJob(f, name = '视频.mp4') {
  await writeFile(join(f.sourceDir, name), Buffer.from([1, 2, 3, 4]))
  const job = await f.ingest.start(f.kb, settings)
  await settle(f.ingest, f.kb, job.id)
  return f.ingest.jobs(f.kb, true).find(item => item.id === job.id)
}

/** A job blocked inside the model call; aborting it rejects the call like a real model would. */
async function blockedJob(f, name = '阻塞.txt') {
  let entered, release
  const waiting = new Promise(resolve => { entered = resolve })
  let calls = 0
  f.ingest.modelFor = () => async (_prompt, _input, signal) => {
    calls += 1
    entered()
    await new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return { category: '资料', confidence: 0.99 }
  }
  await writeFile(join(f.sourceDir, name), '阻塞资料正文，超过二十个字符以满足抽取质量判定要求。')
  const job = await f.ingest.start(f.kb, settings)
  await waiting
  return { job, release, calls: () => calls }
}

test('cancelling hides the job, clears transient activity and forbids resume or classify', async t => {
  const f = await fixture(t)
  const blocked = await blockedJob(f)
  assert.ok(f.ingest.jobs(f.kb).some(job => job.id === blocked.job.id), 'a running job is visible')

  f.ingest.cancel(f.kb, blocked.job.id)
  const audit = await settle(f.ingest, f.kb, blocked.job.id)

  assert.equal(audit.state, 'cancelled')
  assert.equal(audit.hidden, true, 'a cancelled job leaves the default list')
  assert.ok(audit.items.some(item => item.stage !== 'done'), 'stages stay for audit')
  assert.ok(audit.items.filter(item => item.stage !== 'done').every(item => item.activity === undefined), 'transient activity is cleared')
  assert.ok(!f.ingest.jobs(f.kb).some(job => job.id === blocked.job.id), 'jobs() excludes the cancelled job')
  const callsBefore = blocked.calls()
  assert.throws(() => f.ingest.resume(f.kb, blocked.job.id), error => error.message === 'WIKI_JOB_CANCELLED' && error.code === 'WIKI_JOB_CANCELLED')
  assert.throws(() => f.ingest.classify(f.kb, blocked.job.id, audit.items[0].id, '分类'), /WIKI_JOB_CANCELLED/)
  assert.equal(blocked.calls(), callsBefore, 'refusing resume never calls the model')
  assert.equal(f.ingest.jobs(f.kb, true).length, 1, 'no replacement job is created')
})

test('dismiss hides finished jobs and includeHidden keeps them for audit', async t => {
  const f = await fixture(t)
  const done = await doneJob(f)
  assert.ok(f.ingest.jobs(f.kb).some(job => job.id === done.id))

  const dismissed = f.ingest.dismiss(f.kb, done.id)
  assert.equal(dismissed.hidden, true)
  assert.ok(!f.ingest.jobs(f.kb).some(job => job.id === done.id), 'dismissed jobs leave the default list')
  assert.ok(f.ingest.jobs(f.kb, true).some(job => job.id === done.id), 'includeHidden keeps them for diagnostics')
  assert.equal(f.ingest.jobs(f.kb, true).find(job => job.id === done.id).state, 'done', 'hiding changes no state')
})

test('a running job cannot be dismissed', async t => {
  const f = await fixture(t)
  const blocked = await blockedJob(f)
  assert.throws(() => f.ingest.dismiss(f.kb, blocked.job.id), error => error.message === 'WIKI_JOB_RUNNING' && error.code === 'WIKI_JOB_RUNNING')
  f.ingest.cancel(f.kb, blocked.job.id)
  await settle(f.ingest, f.kb, blocked.job.id)
})

test('dismiss-finished hides only done and cancelled jobs', async t => {
  const f = await fixture(t)
  const done = await doneJob(f, '完成.mp4')
  // A paused job waiting for a manual category must stay visible.
  f.ingest.modelFor = () => async () => ({ category: '不确定分类', confidence: 0.2 })
  await writeFile(join(f.sourceDir, '等待分类.txt'), '等待人工分类的资料正文，超过二十个字符以满足抽取质量判定要求。')
  const paused = await f.ingest.start(f.kb, settings)
  await settle(f.ingest, f.kb, paused.id)
  assert.equal(f.ingest.jobs(f.kb, true).find(job => job.id === paused.id).state, 'paused')

  assert.equal(f.ingest.dismissFinished(f.kb), 1, 'only the done job is newly hidden')
  assert.ok(!f.ingest.jobs(f.kb).some(job => job.id === done.id))
  assert.ok(f.ingest.jobs(f.kb).some(job => job.id === paused.id), 'paused work stays visible')
  assert.equal(f.ingest.dismissFinished(f.kb), 0, 'already hidden jobs are not counted twice')
})

test('resuming a done job keeps its existing behaviour', async t => {
  const f = await fixture(t)
  const done = await doneJob(f)
  const resumed = f.ingest.resume(f.kb, done.id)
  assert.equal(resumed.id, done.id)
  const settled = await settle(f.ingest, f.kb, done.id)
  assert.equal(settled.state, 'done')
  assert.ok(f.ingest.jobs(f.kb).some(job => job.id === done.id), 'a done job stays listed')
})

test('the management API exposes includeHidden, dismiss and dismiss-finished', async t => {
  const f = await fixture(t)
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } } }, f.provider, '/test', { authMode: 'same-origin' })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const endpoint = `http://127.0.0.1:${server.address().port}/test/wiki/${f.kb}`
  const headers = { 'x-dsh-knowledge-client': 'management-web', 'content-type': 'application/json' }
  const done = await doneJob(f, '接口.mp4')

  const listed = await (await fetch(endpoint + '/jobs', { headers })).json()
  assert.ok(listed.some(job => job.id === done.id))
  const dismissed = await fetch(endpoint + '/job/' + done.id, { method: 'POST', headers, body: JSON.stringify({ action: 'dismiss' }) })
  assert.equal(dismissed.status, 200)
  assert.ok(!(await (await fetch(endpoint + '/jobs', { headers })).json()).some(job => job.id === done.id), 'GET jobs hides dismissed tasks')
  const all = await (await fetch(endpoint + '/jobs?includeHidden=true', { headers })).json()
  assert.ok(all.some(job => job.id === done.id && job.hidden === true), 'includeHidden shows the audit record')

  const blocked = await blockedJob(f, '接口取消.txt')
  f.ingest.cancel(f.kb, blocked.job.id)
  await settle(f.ingest, f.kb, blocked.job.id)
  const resume = await fetch(endpoint + '/job/' + blocked.job.id, { method: 'POST', headers, body: JSON.stringify({ action: 'resume' }) })
  assert.equal(resume.status, 400)
  assert.match((await resume.json()).error, /WIKI_JOB_CANCELLED/)

  const cleared = await (await fetch(endpoint + '/job', { method: 'POST', headers, body: JSON.stringify({ action: 'dismiss-finished' }) })).json()
  assert.equal(typeof cleared.hidden, 'number')

  seedJobs(f.dbPath, f.kb, 60, 'audit')
  assert.equal((await (await fetch(endpoint + '/jobs', { headers })).json()).length, 50, 'the default list stays capped')
  const audited = await (await fetch(endpoint + '/jobs?includeHidden=true', { headers })).json()
  assert.equal(audited.length, 62, 'includeHidden audits every record, beyond the display window')
})

/** A second configured base so the global one-at-a-time rule has somewhere to go. */
async function secondBase(provider, root) {
  const sourceDir = join(root, 'second-source'), workspaceRoot = join(root, 'second-work')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: '第二库', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  return base.id
}

/** Lightweight persisted rows: proves the display window without running dozens of real jobs. */
function seedJobs(dbPath, kbId, count, prefix = 'seed', state = 'done') {
  const db = new DatabaseSync(dbPath)
  try {
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO wiki_ingest_jobs(id,kb_id,body) VALUES(?,?,?)')
    for (let index = 0; index < count; index++) {
      const id = `${prefix}-${index}`
      insert.run(id, kbId, JSON.stringify({ id, kbId, state, settings, items: [], createdAt: now, updatedAt: now }))
    }
  } finally {
    db.close()
  }
}

test('another base cannot start while one base is processing', async t => {
  const f = await fixture(t)
  const second = await secondBase(f.provider, f.root)
  const blocked = await blockedJob(f)
  const reused = await f.ingest.start(f.kb, settings)
  assert.equal(reused.id, blocked.job.id, 'the same base still reuses its running job')
  assert.throws(() => f.ingest.cancel('missing-kb', blocked.job.id), /WIKI_JOB_NOT_FOUND/)
  assert.equal(f.ingest.running(f.kb)?.id, blocked.job.id, 'a wrong-base cancel must not stop the live job')

  await assert.rejects(
    () => f.ingest.start(second, settings),
    error => {
      assert.equal(error.code, 'WIKI_JOB_RUNNING_ELSEWHERE')
      assert.ok(error.message.includes(blocked.job.id), 'the running job is named in the refusal')
      assert.match(error.message, /正在处理/)
      return true
    },
  )

  f.ingest.cancel(f.kb, blocked.job.id)
  await settle(f.ingest, f.kb, blocked.job.id)
  const started = await f.ingest.start(second, settings)
  await settle(f.ingest, second, started.id)
})

test('a job outside the display window is still reachable by id and dismissible', async t => {
  const f = await fixture(t)
  const done = await doneJob(f)
  seedJobs(f.dbPath, f.kb, 60)

  const visible = f.ingest.jobs(f.kb)
  assert.equal(visible.length, 50, 'the display list stays capped')
  assert.ok(!visible.some(job => job.id === done.id), 'the real job fell outside the display window')

  const dismissed = f.ingest.dismiss(f.kb, done.id)
  assert.equal(dismissed.id, done.id)
  assert.equal(dismissed.hidden, true)
})

test('dismiss-finished clears finished jobs beyond the display window too', async t => {
  const f = await fixture(t)
  await doneJob(f)
  seedJobs(f.dbPath, f.kb, 60)
  assert.equal(f.ingest.jobs(f.kb).length, 50)

  assert.equal(f.ingest.dismissFinished(f.kb), 61, 'every finished row is hidden, not just the visible 50')
  assert.equal(f.ingest.dismissFinished(f.kb), 0)
})

test('resuming a paused job is refused while another base is processing', async t => {
  const f = await fixture(t)
  const second = await secondBase(f.provider, f.root)
  seedJobs(f.dbPath, second, 1, 'paused', 'paused')
  const blocked = await blockedJob(f)

  assert.throws(
    () => f.ingest.resume(second, 'paused-0'),
    error => {
      assert.equal(error.code, 'WIKI_JOB_RUNNING_ELSEWHERE')
      assert.ok(error.message.includes(blocked.job.id), 'the running job is named in the refusal')
      return true
    },
  )
  assert.equal(f.ingest.jobs(second, true).find(job => job.id === 'paused-0')?.state, 'paused', 'the refused job is not launched')
  f.ingest.cancel(f.kb, blocked.job.id)
  await settle(f.ingest, f.kb, blocked.job.id)
})

test('audit reads can return every record instead of the display window', async t => {
  const f = await fixture(t)
  await doneJob(f)
  seedJobs(f.dbPath, f.kb, 60)

  assert.equal(f.ingest.jobs(f.kb).length, 50, 'the default display keeps its cap')
  assert.equal(f.ingest.jobs(f.kb, true).length, 50, 'a default audit call keeps the default cap')
  assert.equal(f.ingest.jobs(f.kb, true, 0).length, 61, 'limit 0 means unlimited for audit')
})
