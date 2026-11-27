import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../worklog/store.js'
import { defaultWorkdays, normalizeWorkdays, nextWorkday } from '../worklog/calendar/workdays.js'
import { progressSources, progressEvidence, reportDecisions } from '../worklog/calendar/report-progress.js'

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
  await store.reportProgress.tick({ async *stream() { yield { type: 'text-delta', text: JSON.stringify({ items: [{ id: goal.id, state: 'none', reason: '当前材料没有该目标的直接进展依据。' }] }) } } }, new AbortController().signal)
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
  const { reviewId, ...route } = JSON.parse(reopened.db.prepare('SELECT body FROM calendar_report_jobs').get().body)
  assert.match(reviewId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(route, { provider: 'source-provider', model: 'source-model', onlyMissing: true })
})


test('report matching rejects a claimed progress entry that explicitly lacks evidence of work on that goal', () => {
  const goals = [{ id: 'site', title: '查看并跟进现场问题' }]
  const quote = '已根据构建脚本梳理安装包的组件来源，并整理了构建交接笔记。'
  const sources = [{ answer: quote }]
  assert.deepEqual(reportDecisions(JSON.stringify({ items: [{ id: 'site', state: 'progress', text: '已梳理安装包组件来源；尚未证实跟进现场问题或完成现场排查。', source: 1, field: 'answer', quote }] }), goals, sources), [])
})


test('explicit recheck preserves existing automated notes without a model request, while a new report revision can update them', async t => {
  const store = fixture(t), c = store.calendar
  const goal = create(c, '梳理构建流程', friday)
  const quote = '已核对构建入口并完成产物清单的整理。'
  store.insert({ id: 'auto-source', day: friday, user: '整理已确认的构建入口', answer: quote, project: '', sessionId: 's', route: { provider: 'p', model: 'm' } })
  store.reportProgress.configure(true)
  store.save(friday, '日报', 0, ['auto-source'], false, { provider: 'p', model: 'm' })
  let calls = 0
  const llm = { async *stream() { calls++; yield { type: 'text-delta', text: JSON.stringify({ items: [{ id: goal.id, state: 'progress', text: quote, source: 1, field: 'answer', quote }] }) } } }
  await store.reportProgress.tick(llm, new AbortController().signal)
  assert.equal(calls, 1)
  assert.equal(store.reportProgress.recheck({ from: friday, to: friday }).queued, 1)
  await store.reportProgress.tick(llm, new AbortController().signal)
  assert.equal(calls, 1)
  store.save(friday, '更新后的日报', 1, ['auto-source'], false, { provider: 'p', model: 'm' })
  await store.reportProgress.tick(llm, new AbortController().signal)
  assert.equal(calls, 2)
})

test('a complete report review distinguishes no evidence from silently missing or invalid goals', () => {
  const goals = [{id:'build'},{id:'site'}], quote = '已阅读实际构建脚本，核对参数并讨论产物归档规则。'
  const progress = {id:'build',state:'progress',text:'已梳理构建参数和归档规则，流水线尚未落地。',source:1,field:'answer',quote}
  const none = {id:'site',state:'none',reason:'当天材料没有现场问题的日志或排查记录。'}
  const parse = items => reportDecisions(JSON.stringify({items}),goals,[{answer:quote}],{requireAll:true})
  assert.equal(parse([progress,none]).length,1)
  for(const items of [[],[progress],[none],[progress,{...none,id:'unknown'}],[progress,{...none,reason:''}],[{...progress,quote:'这段内容没有出现在原始材料里'},none],[progress,progress]]) {
    assert.throws(()=>parse(items),{code:'CALENDAR_PROGRESS_EVIDENCE'})
  }
  assert.deepEqual(parse([{id:'build',state:'none',reason:'未提供构建脚本、日志或讨论记录。'},none]),[])
})

test('empty and partially invalid model reviews retry instead of silently completing or writing partial notes', async t => {
  const store=fixture(t),c=store.calendar,first=create(c,'学习构建参数',friday),second=create(c,'梳理产物归档',friday)
  const quote='已核对实际构建参数，并整理当前产物归档口径。'
  store.insert({id:'review-source',day:friday,user:'核对当前构建流程',answer:quote,project:'',sessionId:'s',route:{provider:'p',model:'m'}})
  store.reportProgress.configure(true);store.save(friday,'已经核对了参数和归档',0,['review-source'],false,{provider:'p',model:'m'})
  const review=items=>({async *stream(){yield {type:'text-delta',text:JSON.stringify({items})}}})
  await store.reportProgress.tick(review([]),new AbortController().signal)
  assert.equal(store.reportProgress.status().last.status,'queued')
  assert.match(store.reportProgress.status().last.message,/核对不完整/)
  assert.equal(c.goalProgress(first.id,friday).progress.revision,0)
  const valid={id:first.id,state:'progress',text:'已核对实际构建参数。',source:1,field:'answer',quote}
  store.db.prepare('UPDATE calendar_report_jobs SET due=0').run()
  await store.reportProgress.tick(review([valid,{...valid,id:second.id,quote:'没有出现在材料中的引文'}]),new AbortController().signal)
  assert.equal(store.reportProgress.status().last.status,'queued')
  assert.equal(c.goalProgress(first.id,friday).progress.revision,0,'invalid batches must not partly commit')
  store.db.prepare('UPDATE calendar_report_jobs SET due=0').run()
  await store.reportProgress.tick(review([valid,{...valid,id:second.id,text:'已整理当前归档规则。'}]),new AbortController().signal)
  assert.equal(store.reportProgress.status().last.status,'done')
  assert.match(store.reportProgress.status().last.message,/核对 2.*更新 2/)
  assert.equal(c.goalProgress(first.id,friday).progress.revision,1)
  assert.equal(c.goalProgress(second.id,friday).progress.revision,1)
})

test('a concurrent manual edit is preserved and makes the in-flight review retry before committing other notes', async t => {
  const store=fixture(t),c=store.calendar,first=create(c,'学习构建',friday),second=create(c,'核对产物',friday)
  const quote='已阅读构建脚本并核对了当前产物版本。'
  store.insert({id:'concurrent-source',day:friday,user:'核对实际构建',answer:quote,project:'',sessionId:'s',route:{provider:'p',model:'m'}})
  store.reportProgress.configure(true);store.save(friday,'已阅读和核对',0,['concurrent-source'],false,{provider:'p',model:'m'})
  const llm={async *stream(){c.mutate('progress-write',{id:first.id,day:friday,revision:0,text:'用户自己的补记',requestId:randomUUID()});yield {type:'text-delta',text:JSON.stringify({items:[first,second].map(goal=>({id:goal.id,state:'progress',text:'已阅读构建脚本并核对版本。',source:1,field:'answer',quote}))})}}}
  await store.reportProgress.tick(llm,new AbortController().signal)
  assert.equal(c.goalProgress(first.id,friday).progress.text,'用户自己的补记')
  assert.equal(c.goalProgress(second.id,friday).progress.revision,0)
  assert.equal(store.reportProgress.status().last.status,'queued')
  assert.match(store.reportProgress.status().last.message,/发生变化/)
})

test('numbered evidence preserves original substrings without asking the model to copy quotes', () => {
  const answer='已整理实际 Jenkins 构建与归档讨论稿，方案尚未实施。\n\n'+ '已核对真实构建日志和版本。'.repeat(60)
  const sources=progressSources([{id:'original',user:'请核对构建口径',answer,sessionId:'s'}],[{title:'熟悉自动化构建',project:''}])
  const evidence=progressEvidence(sources)
  assert.ok(evidence.length>1)
  for(const proof of evidence){assert.ok(proof.quote.length>=8&&proof.quote.length<=400);assert.ok(sources[proof.source-1].original[proof.field].includes(proof.quote))}
  const proof=evidence.find(x=>x.field==='answer'&&x.quote.includes('讨论稿'))
  const output=id=>JSON.stringify({items:[{id:'goal',state:'progress',text:'已形成构建与归档讨论稿，尚未落地。',evidence:id}]})
  assert.equal(reportDecisions(output(proof.id),[{id:'goal'}],sources,{requireAll:true,evidence}).length,1)
  assert.throws(()=>reportDecisions(output('invented'),[{id:'goal'}],sources,{requireAll:true,evidence}),{code:'CALENDAR_PROGRESS_EVIDENCE'})
  assert.throws(()=>reportDecisions(output(proof.id),[{id:'goal'}],[{source:1,user:'被替换的用户原文',answer:'原始材料已发生变化'}],{requireAll:true,evidence}),{code:'CALENDAR_PROGRESS_EVIDENCE'})
})

test('numbered evidence cannot promote an assistant claim or a partial user result to whole-goal completion', () => {
  const sources=progressSources([{id:'one',user:'今天只完成了一部分构建检查，剩余下周继续。',answer:'已完成构建脚本与归档方案全部工作。',sessionId:'s'}],[{title:'完成构建与归档',project:''}]),evidence=progressEvidence(sources)
  for(const proof of evidence){const result=JSON.stringify({items:[{id:'goal',state:'done',text:'全部完成。',evidence:proof.id}]});assert.throws(()=>reportDecisions(result,[{id:'goal'}],sources,{requireAll:true,evidence}),{code:'CALENDAR_PROGRESS_EVIDENCE'})}
})
