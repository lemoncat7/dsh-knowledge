import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../worklog/store.js'
import { JournalService } from '../worklog/service.js'
import { createCentral } from '../worklog/central.js'
import { worklogTools } from '../lib/worklog-tools.js'
import { knowledgeEntry } from '../lib/tool-entry.js'

const query = value=>new URLSearchParams(value)
function fixture(t,current=()=>({backend:'local'}),request) {
  const store = new Store(':memory:');t.after(()=>store.close())
  const worker = {active:false};const service = new JournalService(store,worker,async()=>[],current,request)
  const central = createCentral(store,worker,async()=>[])
  const entry = knowledgeEntry(new Map(worklogTools((...args)=>service.read(...args)).map(tool=>[tool.name,tool])))
  const exec = {agent:{session:{id:'worklog-reader'}},signal:new AbortController().signal}
  const call = (name,args={},context=exec)=>entry.execute({action:'call',tool:'knowledge_worklog_'+name,arguments:args},context).then(JSON.parse)
  return {store,service,central,entry,exec,call}
}

test('work reports are discoverable through the single entry, without data I/O',async t=>{
  const f=fixture(t);f.service.read=()=>{throw Error('must not read during discovery')}
  const list=JSON.parse(await f.entry.execute({action:'list'},f.exec))
  assert.deepEqual(list.operations.map(o=>o.name),['knowledge_worklog_list','knowledge_worklog_read'])
  const detail=JSON.parse(await f.entry.execute({action:'describe',tool:'knowledge_worklog_read'},f.exec))
  assert.deepEqual(detail.parameters.required,['day'])
  await assert.rejects(f.call('read',{day:'2026-11-14'}, {signal:f.exec.signal}),/session/)
  await assert.rejects(f.call('list',{}, {...f.exec,signal:AbortSignal.abort()}),{name:'AbortError'})
})

test('list reports by date and keyword with bounded metadata, not raw conversations or settings',async t=>{
  const f=fixture(t)
  f.store.save('2026-11-12','第一天 部署',0);f.store.save('2026-11-13','第二天 测试',0);f.store.save('2026-11-14','第三天 部署',0)
  f.store.note('2026-11-14','RAW PRIVATE CONVERSATION')
  const first=await f.call('list',{limit:1});assert.equal(first.items[0].day,'2026-11-14');assert.equal(first.nextOffset,1);assert.equal(first.total,3)
  const next=await f.call('list',{limit:1,offset:first.nextOffset});assert.equal(next.items[0].day,'2026-11-13')
  const matched=await f.call('list',{from:'2026-11-13',to:'2026-11-14',query:'部署'});assert.deepEqual(matched.items.map(r=>r.day),['2026-11-14']);assert.equal(matched.source,'local')
  assert.doesNotMatch(JSON.stringify(first),/RAW PRIVATE|markdown|provider|model|token|projects/)
  assert.equal((await f.call('list',{query:"' OR 1=1 --"})).total,0)
  await assert.rejects(f.call('list',{from:'2026-02-30'}),/日期/)
  await assert.rejects(f.call('list',{from:'2026-11-15',to:'2026-11-14'}),/开始日期/)
  await assert.rejects(f.call('list',{limit:51}));await assert.rejects(f.call('list',{offset:-1}))
})

test('read uses revision-pinned pages, distinguishes missing reports and preserves Unicode',async t=>{
  const f=fixture(t);const body='第一😀段\n[依据:source-123] 第二段'
  f.store.save('2026-11-14',body,0)
  let part=await f.call('read',{day:'2026-11-14',limit:3}),all=part.markdown
  assert.equal(part.markdown,'第一😀');assert.equal(part.source,'local')
  await assert.rejects(f.call('read',{day:'2026-11-14',offset:part.nextOffset}),/revision/)
  while(part.nextOffset!==null){part=await f.call('read',{day:'2026-11-14',offset:part.nextOffset,revision:part.revision,limit:3});all+=part.markdown}
  assert.equal(all,body)
  f.store.save('2026-11-14','新的版本',part.revision)
  await assert.rejects(f.call('read',{day:'2026-11-14',offset:1,revision:part.revision}),/已更新/)
  await assert.rejects(f.call('read',{day:'2026-11-12',offset:1,revision:1}),error=>error.status===409)
  f.store.note('2026-11-13','有素材，但没有日报')
  const missing=await f.call('read',{day:'2026-11-13'});assert.equal(missing.exists,false);assert.equal(missing.status,'not_generated')
  await assert.rejects(f.call('read',{day:'2026-11-14',offset:100,revision:part.revision+1}),/范围/)
})

test('the tool follows the selected remote, never local fallback, and cannot issue mutations',async t=>{
  let calls=[];const connection={backend:'remote',remoteUrl:'https://central.test/knowledge',remoteToken:'private-token'}
  const f=fixture(t,()=>connection,async(c,method,path,data,q,signal)=>{calls.push({method,path,q:Object.fromEntries(q)});assert.equal(c.remoteToken,'private-token');assert.equal(data,undefined);assert.equal(signal,f.exec.signal);return {items:[],total:0,nextOffset:null}})
  f.store.save('2026-11-14','LOCAL MUST NOT LEAK',0)
  const result=await f.call('list');assert.equal(result.source,'remote');assert.equal(result.total,0)
  assert.deepEqual(calls,[{method:'GET',path:'/reports',q:{}}])
  f.service.request=async()=>{throw Object.assign(Error('remote read denied'),{status:403})}
  await assert.rejects(f.call('read',{day:'2026-11-14'}),/denied/)
  await assert.rejects(f.service.read('/save',query({}),f.exec.signal),/不支持/)
  await assert.rejects(f.call('list',{method:'POST'}),/additional/)
})

test('cancellation and connection or credential changes discard in-flight results',async t=>{
  let connection={backend:'remote',remoteUrl:'https://central.test/',remoteToken:'first'}
  let finish;const f=fixture(t,()=>connection,()=>new Promise(resolve=>{finish=resolve}))
  let pending=f.call('list');connection={...connection,remoteToken:'changed'};finish({items:[{secret:'do not return'}]});await assert.rejects(pending,/连接已变化/)
  const controller=new AbortController();pending=f.call('list',{}, {...f.exec,signal:controller.signal});controller.abort();finish({items:[]});await assert.rejects(pending,{name:'AbortError'})
  f.service.request=async()=>{controller.abort();throw Error('transport error')}
  await assert.rejects(f.service.read('/reports',query({}),controller.signal),{name:'AbortError'})
  connection={...connection,paused:true};await assert.rejects(f.call('list'),/连接正在切换/)
})
