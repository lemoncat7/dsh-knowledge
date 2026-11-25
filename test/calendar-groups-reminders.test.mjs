import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { ICloudSync } from '../worklog/calendar/icloud-sync.js'
import { decodeEvent, encodeEvent, projection } from '../worklog/calendar/caldav.js'
import { calendarIcs } from '../worklog/calendar/ical.js'
import { addDays } from '../worklog/calendar/time.js'
import { JournalService } from '../worklog/service.js'
import { knowledgeEntry, KNOWLEDGE_ENTRY_GUIDE } from '../lib/tool-entry.js'
import { calendarTools } from '../lib/calendar-tools.js'

const account='fixture@example.test', password='aaaa-bbbb-cccc-dddd'
const urls=['work','personal','read-only'].map(name=>'https://p12-caldav.icloud.com/123/calendars/'+name+'/')
const signal=()=>new AbortController().signal
const create=(c,more={})=>c.mutate('create',{requestId:randomUUID(),event:{title:'测试条目',day:c.info().today,...more}}).event
const update=(c,id,patch)=>c.mutate('update',{requestId:randomUUID(),id,revision:c.get(id).revision,patch}).event
const remove=(c,id)=>c.mutate('delete',{requestId:randomUUID(),id,revision:c.get(id).revision}).event
function fixture(t) {
  const store=new Store(':memory:');t.after(()=>store.close());return store
}
function groups(c) { return c.configureGroups({revision:c.groups().revision,items:[...c.groups().items,{id:'personal',name:'个人',color:'purple'}]}) }
async function syncFixture(t) {
  const store=fixture(t), c=store.calendar, entries=new Map(), calls=[]
  let sequence=0
  const put=(url,uid,fields,kind='event')=>{const href=url+encodeURIComponent(uid)+'.ics';entries.set(href,{href,etag:'"'+(++sequence)+'"',data:encodeEvent(uid,fields,Date.now(),undefined,kind)});return href}
  const client={
    async discover(){calls.push('discover');return urls.map((id,i)=>({id,name:['工作','个人','共享只读'][i],...(i===2?{writable:false}:{})}))},
    async list(url){calls.push('list:'+url);return {calendar:url,entries:[...entries.values()].filter(e=>e.href.startsWith(url))}},
    async put(href,data,etag){assert.equal(entries.get(href)?.etag??null,etag);calls.push('put:'+href);entries.set(href,{href,data,etag:'"'+(++sequence)+'"'})},
    async remove(href,etag){assert.equal(entries.get(href)?.etag,etag);calls.push('delete:'+href);entries.delete(href)},
  }
  const sync=new ICloudSync(store,undefined,()=>client)
  await sync.connect({account,password,calendar:urls[0]},signal());sync.toggle(true)
  return {store,c,sync,client,entries,calls,put}
}
const fields=(c,title='远程')=>({title,allDay:true,day:c.info().today,endDay:addDays(c.info().today,1),description:''})

test('calendar groups preserve stable event/progress identity and reject stale edits and nonempty removal',t=>{
  const c=fixture(t).calendar, goal=create(c), before=c.info().cursor
  const configured=groups(c);assert.equal(configured.revision,1);assert.equal(c.info().cursor,before)
  update(c,goal.id,{groupId:'personal'})
  c.mutate('progress-write',{requestId:randomUUID(),id:goal.id,day:goal.day,revision:0,text:'已完成第一步'})
  c.configureGroups({revision:1,items:configured.items.map(group=>({...group,name:group.id==='personal'?'私事':group.name}))})
  assert.equal(c.goalProgress(goal.id,goal.day).progress.text,'已完成第一步')
  assert.throws(()=>c.configureGroups(configured),e=>e.status===409)
  assert.throws(()=>c.configureGroups({revision:2,items:[configured.items[0]]}),/仍有条目/)
  assert.throws(()=>c.configureGroups({revision:2,items:[{id:'personal',name:'个人',color:'purple'}]}),/默认分组/)
  assert.throws(()=>create(c,{groupId:'unknown'}),/不存在/)
  assert.equal(c.get(goal.id).id,goal.id)
})

test('event and reminder types never carry forward or enter goal progress; combined filters paginate correctly',t=>{
  const c=fixture(t).calendar;groups(c)
  const day=addDays(c.info().today,-1), remindAt=day+'T09:15:00+08:00'
  const goal=create(c,{day}), reminder=create(c,{day,kind:'reminder',groupId:'personal',tags:['体检'],remindAt}), event=create(c,{day,kind:'event'})
  assert.equal(c.carryGoals(Date.now()),1)
  assert.ok(c.dayGoals(c.info().today,'Asia/Shanghai').some(e=>e.carriedFrom.id===goal.id))
  assert.throws(()=>c.goalProgress(reminder.id,day),/仅适用于目标/)
  const result=c.list(new URLSearchParams({from:day,to:addDays(day,1),groupId:'personal',kind:'reminder',tag:'体检'}))
  assert.deepEqual(result.items.map(e=>e.id),[reminder.id]);assert.equal(c.get(event.id).kind,'event')
})

test('due reminders are durable, versioned by reminder time, idempotently acknowledged, and read without writes',t=>{
  const c=fixture(t).calendar, now=Date.now(), event=create(c,{kind:'reminder',remindAt:new Date(now-1000).toISOString()})
  const next=create(c,{kind:'event',remindAt:new Date(now+60000).toISOString()})
  const before=c.db.prepare('select total_changes() as n').get().n
  for(let i=0;i<10000;i++) { const result=c.reminders(now);assert.equal(result.total,1);assert.equal(result.nextAt,next.remindAt) }
  assert.equal(c.db.prepare('select total_changes() as n').get().n,before)
  const data={requestId:randomUUID(),calendarId:c.calendarId,id:event.id,remindAt:event.remindAt}
  c.mutate('reminder-ack',data,now);assert.equal(c.mutate('reminder-ack',data,now).replayed,true)
  assert.equal(c.reminders(now).total,0);assert.equal(c.get(event.id).status,'planned')
  const rescheduled=update(c,event.id,{remindAt:new Date(now-2000).toISOString()})
  assert.equal(c.reminders(now).total,1)
  assert.throws(()=>c.mutate('reminder-ack',{...data,requestId:randomUUID()},now),/改期/)
  remove(c,rescheduled.id);assert.equal(c.reminders(now).total,0)
  update(c,next.id,{status:'done'});assert.equal(c.reminders(now+120000).total,0)
})

test('acknowledged reminders stay acknowledged after database reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'calendar-reminders-')),file=join(dir,'worklog.sqlite');let store
  try {
    store=new Store(file);const c=store.calendar,e=create(c,{kind:'reminder',remindAt:new Date(Date.now()-1000).toISOString()})
    c.mutate('reminder-ack',{requestId:randomUUID(),id:e.id,remindAt:e.remindAt});store.close()
    store=new Store(file);assert.equal(store.calendar.reminders().total,0);assert.equal(store.calendar.get(e.id).status,'planned')
  }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
})

test('knowledge entry persists explicit goal/event/reminder requests with group and exact notification time',async t=>{
  const store=fixture(t),c=store.calendar;groups(c)
  const service=new JournalService(store,{},async()=>[]),entry=knowledgeEntry(new Map(calendarTools((...a)=>service.calendar(...a)).map(tool=>[tool.name,tool])))
  const exec={agent:{session:{id:'fixture'}},signal:signal()},call=async args=>JSON.parse(await entry.execute({action:'call',tool:'knowledge_calendar',arguments:args},exec))
  assert.match(KNOWLEDGE_ENTRY_GUIDE,/提醒我/)
  const info=await call({action:'info'});assert.ok(info.groups.items.some(group=>group.id==='personal'))
  const result=await call({action:'create',calendarId:info.calendarId,requestId:randomUUID(),event:{kind:'reminder',groupId:'personal',title:'提醒体检',day:info.today,remindAt:info.today+'T09:00:00+08:00'}})
  assert.equal(result.event.remindAt,Date.parse(info.today+'T09:00:00+08:00'))
  assert.equal((await call({action:'list',from:info.today,to:addDays(info.today,1),groupId:'personal',kind:'reminder'})).total,1)
  await assert.rejects(call({action:'create',requestId:randomUUID(),event:{title:'错时区',day:info.today,remindAt:info.today+'T09:00'}}),/UTC|时区/)
})

test('absolute and relative iCalendar alarms round-trip, clear explicitly, and preserve foreign alarms on text edits',t=>{
  const c=fixture(t).calendar, now=Date.now(), event=create(c,{kind:'reminder',remindAt:c.info().today+'T09:00:00+08:00'})
  const encoded=encodeEvent(event.uid,projection(event),now,undefined,'reminder')
  assert.match(encoded,/BEGIN:VALARM/);assert.equal(decodeEvent({data:encoded},'Asia/Shanghai').fields.remindAt,event.remindAt)
  assert.equal(decodeEvent({data:encoded},'Asia/Shanghai').kind,'reminder')
  const edited=encodeEvent(event.uid,{...projection(event),title:'新标题'},now,encoded,'reminder')
  assert.equal((edited.match(/BEGIN:VALARM/g)||[]).length,1)
  const {remindAt,...plain}=projection(event)
  assert.doesNotMatch(encodeEvent(event.uid,plain,now,edited),/BEGIN:VALARM/)
  assert.match(calendarIcs([event]),/TRIGGER;VALUE=DATE-TIME:/)
  const relative=encoded.replace(/TRIGGER[^\r\n]*/, 'TRIGGER:-PT15M')
  assert.equal(decodeEvent({data:relative},'Asia/Shanghai').fields.remindAt,Date.parse(event.day+'T00:00:00+08:00')-15*60000)
})

test('normal local deletion propagates once and local restore recreates the same remote UID',async t=>{
  const {c,sync,entries,calls}=await syncFixture(t),e=create(c)
  await sync.begin(true);await sync.begin(true);assert.equal(entries.size,1)
  remove(c,e.id);await sync.begin(true);assert.equal(entries.size,0);assert.equal(sync.status().issues.length,0)
  await sync.begin(true);assert.equal(calls.filter(call=>call.startsWith('delete:')).length,1)
  c.mutate('restore',{requestId:randomUUID(),id:e.id,revision:c.get(e.id).revision});await sync.begin(true)
  assert.equal(entries.size,1);assert.equal(decodeEvent([...entries.values()][0],'Asia/Shanghai').uid,e.uid)
  await sync.begin(true);assert.equal(sync.status().issues.length,0)
})

test('normal remote deletion moves unchanged local event to trash and later remote restore restores it',async t=>{
  const {c,sync,entries,put}=await syncFixture(t),e=create(c)
  await sync.begin(true);await sync.begin(true);const original=[...entries.values()][0];entries.delete(original.href)
  await sync.begin(true);const deleted=c.get(e.id);assert.ok(deleted.deletedAt);assert.equal(sync.status().issues.length,0)
  put(urls[0],e.uid,projection(e),'goal');await sync.begin(true)
  assert.equal(c.get(e.id).deletedAt,null);assert.equal(entries.size,1);assert.equal(c.get(e.id).id,e.id)
})

test('delete-versus-edit and ETag races are retained as conflicts, not silently deleted',async t=>{
  const {c,sync,entries,put,client}=await syncFixture(t),e=create(c)
  await sync.begin(true);await sync.begin(true);remove(c,e.id)
  put(urls[0],e.uid,fields(c,'远端新修改'),'goal');await sync.begin(true)
  assert.equal(entries.size,1);const issue=sync.status().issues[0];assert.equal(issue.type,'local-missing')
  sync.resolve({uid:issue.uid,key:issue.key,choice:'remove-icloud',groupId:'default'})
  client.remove=async()=>{throw Object.assign(Error('version changed'),{status:409})}
  await sync.begin(true);assert.equal(entries.size,1);assert.equal(sync.status().issues[0].type,'local-missing')
})

test('remote deletion does not discard local edits and can explicitly restore the remote version',async t=>{
  const {c,sync,entries}=await syncFixture(t),e=create(c)
  await sync.begin(true);await sync.begin(true);entries.clear();update(c,e.id,{title:'本端改动'})
  await sync.begin(true);assert.equal(c.get(e.id).deletedAt,null);const issue=sync.status().issues[0]
  assert.equal(issue.type,'remote-missing')
  sync.resolve({uid:issue.uid,key:issue.key,choice:'restore-icloud',groupId:'default'});await sync.begin(true)
  assert.equal(entries.size,1);assert.equal(decodeEvent([...entries.values()][0],'Asia/Shanghai').fields.title,'本端改动')
})

test('multiple group calendars are isolated; disabled and directional mappings honor their scope',async t=>{
  const {c,sync,entries,put,calls}=await syncFixture(t);groups(c)
  create(c,{title:'工作目标'});create(c,{title:'私事',groupId:'personal',kind:'reminder',remindAt:c.info().today+'T10:00:00+08:00'})
  let revision=sync.status().revision
  await sync.configureMappings({revision,mappings:[{groupId:'default',calendar:urls[0],direction:'both'},{groupId:'personal',calendar:urls[1],direction:'push'}]},signal())
  put(urls[1],'outside@icloud',fields(c,'远程私事'))
  await sync.begin(true);assert.equal([...entries.keys()].filter(href=>href.startsWith(urls[0])).length,1);assert.equal([...entries.keys()].filter(href=>href.startsWith(urls[1])).length,2)
  assert.equal(c.list(new URLSearchParams({from:c.info().today,to:addDays(c.info().today,1),query:'远程私事'})).total,0)
  const remotePersonal=[...entries.values()].filter(entry=>entry.href.startsWith(urls[1])).map(entry=>decodeEvent(entry,'Asia/Shanghai'))
  assert.ok(remotePersonal.some(entry=>entry.fields.title==='私事' && entry.fields.remindAt))
  revision=sync.status().revision
  await sync.configureMappings({revision,mappings:[{groupId:'default',calendar:urls[0],direction:'off'},{groupId:'personal',calendar:urls[1],direction:'pull'}]},signal())
  const before=calls.length;await sync.begin(true);assert.ok(!calls.slice(before).includes('list:'+urls[0]))
  assert.equal(c.list(new URLSearchParams({from:c.info().today,to:addDays(c.info().today,1),groupId:'personal',query:'远程私事'})).total,1)
})

test('saved-account discovery is cached, never leaks secrets, and mappings validate revision/duplicates/read-only',async t=>{
  const {c,sync,calls}=await syncFixture(t);groups(c)
  await sync.calendars(signal());await sync.calendars(signal());assert.equal(calls.filter(call=>call==='discover').length,2)
  const revision=sync.status().revision
  assert.equal(JSON.stringify(sync.status()).includes(password),false)
  await assert.rejects(sync.configureMappings({revision:revision-1,mappings:[]},signal()),/已变化/)
  await assert.rejects(sync.configureMappings({revision,mappings:[{groupId:'default',calendar:urls[2],direction:'both'}]},signal()),/只读/)
  await assert.rejects(sync.configureMappings({revision,mappings:[{groupId:'default',calendar:urls[0],direction:'both'},{groupId:'personal',calendar:urls[0],direction:'pull'}]},signal()),/只能关联一次/)
  await sync.configureMappings({revision,mappings:[{groupId:'personal',calendar:urls[2],direction:'pull'}]},signal())
  assert.equal(sync.status().mappings[0].direction,'pull')
})

test('unchanged sync does not rewrite bindings or add event revisions',async t=>{
  const {c,sync}=await syncFixture(t);create(c)
  await sync.begin(true);await sync.begin(true)
  const before=c.info().cursor, bodies=c.db.prepare('select body from calendar_icloud').all()
  const writes=[];const save=sync.saveBinding.bind(sync);sync.saveBinding=(...args)=>{const n=c.db.prepare('select total_changes() as n').get().n;save(...args);writes.push(c.db.prepare('select total_changes() as n').get().n-n)}
  for(let i=0;i<10;i++)await sync.begin(true)
  assert.equal(c.info().cursor,before);assert.deepEqual(c.db.prepare('select body from calendar_icloud').all(),bodies);assert.ok(writes.every(n=>n===0))
})

test('unknown-result deletion followed by local restore does not delete the restored event',async t=>{
  const {c,sync,entries,client}=await syncFixture(t),e=create(c)
  await sync.begin(true);await sync.begin(true);remove(c,e.id)
  client.remove=async href=>{
    entries.delete(href)
    c.mutate('restore',{requestId:randomUUID(),id:e.id,revision:c.get(e.id).revision})
    throw Error('connection lost after DELETE committed')
  }
  await sync.begin(true);assert.equal(entries.size,0);assert.equal(c.get(e.id).deletedAt,null)
  await sync.begin(true);assert.equal(entries.size,1);assert.equal(c.get(e.id).deletedAt,null);assert.equal(sync.status().issues.length,0)
})

test('unknown-result create recovers with and without a committed remote write, without duplicates',async t=>{
  for(const committed of [false,true]){
    const {c,sync,entries,client}=await syncFixture(t),e=create(c),put=client.put
    let once=true
    client.put=async(...args)=>{if(once){once=false;if(committed)await put(...args);throw Error('connection interrupted')}return put(...args)}
    await sync.begin(true);await sync.begin(true);await sync.begin(true)
    assert.equal(entries.size,1);assert.equal(c.get(e.id).deletedAt,null);assert.equal(sync.status().issues.length,0)
    assert.equal(decodeEvent([...entries.values()][0],'Asia/Shanghai').uid,e.uid)
  }
})

test('unknown-result update uses its durable base when another local edit follows',async t=>{
  const {c,sync,entries,client}=await syncFixture(t),e=create(c),put=client.put
  await sync.begin(true);await sync.begin(true);update(c,e.id,{title:'第一稿'})
  let once=true
  client.put=async(...args)=>{await put(...args);if(once){once=false;update(c,e.id,{title:'第二稿'});throw Error('lost PUT response')}}
  await sync.begin(true);await sync.begin(true);await sync.begin(true)
  assert.equal(decodeEvent([...entries.values()][0],'Asia/Shanghai').fields.title,'第二稿');assert.equal(sync.status().issues.length,0)
})

test('a failed group does not block unrelated mappings and simultaneous force-sync requests coalesce',async t=>{
  const {c,sync,client,entries}=await syncFixture(t);groups(c);create(c,{groupId:'personal'})
  await sync.configureMappings({revision:sync.status().revision,mappings:[{groupId:'default',calendar:urls[0],direction:'both'},{groupId:'personal',calendar:urls[1],direction:'both'}]},signal())
  const list=client.list;let count=0
  client.list=async url=>{count++;await new Promise(resolve=>setTimeout(resolve,5));if(url===urls[0])throw Error('one calendar offline');return list(url)}
  await Promise.all(Array.from({length:50},()=>sync.begin(true)))
  assert.equal(count,2);assert.equal(entries.size,1);assert.equal(sync.status().last.errors[0].groupId,'default')
})

test('active synced events cannot silently cross groups or reuse a populated remote calendar',async t=>{
  const {c,sync}=await syncFixture(t);groups(c);const e=create(c);await sync.begin(true)
  assert.throws(()=>update(c,e.id,{groupId:'personal'}),/解除原分组关联/)
  await assert.rejects(sync.configureMappings({revision:sync.status().revision,mappings:[{groupId:'personal',calendar:urls[0],direction:'both'}]},signal()),/已有分组关联/)
  assert.equal(c.get(e.id).groupId,'default')
})

test('multiple account calendars can atomically create distinct local groups without replacing existing groups',async t=>{
  const {c,sync}=await syncFixture(t);groups(c)
  const revision=c.groups().revision, before=c.groups().items
  await sync.configureMappings({revision:sync.status().revision,groupsRevision:revision,
    createGroups:[{id:'cloud-a',name:'旅行',color:'blue'},{id:'cloud-b',name:'共享',color:'purple'}],
    mappings:[{groupId:'default',calendar:urls[0],direction:'both'},{groupId:'cloud-a',calendar:urls[1],direction:'both'},{groupId:'cloud-b',calendar:urls[2],direction:'pull'}]},signal())
  assert.equal(c.groups().revision,revision+1);assert.deepEqual(c.groups().items.slice(0,2),before)
  assert.equal(c.groups().items.length,4);assert.equal(sync.status().mappings.length,3)
})

test('failed combined account/group save rolls back both configurations and stale groups cannot overwrite',async t=>{
  const {store,c,sync}=await syncFixture(t),beforeGroups=c.groups(),beforeSync=sync.config(),set=store.setMeta.bind(store)
  const data={revision:sync.status().revision,groupsRevision:beforeGroups.revision,createGroups:[{id:'cloud-a',name:'旅行',color:'blue'}],mappings:[{groupId:'cloud-a',calendar:urls[1],direction:'both'}]}
  store.setMeta=(key,value)=>{if(key==='calendarICloud')throw Error('simulated storage failure');set(key,value)}
  await assert.rejects(sync.configureMappings(data,signal()),/storage failure/)
  assert.deepEqual(c.groups(),beforeGroups);assert.deepEqual(sync.config(),beforeSync)
  store.setMeta=set;groups(c)
  await assert.rejects(sync.configureMappings(data,signal()),/本地分组已变化/)
  assert.equal(c.groups().items.some(group=>group.id==='cloud-a'),false)
})

test('manual account refresh bypasses the discovery cache while ordinary opens reuse it',async t=>{
  const {sync,calls}=await syncFixture(t)
  await sync.calendars(signal());const count=calls.filter(call=>call==='discover').length
  await sync.calendars(signal());assert.equal(calls.filter(call=>call==='discover').length,count)
  await sync.calendars(signal(),true);assert.equal(calls.filter(call=>call==='discover').length,count+1)
})
