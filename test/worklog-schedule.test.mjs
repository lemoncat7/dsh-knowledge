import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { Worker } from '../worklog/worker.js'
import { defaults, settings } from '../worklog/domain.js'
import { scheduledDay, Scheduler } from '../worklog/scheduler.js'

const at = text => Date.parse(text)
const before = at('2026-09-30T14:00:00Z'), due = at('2026-09-30T15:00:00Z')
const config = { ...defaults, scheduleEnabled: true, provider: 'test', model: 'test' }
function setup(t) { const store = new Store(':memory:'); t.after(() => store.close()); store.configure(config, before); return store }
function count(s) { return s.db.prepare('SELECT count(*) AS n FROM jobs').get().n }

test('schedule is opt-in; strict HH:mm validation and legacy settings stay disabled', t => {
  const s = setup(t)
  assert.equal(settings({ ...defaults, scheduleEnabled: undefined }).scheduleEnabled, false)
  for (const scheduleTime of ['24:00', '23:60', '9:00', '00:00:01', '', null, 123]) {
    assert.throws(() => settings({ ...config, scheduleTime }), /时间/)
  }
  assert.throws(() => settings({ ...config, scheduleEnabled: 'true' }), /时间/)
  s.configure(defaults, before)
  s.note('2026-09-30', '不应被自动整理')
  s.schedule(due); assert.equal(count(s), 0)
})

test('civil-time scheduling handles midnight, non-hour zones and DST', () => {
  assert.equal(scheduledDay(config, { since: before }, due - 1), null)
  assert.equal(scheduledDay(config, { since: before }, due), '2026-09-30')
  assert.equal(scheduledDay({ ...config, scheduleTime: '00:00' }, { since: before }, at('2026-09-30T16:00:00Z')), '2026-10-01')
  assert.equal(scheduledDay({ ...config, timezone: 'Asia/Kathmandu', scheduleTime: '18:45' }, { since: at('2026-09-30T12:00Z') }, at('2026-09-30T13:00Z')), '2026-09-30')
  const dst = { ...config, timezone: 'America/New_York', scheduleTime: '02:30' }
  // Spring's missing 02:30 runs after the clock jumps, rather than disappearing.
  assert.equal(scheduledDay(dst, { since: at('2026-03-08T05:00Z') }, at('2026-03-08T07:00Z')), '2026-03-08')
  const fall = { ...dst, scheduleTime: '01:30' }, state = { since: at('2026-11-01T04:00Z'), last: { day: '2026-11-01' } }
  assert.equal(scheduledDay(fall, state, at('2026-11-01T06:30Z')), null)
})

test('enabling after the scheduled time waits until the next occurrence', t => {
  const s = setup(t)
  s.configure({ ...config, scheduleTime: '22:00' }, due)
  s.schedule(due); assert.equal(s.scheduleState().last, undefined)
  s.configure({ ...config, scheduleTime: '22:00', timezone: 'UTC' }, due)
  assert.equal(s.scheduleState().since, due)
  s.configure({ ...s.config(), projects: ['/new'] }, due + 1000)
  assert.equal(s.scheduleState().since, due, 'unrelated settings must not postpone the schedule')
})

test('due slot and queue are persistent and idempotent across restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'worklog-schedule-')), file = join(dir, 'journal.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let s = new Store(file)
  s.configure(config, before); s.note('2026-09-30', '完成测试')
  s.schedule(due); s.schedule(due + 1000)
  assert.equal(count(s), 1)
  const id = s.scheduleState().last.jobId
  s.close(); s = new Store(file)
  try {
    s.schedule(due + 5000)
    assert.equal(count(s), 1); assert.equal(s.scheduleState().last.jobId, id)
    assert.equal(s.job(id).status, 'queued')
  } finally { s.close() }
})

test('restart catches only the most recent missed slot; no historical backlog', t => {
  const s = setup(t)
  for (const day of ['2026-09-30', '2026-10-01', '2026-10-02']) s.note(day, '待整理')
  s.schedule(at('2026-10-03T01:00Z'))
  assert.equal(s.scheduleState().last.day, '2026-10-02')
  assert.equal(count(s), 1)
  assert.equal(s.db.prepare('SELECT day FROM jobs').get().day, '2026-10-02')
})

test('no new records and manual edits are skipped without a model call', t => {
  const s = setup(t)
  s.schedule(due); assert.equal(count(s), 0)
  assert.equal(s.scheduleState().last.status, 'skipped')
  s.note('2026-10-01', '新素材'); s.save('2026-10-01', '人工正文', 0)
  s.schedule(due + 86400000)
  assert.equal(count(s), 0); assert.match(s.scheduleState().last.message, /手工修改/)
  s.note('2026-10-02', '已覆盖')
  s.save('2026-10-02', '已整理', 0, s.records('2026-10-02').map(r => r.id), false)
  s.schedule(due + 2 * 86400000)
  assert.equal(count(s), 0); assert.match(s.scheduleState().last.message, /没有待整理/)
})

test('pending manual task is not duplicated; scheduler waits for its result', t => {
  const s = setup(t); s.note('2026-09-30', '任务 A')
  const id = s.enqueue('2026-09-30')
  s.schedule(due); assert.equal(count(s), 1); assert.equal(s.scheduleState().last, undefined)
  const body = JSON.parse(s.job(id).body)
  s.save('2026-09-30', '已整理 A', 0, body.records.map(r => r.id), false)
  s.status(id, 'done', body)
  s.schedule(due + 30000)
  assert.equal(count(s), 1); assert.equal(s.scheduleState().last.status, 'skipped')
})

test('failed preflight is visible and does not loop; transaction rollback permits retry', t => {
  const s = setup(t)
  s.configure({ ...config, provider: '', model: '' }, before)
  s.note('2026-09-30', '仅补记')
  s.schedule(due); assert.equal(s.scheduleState().last.status, 'failed')
  s.schedule(due + 30000); assert.equal(count(s), 0)
  s.configure(config, before)
  const original = s.setMeta
  s.note('2026-10-01', '新素材')
  s.setMeta = () => { throw new Error('disk failure') }
  assert.throws(() => s.schedule(due + 86400000), /disk failure/)
  assert.equal(count(s), 0); assert.equal(s.scheduleState().last.day, '2026-09-30')
  s.setMeta = original; s.schedule(due + 86400000)
  assert.equal(count(s), 1)
})

test('disabling, cancelling and changing time cannot repeatedly trigger the same day', t => {
  const s = setup(t); s.note('2026-09-30', '任务')
  s.schedule(due); const job = s.job(s.scheduleState().last.jobId)
  s.status(job.id, 'cancelled', JSON.parse(job.body))
  s.configure({ ...config, scheduleEnabled: false }, due + 1000); s.schedule(due + 2000)
  s.configure({ ...config, scheduleTime: '23:30' }, due + 3000); s.schedule(due + 1800000)
  assert.equal(count(s), 1)
  assert.equal(s.job(job.id).status, 'cancelled')
})

test('lightweight scheduler checks no more than once per 30 seconds', () => {
  const calls = [], scheduler = new Scheduler({ schedule: now => calls.push(now) })
  scheduler.tick(due); scheduler.tick(due + 1); scheduler.tick(due + 29999); scheduler.tick(due + 30000)
  assert.deepEqual(calls, [due, due + 30000])
})

test('scheduled jobs use the normal worker retry and completion path', async t => {
  const s = setup(t); s.note('2026-09-30', '任务'); s.schedule(due)
  const worker = new Worker(s, {}, async () => { throw new Error('network') })
  t.after(() => worker.close())
  const id = s.scheduleState().last.jobId
  await worker.tick()
  assert.equal(s.job(id).attempts, 1); assert.equal(s.job(id).status, 'queued')
  worker.render = async () => '# 日报'
  s.status(id, 'queued', JSON.parse(s.job(id).body), 1, 0)
  await worker.tick()
  assert.equal(s.job(id).status, 'done'); assert.equal(s.report('2026-09-30').markdown, '# 日报')
})
