import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { JournalService } from '../worklog/service.js'
import { calendarIcs } from '../worklog/calendar/ical.js'
import { wallTime, startOfDay, localParts, monthDays, weekDays } from '../worklog/calendar/time.js'
import { calendarTools } from '../lib/calendar-tools.js'
import { knowledgeEntry } from '../lib/tool-entry.js'
const q = x => new URLSearchParams(x), signal = () => new AbortController().signal
function fixture(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store.calendar }
const create = (c, event, requestId = randomUUID()) => c.mutate('create', { requestId, event: { title: '完成初稿', ...(event?.allDay === false ? {} : { day: '2026-11-17' }), ...event } })
const update = (c, e, patch) => c.mutate('update', { requestId: randomUUID(), id: e.id, revision: e.revision, patch })
const range = (c, more = {}) => c.list(q({ from: '2026-11-17', to: '2026-11-18', ...more }))

test('goals persist separately from reports with idempotent receipts across reopen and concurrent instances', t => {
  const root = mkdtempSync(join(tmpdir(), 'calendar-test-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  let store = new Store(join(root, 'journal.sqlite')); store.save('2026-11-17', '# Original', 0)
  const requestId = randomUUID(), first = create(store.calendar, {}, requestId), identity = store.calendar.calendarId
  assert.equal(first.event.endDay, '2026-11-18'); assert.equal(first.event.allDay, true)
  store.close(); store = new Store(join(root, 'journal.sqlite')); t.after(() => store.close())
  const second = new Store(join(root, 'journal.sqlite')); t.after(() => second.close())
  assert.equal(store.calendar.calendarId, identity); assert.equal(second.calendar.calendarId, identity)
  const done = update(second.calendar, first.event, { status: 'done', tags: ['写作', '写作'] }).event
  assert.ok(done.completedAt); assert.deepEqual(done.tags, ['写作'])
  const retry = create(store.calendar, {}, requestId); assert.equal(retry.replayed, true); assert.equal(retry.event.id, first.event.id); assert.equal(retry.event.revision, 1)
  assert.equal(store.calendar.get(first.event.id).status, 'done'); assert.equal(range(store.calendar).total, 1)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM reports').get().n, 1)
  assert.throws(() => create(store.calendar, { title: 'other' }, requestId), e => e.status === 409)
  assert.throws(() => update(store.calendar, first.event, { title: 'overwrite' }), e => e.status === 409)
  assert.equal(store.calendar.info().cursor, 2)
})

test('completion, rescheduling, reversible deletion and restore are revision guarded and atomic', t => {
  const c = fixture(t); let e = create(c).event
  e = update(c, e, { day: '2026-11-18', status: 'done' }).event; assert.equal(e.endDay, '2026-11-19'); assert.ok(e.completedAt)
  e = update(c, e, { status: 'in_progress' }).event; assert.equal(e.completedAt, null)
  const requestId = randomUUID(), data = { requestId, id: e.id, revision: e.revision }
  const removed = c.mutate('delete', data).event; assert.ok(removed.deletedAt)
  assert.equal(range(c, { to: '2026-11-20' }).total, 0); assert.equal(range(c, { to: '2026-11-20', deleted: 'only' }).total, 1)
  assert.throws(() => update(c, removed, { title: 'not allowed' }), /删除/)
  const restored = c.mutate('restore', { requestId: randomUUID(), id: removed.id, revision: removed.revision }).event
  assert.equal(restored.deletedAt, null); assert.ok(c.mutate('delete', data).replayed)
  assert.equal(c.get(e.id).deletedAt, null)
  const cursor = c.info().cursor
  assert.throws(() => update(c, restored, { title: '' })); assert.equal(c.info().cursor, cursor)
  assert.throws(() => c.mutate('create', { requestId: randomUUID(), calendarId: 'other', event: { title: 'X', day: '2026-11-17' } }), /连接/)
})

test('all-day and timed intervals obey half-open dates and display timezone including midnight', t => {
  const c = fixture(t)
  create(c, { title: '跨天', allDay: false, startAt: '2026-11-17T23:30:00+08:00', endAt: '2026-11-18T00:00:00+08:00', timeZone: 'Asia/Shanghai' })
  create(c, { title: '凌晨', allDay: false, startAt: '2026-11-18T00:00:00+08:00', endAt: '2026-11-18T01:00:00+08:00', timeZone: 'Asia/Shanghai' })
  assert.equal(range(c).total, 1); assert.equal(range(c, { from: '2026-11-18', to: '2026-11-19' }).total, 1)
  assert.equal(range(c, { timeZone: 'America/New_York' }).total, 2)
  let e = create(c, { day: '2026-11-17', endDay: '2026-11-20' }).event
  assert.equal(range(c, { from: '2026-11-19', to: '2026-11-20' }).total, 1)
  assert.equal(range(c, { from: '2026-11-20', to: '2026-11-21' }).total, 0)
  e = update(c, e, { allDay: false, startAt: '2026-11-18T09:00:00+08:00', endAt: '2026-11-18T10:00:00+08:00' }).event
  assert.throws(() => update(c, e, { day: '2026-11-19' }), /定时目标/); assert.throws(() => update(c, e, {}), /至少/); assert.equal(e.day, '2026-11-18'); assert.equal(e.endDay, '2026-11-19')
  e = update(c, e, { allDay: true, day: '2026-11-20' }).event; assert.equal(e.startAt, null); assert.equal(e.endDay, '2026-11-21')
})

test('DST civil-time conversion rejects skipped/repeated times and uses correct day lengths', () => {
  assert.throws(() => wallTime('2026-03-08', '02:30', 'America/New_York'), /不存在/)
  assert.throws(() => wallTime('2026-11-01', '01:30', 'America/New_York'), /两次/)
  assert.equal(new Date(wallTime('2026-11-01', '01:30', 'America/New_York', 'earlier')).toISOString(), '2026-11-01T05:30:00.000Z')
  assert.equal(startOfDay('2026-03-09', 'America/New_York') - startOfDay('2026-03-08', 'America/New_York'), 23 * 3600000)
  assert.equal(startOfDay('2026-11-02', 'America/New_York') - startOfDay('2026-11-01', 'America/New_York'), 25 * 3600000)
  assert.equal(localParts(wallTime('2026-11-17', '09:15', 'Asia/Kathmandu'), 'Asia/Kathmandu').time, '09:15')
  assert.equal(monthDays('2026-11-17').length, 42); assert.deepEqual(weekDays('2026-11-17'), ['2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-21','2026-11-22'])
})

test('invalid calendar data cannot partly mutate or inject SQL', t => {
  const c = fixture(t)
  for (const event of [{ allDay: false, startAt: '2026-11-17T24:00Z', endAt: '2026-11-18T01:00Z' }, { day: '2026-02-30' }, { day: '2026-1-1' }, { title: 'a'.repeat(161) }, { tags: ['a'.repeat(33)] }, { timeZone: 'Invalid/Zone' }, { status: 'fake' }, { endDay: '2026-11-17' }, { allDay: false, startAt: '2026-11-17T09:00', endAt: '2026-11-17T10:00' }, { allDay: false, startAt: '2026-11-17T10:00Z', endAt: '2026-11-17T09:00Z' }, { unknown: 1 }]) assert.throws(() => create(c, event))
  assert.equal(c.info().cursor, 0)
  assert.throws(() => range(c, { from: '2024-01-01' })); assert.throws(() => range(c, { limit: '1;DELETE FROM calendar_events' }))
  create(c, { title: "' OR 1=1 --", tags: ['标签'] }); create(c)
  assert.equal(range(c, { query: "' OR 1=1 --" }).total, 1); assert.equal(range(c, { tag: '标签' }).total, 1)
  const first = range(c, { limit: 1 }); assert.equal(first.nextOffset, 1); assert.equal(range(c, { offset: 1 }).items.length, 1)
})

test('incremental cursor includes tombstones, preserves uid and cannot cross calendars', t => {
  const c = fixture(t), first = create(c).event, next = update(c, first, { description: 'changed' }).event
  const removed = c.mutate('delete', { requestId: randomUUID(), id: next.id, revision: next.revision }).event
  let page = c.changes(q({ limit: '1' })); assert.equal(page.hasMore, true)
  assert.throws(() => c.changes(q({ after: page.nextCursor })), /calendarId/)
  page = c.changes(q({ after: page.nextCursor, calendarId: c.calendarId })); assert.equal(page.changes.length, 2); assert.equal(page.hasMore, false)
  assert.equal(page.changes.at(-1).event.deletedAt, removed.deletedAt); assert.equal(page.changes.at(-1).event.uid, first.uid)
  assert.throws(() => c.changes(q({ after: 100, calendarId: c.calendarId })), /游标/)
})

test('iCalendar escapes text, preserves UTF8 folding, correct endpoints and no deleted items', t => {
  const c = fixture(t), e = create(c, { title: '中文😀'.repeat(25), description: 'line\nBEGIN:VEVENT\n\\,;', tags: ['测试'] }).event
  const text = calendarIcs([e]); const unfolded = text.replace(/\r\n /g, '')
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261117/); assert.match(unfolded, /DTEND;VALUE=DATE:20261118/)
  assert.ok(unfolded.includes(e.title)); assert.match(unfolded, /DESCRIPTION:line\\nBEGIN:VEVENT/)
  assert.equal(text.split('\r\n').filter(l => l === 'BEGIN:VEVENT').length, 1)
  for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75)
  assert.doesNotMatch(calendarIcs([{ ...e, deletedAt: 1 }]), /BEGIN:VEVENT/)
  const timed = create(c, { allDay: false, startAt: '2026-11-17T09:00+08:00', endAt: '2026-11-17T10:00+08:00' }).event
  assert.match(calendarIcs([timed]), /DTSTART:20261117T010000Z/)
})

test('AI operation is discoverable behind knowledge, validates schema, and requires an agent', async t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const service = new JournalService(store, {}, async () => [])
  const entry = knowledgeEntry(new Map(calendarTools((...args) => service.calendar(...args)).map(x => [x.name, x])))
  const exec = { agent: { session: { id: 'test' } }, signal: signal() }
  const call = (args, context = exec) => entry.execute({ action: 'call', tool: 'knowledge_calendar', arguments: args }, context).then(JSON.parse)
  const discovered = JSON.parse(await entry.execute({ action: 'list' }, exec)); assert.equal(discovered.operations[0].name, 'knowledge_calendar')
  assert.ok((await call({ action: 'info' })).calendarId)
  const result = await call({ action: 'create', requestId: randomUUID(), event: { title: 'test', day: '2026-11-17' } }); assert.equal(result.event.title, 'test')
  assert.equal((await call({ action: 'list', from: '2026-11-17', to: '2026-11-18' })).total, 1)
  await assert.rejects(call({ action: 'create', requestId: randomUUID(), event: { title: 'X', unknown: true } }))
  await assert.rejects(call({ action: 'list', event: {} }))
  await assert.rejects(call({ action: 'info' }, { signal: signal() }))
  await assert.rejects(call({ action: 'info' }, { ...exec, signal: AbortSignal.abort() }))
  assert.equal((await call({ action: 'export', from: '2026-11-17', to: '2026-11-18' })).count, 1)
})

test('remote calendar never falls back to local; unknown write outcomes and connection switches remain explicit', async t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const current = { backend: 'remote', remoteUrl: 'https://central.example', remoteToken: 'x' }
  const service = new JournalService(store, {}, async () => [], () => current, async () => { throw Error('offline') })
  await assert.rejects(service.calendar('GET', '/calendar-info', {}, q(), signal()), /offline/)
  await assert.rejects(service.calendar('POST', '/calendar-create', { requestId: 'x', event: { title: 'x', day: '2026-11-17' } }, q(), signal()), /同一 requestId/)
  assert.equal(store.calendar.info().cursor, 0)
  service.request = async () => { current.remoteUrl = 'https://another.example'; return { ok: true } }
  await assert.rejects(service.calendar('POST', '/calendar-create', {}, q(), signal()), /连接已变化/)
  current.paused = true; await assert.rejects(service.calendar('GET', '/calendar-info', {}, q(), signal()), /切换/)
})
