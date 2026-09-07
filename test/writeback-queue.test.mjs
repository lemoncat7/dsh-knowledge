import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { WritebackQueue } from '../lib/writeback/queue.js'

const done = { status: 'completed', summary: '已写入', retryable: false }
const work = (session = 'a', turn = 1) => ({ destination: 'local:fixture', snapshot: {
  sourceKey: `${session}:${turn}`, sessionId: session, turn, userText: 'original question',
  userTextTruncated: false, assistantText: 'original result',
} })
async function waitFor(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('condition not met')
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-outbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'queue.sqlite')
}

test('enqueue durably captures a turn without waiting for work or retaining mutable session data', async t => {
  const path = await fixture(t)
  let received, release
  const blocked = new Promise(resolve => { release = resolve })
  const queue = new WritebackQueue(path, async input => { received = input; await blocked; return done })
  t.after(async () => { release(); await queue.close() })
  const input = work()
  assert.equal(queue.enqueue(input).status, 'queued')
  assert.equal(received, undefined)
  input.snapshot.assistantText = 'new turn overwrote this object'
  const disk = new DatabaseSync(path)
  assert.match(disk.prepare('SELECT payload FROM queue_jobs').get().payload, /original result/)
  disk.close()
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await waitFor(() => received)
  assert.equal(received.snapshot.assistantText, 'original result')
  assert.equal(queue.status('a:1').status, 'running')
  release()
  await waitFor(() => queue.status('a:1').status === 'completed')
})

test('failed session head blocks its successors, not other sessions; duplicate retries run once', async t => {
  const path = await fixture(t)
  const calls = []
  let fail = true
  const queue = new WritebackQueue(path, async input => {
    calls.push(input.snapshot.sourceKey)
    if (input.snapshot.sourceKey === 'a:1' && fail) throw new Error('model not configured')
    return done
  })
  t.after(() => queue.close())
  queue.enqueue(work()); queue.enqueue(work('a', 2)); queue.enqueue(work('b'))
  await waitFor(() => queue.status('b:1')?.status === 'completed')
  assert.deepEqual(calls, ['a:1', 'b:1'])
  assert.match(queue.status('a:2').summary, /前一轮/)
  fail = false
  queue.retry('a:1'); queue.retry('a:1'); queue.enqueue(work())
  await waitFor(() => queue.status('a:2').status === 'completed')
  assert.deepEqual(calls, ['a:1', 'b:1', 'a:1', 'a:2'])
  queue.retry('a:1')
  assert.equal(calls.length, 4)
})

test('shutdown preserves work and its exact write plan; reopening resumes without regenerating it', async t => {
  const path = await fixture(t)
  const plan = [{ delivery: 'audit', proposal: { reason: 'frozen plan' } }]
  const first = new WritebackQueue(path, async (_input, checkpoint, signal) => {
    checkpoint.save(plan)
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return done
  })
  first.enqueue(work())
  await waitFor(() => first.isRunning)
  await Promise.all([first.close(), first.close()])
  let seen
  const second = new WritebackQueue(path, async (input, checkpoint) => { seen = input; assert.deepEqual(checkpoint.load(), plan); return done })
  t.after(() => second.close())
  assert.equal(second.status('a:1').status, 'queued')
  second.start()
  await waitFor(() => second.status('a:1').status === 'completed')
  assert.deepEqual(seen, work())
  const disk = new DatabaseSync(path)
  assert.equal(disk.prepare('SELECT payload FROM queue_jobs').get().payload, null)
  disk.close()
})

test('expired crash lease recovers but two workers never concurrently execute the same outbox', async t => {
  const path = await fixture(t)
  let count = 0, concurrent = 0, maximum = 0
  const execute = async () => {
    count++; maximum = Math.max(maximum, ++concurrent)
    await new Promise(resolve => setTimeout(resolve, 40))
    concurrent--; return done
  }
  const first = new WritebackQueue(path, execute)
  const second = new WritebackQueue(path, execute)
  t.after(() => Promise.all([first.close(), second.close()]))
  first.enqueue(work()); first.enqueue(work('b'))
  const disk = new DatabaseSync(path)
  disk.exec("UPDATE queue_jobs SET status='running' WHERE source_key='a:1'; UPDATE queue_lease SET owner='dead-process',expires=1")
  disk.close()
  second.start()
  await waitFor(() => first.status('b:1').status === 'completed')
  assert.equal(count, 2); assert.equal(maximum, 1)
})

test('network failures retain their snapshot, retry automatically and respect the retry budget', async t => {
  const path = await fixture(t)
  let calls = 0
  const queue = new WritebackQueue(path, async () => { calls++; throw new Error('fetch failed') })
  t.after(() => queue.close())
  queue.enqueue(work())
  await waitFor(() => queue.status('a:1').nextAttemptAt > Date.now())
  assert.equal(queue.status('a:1').status, 'queued')
  const disk = new DatabaseSync(path)
  disk.exec("UPDATE queue_jobs SET attempts=4,next_at=0 WHERE source_key='a:1'")
  disk.close()
  queue.start()
  await waitFor(() => queue.status('a:1').status === 'failed')
  assert.equal(calls, 2)
  assert.equal(queue.status('a:1').retryable, true)
})

test('queue capacity fails explicitly without dropping pending records or claiming success', async t => {
  const path = await fixture(t)
  const queue = new WritebackQueue(path, async () => done)
  t.after(() => queue.close())
  const disk = new DatabaseSync(path)
  const insert = disk.prepare("INSERT INTO queue_jobs(source_key,session_id,status,view) VALUES(?,?,'failed',?)")
  disk.exec('BEGIN')
  for (let i = 0; i < 1000; i++) insert.run(`old:${i}`, 'old', JSON.stringify({ status: 'failed' }))
  disk.exec('COMMIT')
  assert.throws(() => queue.enqueue(work()), /队列已满/)
  assert.equal(disk.prepare('SELECT count(*) AS n FROM queue_jobs').get().n, 1000)
  assert.equal(queue.status('a:1'), undefined)
  disk.close()
})
