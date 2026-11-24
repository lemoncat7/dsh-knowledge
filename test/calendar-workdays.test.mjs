import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../worklog/store.js'
import { defaultWorkdays, normalizeWorkdays, nextWorkday } from '../worklog/calendar/workdays.js'
import { progressSources, reportDecisions } from '../worklog/calendar/report-progress.js'

const friday = '2026-11-20', monday = '2026-11-23'
const at = day => Date.parse(day + 'T10:00:00+08:00')
const create = (c, title, day, carryMode = 'daily') => c.mutate('create', { requestId: randomUUID(), event: { title, day, carryMode } }).event
const list = (c, from, to) => c.list(new URLSearchParams({ from, to })).items
function fixture(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store }

test('workdays support weekly custom schedules, holiday overrides and makeup weekends', () => {
  assert.equal(nextWorkday(friday, defaultWorkdays()), monday)
  const custom = normalizeWorkdays({ revision: 0, weekdays: [1, 2, 3, 4, 5], overrides: [{ day: '2026-11-21', workday: true }, { day: monday, workday: false }] })
  assert.equal(nextWorkday(friday, custom), '2026-11-21')
  assert.equal(nextWorkday('2026-11-21', custom), '2026-11-24')
  assert.throws(() => normalizeWorkdays({ ...custom, weekdays: [] }), /至少/)
  assert.throws(() => normalizeWorkdays({ ...custom, overrides: [{ day: friday, workday: true }, { day: friday, workday: false }] }), /重复/)
})

test('Friday carries skip resting dates while daily goals retain their existing behavior without repeated writes', t => {
  const store = fixture(t), c = store.calendar
  const work = create(c, '工作日目标', friday, 'workdays')
  const daily = create(c, '每日目标', friday)
  assert.equal(c.carryGoals(at('2026-11-21')), 2)
  assert.deepEqual(list(c, '2026-11-21', '2026-11-22').map(event => event.carriedFrom.id), [daily.id])
  const carried = list(c, monday, '2026-11-24')[0]
  assert.equal(carried.carriedFrom.id, work.id)
  assert.equal(carried.carriedFrom.day, friday)
  const changes = store.db.prepare('SELECT total_changes() AS n').get().n
  for (let i = 0; i < 10; i++) assert.equal(c.carryGoals(at('2026-11-21')), 0)
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes)
})

test('missed days catch up once to the next eligible date, preserving source day and lineage', t => {
  const store = fixture(t), c = store.calendar
  const goal = create(c, '关机期间未完成', friday, 'workdays')
  assert.equal(c.carryGoals(at('2026-11-24')), 1)
  const copy = list(c, '2026-11-24', '2026-11-25')[0]
  assert.equal(copy.carriedFrom.day, friday)
  assert.equal(c.progressGoal(copy.id).root.id, goal.id)
  assert.equal(list(c, '2026-11-21', '2026-11-24').length, 0)
  assert.equal(c.carryGoals(at('2026-11-24')), 0)
})

test('workday settings reject concurrent changes, preserve explicit choices, and no-op saves do not write', t => {
  const store = fixture(t), c = store.calendar
  const original = c.workdaySettings()
  const saved = c.configureWorkdays({ ...original, weekdays: [2, 4, 6] })
  assert.equal(saved.revision, 1)
  assert.throws(() => c.configureWorkdays(original), /已更新/)
  const changes = store.db.prepare('SELECT total_changes() AS n').get().n
  c.configureWorkdays(saved)
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes)
  create(c, '周六工作', friday, 'workdays')
  c.carryGoals(at('2026-11-21'))
  assert.equal(list(c, '2026-11-21', '2026-11-22').length, 1)
})

test('report completion follows untouched workday carries across weekends and several generations', t => {
  const store = fixture(t), c = store.calendar
  const goal = create(c, '交付目标', friday, 'workdays')
  c.carryGoals(at('2026-11-21')); c.carryGoals(at('2026-11-24'))
  const descendants = list(c, monday, '2026-11-25')
  assert.equal(descendants.length, 2)
  store.reportProgress.apply(friday, [{ goal: { ...goal, progressRevision: 0 }, state: 'done', text: '用户已确认完整交付。' }])
  for (const event of descendants) assert.equal(c.get(event.id).status, 'done')
})

test('progress summaries are shared by carries and the refresh cursor changes even for historical edits', t => {
  const store = fixture(t), c = store.calendar
  const goal = create(c, '已有进展', friday, 'workdays')
  c.carryGoals(at('2026-11-21'))
  const first = c.mutate('progress-write', { id: goal.id, requestId: randomUUID(), day: friday, revision: 0, text: '已梳理打包步骤。' }, 1000)
  const cursor = c.info().progressCursor
  c.mutate('progress-write', { id: goal.id, requestId: randomUUID(), day: '2026-11-19', revision: 0, text: '已核对构建制品。' }, 500)
  assert.ok(c.info().progressCursor > cursor)
  assert.deepEqual(list(c, monday, '2026-11-24')[0].progressSummary, { count: 2, day: friday, text: '已梳理打包步骤。' })
  c.mutate('progress-write', { id: goal.id, requestId: randomUUID(), day: friday, revision: first.progress.revision, text: '' })
  assert.equal(list(c, monday, '2026-11-24')[0].progressSummary.count, 1)
})

test('report evidence beyond the old prefix and canonical string source numbers remains verifiable', () => {
  const goal = { id: 'goal', title: '熟悉构建流程' }
  const quote = '已梳理编译顺序和产物交接方式，并保存了构建流程笔记。'
  const sources = progressSources([{ id: 'source-real', user: '整理当前构建流程', answer: '前置说明。'.repeat(160) + quote, sessionId: 'session' }], [goal])
  assert.ok(sources[0].answer.includes(quote))
  assert.equal(JSON.stringify(sources).includes('original'), false)
  const output = source => JSON.stringify({ items: [{ id: goal.id, state: 'progress', text: '已整理构建流程和产物交接笔记。', source, field: 'answer', quote }] })
  assert.equal(reportDecisions(output('1'), [goal], sources).length, 1)
  assert.equal(reportDecisions(output('source-real'), [goal], sources).length, 1)
  assert.equal(reportDecisions(output('1x'), [goal], sources).length, 0)
})

test('explicit history recheck queues existing reports once and never replaces manual progress', async t => {
  const store = fixture(t), c = store.calendar
  const goal = create(c, '熟悉构建流程', friday)
  const quote = '已整理构建流程和产物交接笔记，并核对了当前编译顺序。'
  store.insert({ id: 'evidence', day: friday, user: '核对并整理构建步骤', answer: quote, project: '', sessionId: 'session', route: { provider: 'p', model: 'm' } })
  store.reportProgress.configure(true)
  store.save(friday, '已有日报', 0, ['evidence'], false, { provider: 'p', model: 'm' })
  await store.reportProgress.tick({ async *stream() { yield { type: 'text-delta', text: '{"items":[]}' } } }, new AbortController().signal)
  assert.equal(store.reportProgress.recheck({ from: friday, to: friday }).queued, 1)
  assert.equal(store.reportProgress.recheck({ from: friday, to: friday }).queued, 0)
  c.mutate('progress-write', { id: goal.id, day: friday, requestId: randomUUID(), revision: 0, text: '人工核对，保留原文。' })
  await store.reportProgress.tick({ async *stream() { yield { type: 'text-delta', text: JSON.stringify({ items: [{ id: goal.id, state: 'progress', text: quote, source: '1', field: 'answer', quote }] }) } } }, new AbortController().signal)
  assert.equal(c.goalProgress(goal.id, friday).progress.text, '人工核对，保留原文。')
})


test('workday choices survive reopening and historical recheck can recover the source route without a prior calendar job', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-workdays-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'worklog.sqlite')
  const initial = new Store(path)
  initial.calendar.configureWorkdays({ revision: 0, weekdays: [2, 4, 6], overrides: [{ day: monday, workday: false }] })
  initial.close()
  const reopened = new Store(path)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.calendar.workdaySettings(), { revision: 1, weekdays: [2, 4, 6], overrides: [{ day: monday, workday: false }] })
  create(reopened.calendar, '需重新核对', friday)
  reopened.insert({ id: 'route-evidence', day: friday, user: '记录构建进展', answer: '构建入口已经核对并记录为笔记。', project: '', sessionId: 'session', route: { provider: 'source-provider', model: 'source-model' } })
  reopened.save(friday, '此前已生成日报', 0, ['route-evidence'], false)
  reopened.reportProgress.configure(true)
  assert.equal(reopened.reportProgress.recheck({ from: friday, to: friday }).queued, 1)
  assert.deepEqual(JSON.parse(reopened.db.prepare('SELECT body FROM calendar_report_jobs').get().body), { provider: 'source-provider', model: 'source-model' })
})
