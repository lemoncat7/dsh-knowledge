import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../worklog/store.js'
import {Worker} from '../worklog/worker.js'
const day='2026-11-24',route={provider:'fixture',model:'fixture'}
function setup(path=':memory:'){
 const s=new Store(path),goals=['学习构建','梳理归档'].map(title=>s.calendar.mutate('create',{requestId:randomUUID(),event:{title,day}}).event)
 s.insert({id:'source',day,project:'',sessionId:'s',user:'核对实际构建流程',answer:'已核对实际构建参数和归档规则，整体方案尚未实施。',route});s.reportProgress.configure(true);s.save(day,'已核对构建参数和归档',0,['source'],false,route);return {s,goals}
}
function output(request,text='已核对构建参数和归档规则，整体方案尚未实施。'){
 const m=JSON.parse(request.messages[0].content[0].text),proof=m.evidence.find(e=>e.field==='answer')
 return JSON.stringify({items:m.goals.map(g=>({id:g.id,state:'progress',text,evidence:proof.id}))})
}
const llm=mutate=>({async *stream(request){await mutate?.(request);yield {type:'text-delta',text:output(request)}}})
const tick=(s,model=llm())=>s.reportProgress.tick(model,new AbortController().signal)
const progress=(s,g)=>s.calendar.goalProgress(g.id,day).progress
const due=s=>s.db.prepare('UPDATE calendar_report_jobs SET due=0 WHERE status=\'queued\'').run()

test('disabling and re-enabling while a review is in flight cancels its stale result',async t=>{
 const {s,goals}=setup();t.after(()=>s.close())
 await tick(s,llm(()=>{s.reportProgress.configure(false);s.reportProgress.configure(true)}))
 assert.equal(s.reportProgress.status().last.status,'skipped')
 assert.ok(goals.every(g=>progress(s,g).revision===0))
 s.reportProgress.recheck({from:day,to:day});await tick(s);assert.ok(goals.every(g=>progress(s,g).revision===1))
})

test('a slower concurrent database client cannot turn a completed review back into a retry',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'calendar-race-')),path=join(dir,'db.sqlite'),{s,goals}=setup(path),other=new Store(path)
 t.after(()=>{other.close();s.close();rmSync(dir,{recursive:true,force:true})})
 let release,entered;const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r)
 const slow=tick(s,llm(async()=>{entered();await waiting}));await started
 await tick(other);release();await slow
 assert.equal(s.reportProgress.status().last.status,'done')
 assert.ok(goals.every(g=>progress(s,g).revision===1))
})

test('repeated review requests and concurrent ticks coalesce without duplicate model calls',async t=>{
 const {s,goals}=setup();t.after(()=>s.close());let calls=0,release;const gate=new Promise(r=>release=r)
 const model=llm(async()=>{calls++;await gate})
 for(let i=0;i<100;i++)assert.equal(s.reportProgress.recheck({from:day,to:day}).queued,0)
 const first=tick(s,model);const duplicates=Array.from({length:100},()=>tick(s,model));release();await Promise.all([first,...duplicates])
 assert.equal(calls,1);assert.ok(goals.every(g=>progress(s,g).revision===1))
})

test('failed writes roll back the entire batch, stop at three attempts, and recover through explicit retry',async t=>{
 const {s,goals}=setup();t.after(()=>s.close());const original=s.calendar.writeProgress.bind(s.calendar);let calls=0
 s.calendar.writeProgress=(...args)=>{if(++calls%2===0)throw Error('injected write failure');return original(...args)}
 for(let i=0;i<3;i++){due(s);await tick(s);assert.ok(goals.every(g=>progress(s,g).revision===0));assert.equal(s.db.prepare('SELECT count(*) AS n FROM calendar_report_notes').get().n,0)}
 assert.equal(s.reportProgress.status().last.status,'failed');await tick(s);assert.equal(calls,6)
 s.calendar.writeProgress=original;assert.equal(s.reportProgress.recheck({from:day,to:day}).queued,1);await tick(s);assert.equal(s.reportProgress.status().last.status,'done');assert.ok(goals.every(g=>progress(s,g).revision===1))
})

test('model faults never partly commit and a later valid retry recovers across 120 deterministic cases',async()=>{
 const faults=['empty','missing','unknown','malformed','network','truncated','manual-clear','new-report']
 for(let seed=0;seed<120;seed++){
  const {s,goals}=setup();try{
   const kind=faults[seed%faults.length],model={async *stream(request){const valid=JSON.parse(output(request));if(kind==='network')throw Error('network interrupted');if(kind==='empty')valid.items=[];if(kind==='missing')valid.items.pop();if(kind==='unknown')valid.items[1].evidence='missing';if(kind==='manual-clear')s.calendar.mutate('progress-write',{requestId:randomUUID(),id:goals[0].id,day,revision:0,text:'用户草稿'}),s.calendar.mutate('progress-write',{requestId:randomUUID(),id:goals[0].id,day,revision:1,text:''});if(kind==='new-report')s.save(day,'新的日报修订',1,['source'],false,route);yield {type:'text-delta',text:kind==='malformed'?'not JSON':JSON.stringify(valid)};if(kind==='truncated')yield {type:'finish',reason:{kind:'length'}}}}
   await tick(s,model)
   assert.equal(progress(s,goals[1]).revision,0,'seed '+seed)
   if(kind==='manual-clear')assert.equal(progress(s,goals[0]).revision,2)
   else assert.equal(progress(s,goals[0]).revision,0,'seed '+seed)
   assert.notEqual(s.reportProgress.status().last.status,'done','seed '+seed)
   due(s);await tick(s);assert.equal(s.reportProgress.status().last.status,'done','seed '+seed);assert.equal(progress(s,goals[1]).revision,1)
   if(kind==='manual-clear')assert.equal(progress(s,goals[0]).text,'')
  }finally{s.close()}
 }
})

test('repeated database reopen and report revisions keep one daily note, preserve manual clears, and leave idle ticks read-only',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'calendar-restart-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));let {s,goals}=setup(path)
 try{
  for(let i=0;i<12;i++){
   await tick(s);const revision=progress(s,goals[0]).revision
   s.close();s=new Store(path);assert.equal(progress(s,goals[0]).revision,revision)
   const report=s.report(day);s.save(day,'日报修订 '+i,report.revision,['source'],false,route)
  }
  await tick(s);assert.equal(s.db.prepare('SELECT count(*) AS n FROM calendar_goal_progress').get().n,2)
  const prior=s.db.prepare('SELECT total_changes() AS n').get().n;let calls=0
  for(let i=0;i<10000;i++)await tick(s,llm(()=>calls++))
  assert.equal(calls,0);assert.equal(s.db.prepare('SELECT total_changes() AS n').get().n,prior)
  assert.equal(s.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
 }finally{s.close()}
})

test('a worker interrupted during inference restarts from the queued job without writing the old result',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'calendar-shutdown-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));let {s,goals}=setup(path),entered
 const started=new Promise(r=>entered=r),model={async *stream(request){entered();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));yield {type:'text-delta',text:output(request)}}}
 const worker=new Worker(s,model),running=worker.tick();await started;await worker.close();await running;assert.ok(goals.every(g=>progress(s,g).revision===0));s.close()
 s=new Store(path);const replacement=new Worker(s,llm());try{await replacement.tick();assert.ok(goals.every(g=>progress(s,g).revision===1));assert.equal(s.reportProgress.status().last.status,'done')}finally{await replacement.close();s.close()}
})

test('same-millisecond rechecks have a new identity, so an older result cannot complete a new request',async t=>{
 t.mock.method(Date,'now',()=>Date.parse(day+'T02:00:00Z'))
 const dir=mkdtempSync(join(tmpdir(),'calendar-aba-')),path=join(dir,'db.sqlite'),{s,goals}=setup(path),other=new Store(path)
 t.after(()=>{other.close();s.close();rmSync(dir,{recursive:true,force:true})})
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r)
 const slow=tick(s,llm(async request=>{assert.equal(request.reviewId,undefined);entered();await gate}));await started
 await tick(other,{async *stream(request){const m=JSON.parse(request.messages[0].content[0].text);yield {type:'text-delta',text:JSON.stringify({items:m.goals.map(g=>({id:g.id,state:'none',reason:'本次没有可记录的直接目标进展依据。'}))})}}})
 assert.equal(other.reportProgress.recheck({from:day,to:day}).queued,1)
 release();await slow
 assert.equal(s.reportProgress.status().last.status,'queued');assert.ok(goals.every(g=>progress(s,g).revision===0))
 await tick(s);assert.ok(goals.every(g=>progress(s,g).revision===1))
})

test('multiple model batches commit atomically and a failed middle batch recovers without duplicate notes',async t=>{
 const s=new Store(':memory:');t.after(()=>s.close());const goals=Array.from({length:81},(_,i)=>s.calendar.mutate('create',{requestId:randomUUID(),event:{title:'构建核对 '+i,day}}).event)
 s.insert({id:'batch-source',day,project:'',sessionId:'s',user:'核对所有构建入口',answer:'已经核对了这些目标所需的实际构建参数。',route});s.reportProgress.configure(true);s.save(day,'构建参数已核对',0,['batch-source'],false,route)
 let calls=0
 const fault={async *stream(request){if(++calls===2)throw Error('middle batch interrupted');yield {type:'text-delta',text:output(request)}}}
 await tick(s,fault);assert.equal(calls,2);assert.ok(goals.every(g=>progress(s,g).revision===0));assert.equal(s.reportProgress.status().last.status,'queued')
 due(s);const model=llm(()=>calls++);await tick(s,model);assert.equal(calls,5);assert.ok(goals.every(g=>progress(s,g).revision===1));assert.equal(s.db.prepare('SELECT count(*) AS n FROM calendar_goal_progress').get().n,81)
})

test('a delayed Friday review is shared by workday carries after a multi-day restart, without weekend progress',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'calendar-workday-restart-')),path=join(dir,'db.sqlite'),friday='2026-11-20';t.after(()=>rmSync(dir,{recursive:true,force:true}))
 let s=new Store(path)
 try{
  const goal=s.calendar.mutate('create',{requestId:randomUUID(),event:{title:'工作日构建跟进',day:friday,carryMode:'workdays'}}).event
  s.insert({id:'friday-source',day:friday,project:'',sessionId:'s',user:'核对当前编译入口',answer:'已阅读并核对构建入口，后续验收尚未完成。',route});s.reportProgress.configure(true);s.save(friday,'构建入口核对',0,['friday-source'],false,route)
  s.close();s=new Store(path);s.calendar.carryGoals(Date.parse('2026-11-25T09:00:00+08:00'))
  await tick(s)
  const latest=s.calendar.dayGoals('2026-11-25','Asia/Shanghai').find(g=>g.title===goal.title);assert.ok(latest)
  assert.equal(s.calendar.goalProgress(latest.id,friday).progress.revision,1);assert.equal(s.calendar.goalProgress(latest.id,'2026-11-21').progress.revision,0);assert.equal(s.calendar.goalProgress(latest.id,'2026-11-22').progress.revision,0)
  assert.equal(s.calendar.progressHistory(latest.id).items.length,1);assert.equal(s.calendar.progressHistory(latest.id).items[0].day,friday)
 }finally{s.close()}
})

test('a missing-only retry reports its own scope without implying that the whole day had no progress',async t=>{
 const {s,goals}=setup();t.after(()=>s.close());await tick(s)
 s.calendar.mutate('progress-write',{requestId:randomUUID(),id:goals[1].id,day,revision:1,text:''})
 const original=progress(s,goals[0]).text;assert.equal(s.reportProgress.recheck({from:day,to:day}).queued,1);await tick(s)
 assert.equal(progress(s,goals[0]).text,original);assert.match(s.reportProgress.status().last.message,/已有记录保留/);assert.doesNotMatch(s.reportProgress.status().last.message,/当天没有直接进展依据/)
})
