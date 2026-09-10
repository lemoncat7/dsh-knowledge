import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { WritebackQueue } from '../lib/writeback/queue.js'

const done = { status: 'completed', summary: '已写入', retryable: false }

test('management lists newest first and preserves original creation time on duplicate enqueue', async t => {
  const queue = new WritebackQueue(':memory:', async () => done)
  t.after(() => queue.close())
  const before = Date.now()
  queue.enqueue(work('older'))
  const createdAt = queue.list().items[0].createdAt
  queue.enqueue(work('newer'))
  queue.enqueue(work('older'))
  assert.deepEqual(queue.list().items.map(item => item.sourceKey), ['newer:1', 'older:1'])
  assert.equal(queue.list('older').items[0].createdAt, createdAt)
  assert.ok(createdAt >= before && createdAt <= Date.now())
})

test('exhausted head releases successors and can still be cancelled without replay', async t => {
  const path = await fixture(t)
  const queue = new WritebackQueue(path, async input => {
    if (input.snapshot.turn === 1) throw new Error('configuration unavailable')
    return done
  })
  t.after(() => queue.close())
  queue.enqueue(work()); queue.enqueue(work('a', 2))
  const disk = new DatabaseSync(path)
  disk.exec("UPDATE queue_jobs SET attempts=4 WHERE source_key='a:1'")
  disk.close()
  await waitFor(() => queue.status('a:1').status === 'failed')
  await waitFor(() => queue.status('a:2').status === 'completed')
  assert.equal(queue.status('a:2').blockedBy, undefined)
  assert.equal(queue.list('a').total, 2)
  assert.equal(queue.list('a').items[0].payload, undefined)
  assert.equal(queue.cancel('a:1').status, 'cancelled')
  assert.equal(queue.cancel('a:1').status, 'cancelled')
  await waitFor(() => queue.status('a:2').status === 'completed')
  await queue.close()
  const reopened = new WritebackQueue(path, async () => { assert.fail('cancelled task must not run') })
  t.after(() => reopened.close())
  assert.equal(reopened.retry('a:1').status, 'cancelled')
  reopened.start()
})

test('running cancellation holds lease until executor actually exits', async t => {
  const path = await fixture(t)
  let release, entered = false, successor = false
  const gate = new Promise(resolve => { release = resolve })
  const queue = new WritebackQueue(path, async input => {
    if (input.snapshot.turn === 1) { entered = true; await gate } else successor = true
    return done
  })
  t.after(async () => { release(); await queue.close() })
  queue.enqueue(work()); queue.enqueue(work('a', 2))
  await waitFor(() => entered)
  assert.equal(queue.cancel('a:1').cancelRequested, true)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(successor, false)
  assert.equal(queue.status('a:1').status, 'running')
  release()
  await waitFor(() => successor)
  assert.equal(queue.status('a:1').status, 'cancelled')
})

test('crash recovery honors durable cancellation before running successor', async t => {
  const path = await fixture(t)
  const calls = []
  const queue = new WritebackQueue(path, async input => { calls.push(input.snapshot.sourceKey); return done })
  t.after(() => queue.close())
  queue.enqueue(work()); queue.enqueue(work('a', 2))
  const disk = new DatabaseSync(path)
  disk.exec("UPDATE queue_jobs SET status='running',cancel_requested=1 WHERE source_key='a:1'; UPDATE queue_lease SET owner='dead',expires=1")
  disk.close()
  await waitFor(() => queue.status('a:2').status === 'completed')
  assert.deepEqual(calls, ['a:2'])
  assert.equal(queue.status('a:1').status, 'cancelled')
})
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

test('exhausted head does not block any session; duplicate manual retries run once', async t => {
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
  const disk = new DatabaseSync(path)
  disk.exec("UPDATE queue_jobs SET attempts=4 WHERE source_key='a:1'")
  disk.close()
  await waitFor(() => queue.status('b:1')?.status === 'completed')
  assert.deepEqual(calls, ['a:1', 'a:2', 'b:1'])
  assert.equal(queue.status('a:2').blockedBy, undefined)
  fail = false
  queue.retry('a:1'); queue.retry('a:1'); queue.enqueue(work())
  await waitFor(() => queue.status('a:1').status === 'completed')
  assert.deepEqual(calls, ['a:1', 'a:2', 'b:1', 'a:1'])
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

test('generic model failures retry with backoff and the same plan, then release successors', async t => {
  const path = await fixture(t)
  const calls = []
  const plan = [{ delivery: 'audit', proposal: { reason: 'preserve exact plan' } }]
  const queue = new WritebackQueue(path, async (input, checkpoint) => {
    calls.push(input.snapshot.sourceKey)
    if (input.snapshot.sourceKey !== 'a:1') return done
    if (!checkpoint.load()) checkpoint.save(plan)
    else assert.deepEqual(checkpoint.load(), plan)
    throw new Error('model execution failed: error')
  })
  t.after(() => queue.close())
  queue.enqueue(work()); queue.enqueue(work('a', 2)); queue.enqueue(work('b'))
  queue.start()
  const disk = new DatabaseSync(path)
  t.after(() => disk.close())
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitFor(() => {
      const row = disk.prepare("SELECT attempts,status FROM queue_jobs WHERE source_key='a:1'").get()
      return row.attempts === attempt && row.status !== 'running'
    })
    if (attempt < 5) {
      const status = queue.status('a:1')
      assert.equal(status.status, 'queued')
      assert.ok(status.nextAttemptAt > Date.now())
      assert.ok(status.nextAttemptAt <= Date.now() + [5000, 15000, 60000, 180000][attempt - 1])
      assert.equal(queue.status('a:2').blockedBy, 'a:1')
      assert.equal(queue.status('b:1').status, 'completed')
      // Advance only the durable due date, keeping real worker scheduling/leases.
      disk.exec("UPDATE queue_jobs SET next_at=0 WHERE source_key='a:1'")
    }
  }
  await waitFor(() => queue.status('a:2').status === 'completed')
  assert.equal(calls.filter(key => key === 'a:1').length, 5)
  assert.equal(queue.status('a:1').status, 'failed')
  assert.equal(queue.status('a:1').retryable, true)
  assert.equal(queue.status('a:2').blockedBy, undefined)
  const retained = disk.prepare("SELECT payload,plan FROM queue_jobs WHERE source_key='a:1'").get()
  assert.deepEqual(JSON.parse(retained.payload), work())
  assert.deepEqual(JSON.parse(retained.plan), plan)
})

test('generic failure recovery preserves retry budget and plan across restart', async t => {
  const path = await fixture(t)
  const plan = [{ delivery: 'audit', proposal: { reason: 'already generated' } }]
  const first = new WritebackQueue(path, async (_input, checkpoint) => {
    checkpoint.save(plan)
    throw new Error('empty model response')
  })
  t.after(() => first.close())
  first.enqueue(work())
  await waitFor(() => first.status('a:1').nextAttemptAt > Date.now())
  await first.close()
  let calls = 0
  const second = new WritebackQueue(path, async (_input, checkpoint) => {
    calls++
    assert.deepEqual(checkpoint.load(), plan)
    return done
  })
  t.after(() => second.close())
  assert.equal(second.list().items[0].attempts, 1)
  const disk = new DatabaseSync(path)
  disk.exec("UPDATE queue_jobs SET next_at=0 WHERE source_key='a:1'")
  disk.close()
  second.start()
  await waitFor(() => second.status('a:1').status === 'completed')
  assert.equal(second.list().items[0].attempts, 2)
  assert.equal(calls, 1)
})

test('old failed records no longer block queued work after upgrading', async t => {
  const path = await fixture(t)
  const calls = []
  const queue = new WritebackQueue(path, async input => { calls.push(input.snapshot.sourceKey); return done })
  t.after(() => queue.close())
  queue.enqueue(work()); queue.enqueue(work('a', 2))
  const disk = new DatabaseSync(path)
  disk.prepare("UPDATE queue_jobs SET status='failed',view=? WHERE source_key='a:1'").run(JSON.stringify({ status: 'failed', summary: '旧版失败', retryable: true }))
  disk.close()
  assert.equal(queue.status('a:2').blockedBy, undefined)
  await waitFor(() => queue.status('a:2').status === 'completed')
  assert.deepEqual(calls, ['a:2'])
  assert.equal(queue.status('a:1').status, 'failed')
})
