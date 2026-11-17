import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {WritebackQueue} from '../lib/writeback/queue.js'
import {normalizeWritebackFrequency,storeServiceSettings,loadServiceSettings} from '../lib/service-settings.js'
const done={status:'completed',summary:'完成',retryable:false}
const work=(turn,session='a',destination='local:a',text='hello')=>({destination,snapshot:{sourceKey:`${session}:${turn}`,sessionId:session,turn,userText:`${text}${turn}`,assistantText:`answer${turn}`,userTextTruncated:false}})
const wait=async f=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,10))}assert.fail('condition timed out')}
const tick=()=>new Promise(r=>setTimeout(r,30))
test('N turns produce one call with all ordered dialogue; source receipts resolve to the same batch',async t=>{
 const calls=[]
 const queue=new WritebackQueue(':memory:',async w=>{calls.push(w);return done},()=>{},()=>({everyTurns:3,idleSeconds:60,maxChars:10000}));t.after(()=>queue.close())
 queue.enqueue(work(1));queue.enqueue(work(2));await tick();assert.equal(calls.length,0);assert.equal(queue.status('a:1').buffered,true)
 queue.enqueue(work(3));await wait(()=>queue.status('a:3').status==='completed');assert.equal(calls.length,1)
 assert.deepEqual(calls[0].snapshot.turns.map(t=>t.turn),[1,2,3]);assert.match(calls[0].snapshot.userText,/hello1[\s\S]*hello2[\s\S]*hello3/)
 queue.enqueue(work(2));await tick();assert.equal(calls.length,1)
})
test('idle timeout and manual flush retain incomplete batches; pending snapshots survive restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'frequency-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'queue.sqlite'),calls=[]
 const settings=()=>({everyTurns:5,idleSeconds:60,maxChars:10000})
 const q=new WritebackQueue(path,async w=>{calls.push(w);return done},()=>{},settings);q.enqueue(work(1));q.enqueue(work(2));await q.close();assert.equal(calls.length,0)
 const r=new WritebackQueue(path,async w=>{calls.push(w);return done},()=>{},settings);t.after(()=>r.close());r.flush('a:2');await wait(()=>r.status('a:2').status==='completed');assert.equal(calls[0].snapshot.turns.length,2)
 r.enqueue(work(3));await tick();const db=new DatabaseSync(path);db.prepare('UPDATE queue_jobs SET created_at=? WHERE source_key=?').run(Date.now()-61000,'a:3');db.close();r.start();await waitLong(()=>r.status('a:3').status==='completed');assert.equal(calls.length,2)
})
async function waitLong(f){for(let i=0;i<300;i++){if(f())return;await new Promise(r=>setTimeout(r,10))}assert.fail('idle timer did not flush')}
test('different destinations, projects, model routes and sessions never merge; size boundary flushes early',async t=>{
 const calls=[],q=new WritebackQueue(':memory:',async w=>{calls.push(w);return done},()=>{},()=>({everyTurns:5,idleSeconds:60,maxChars:80}));t.after(()=>q.close())
 q.enqueue(work(1));q.enqueue(work(2,'a','remote:x'));q.enqueue({...work(3,'a','remote:x'),snapshot:{...work(3).snapshot,projectId:'other'}})
 q.enqueue(work(1,'b'));await wait(()=>calls.length===2);assert.ok(calls.every(w=>!w.snapshot.turns));assert.equal(q.status('b:1').buffered,true)
 q.flush('a:3');q.flush('b:1');await wait(()=>q.status('b:1').status==='completed')
 q.enqueue(work(4,'a','local:a','x'.repeat(35)));q.enqueue(work(5,'a','local:a','x'.repeat(35)));await wait(()=>q.status('a:4').status==='completed');assert.equal(q.status('a:5').buffered,true)
})
test('cancelling buffered turns removes only those turns; cancelled data cannot join a later batch',async t=>{
 const calls=[],q=new WritebackQueue(':memory:',async w=>{calls.push(w);return done},()=>{},()=>({everyTurns:2,idleSeconds:60,maxChars:10000}));t.after(()=>q.close())
 q.enqueue(work(1));q.cancel('a:1');q.enqueue(work(2));await tick();assert.equal(calls.length,0);q.enqueue(work(3));await wait(()=>calls.length===1);assert.deepEqual(calls[0].snapshot.turns.map(x=>x.turn),[2,3])
})
test('defaults preserve per-turn execution; settings changes flush existing buffered work',async t=>{
 const calls=[],q=new WritebackQueue(':memory:',async w=>{calls.push(w);return done});t.after(()=>q.close());q.enqueue(work(1));await wait(()=>calls.length===1)
 let n=5;const r=new WritebackQueue(':memory:',async w=>{calls.push(w);return done},()=>{},()=>({everyTurns:n,idleSeconds:60,maxChars:10000}));t.after(()=>r.close());r.enqueue(work(2));await tick();n=1;r.start();await waitLong(()=>r.status('a:2').status==='completed');assert.equal(calls.length,2)
})
test('frequency settings validate and persist independently of the model route',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'frequency-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'settings.json')
 for(const value of [0,21,1.2,NaN,'5',null])assert.throws(()=>normalizeWritebackFrequency({extractionEveryTurns:value}))
 for(const value of [0,29,3601,Infinity])assert.throws(()=>normalizeWritebackFrequency({extractionIdleSeconds:value}))
 await storeServiceSettings(file,{publicApiEnabled:false,extractionEveryTurns:5,extractionIdleSeconds:120});assert.deepEqual(loadServiceSettings(file),{publicApiEnabled:false,extractionEveryTurns:5,extractionIdleSeconds:120})
})

test('retry resumes the frozen merged payload and aliases without a new model plan',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'frequency-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'q.sqlite');let executions=0,plans=0
 const q=new WritebackQueue(file,async(w,checkpoint)=>{executions++;assert.equal(w.snapshot.turns.length,2);if(!checkpoint.load()){plans++;checkpoint.save([])}if(executions===1)throw Error('offline');return done},()=>{},()=>({everyTurns:2,idleSeconds:60,maxChars:1000}));t.after(()=>q.close());q.enqueue(work(1));q.enqueue(work(2));await wait(()=>q.status('a:2').error==='offline')
 const db=new DatabaseSync(file);db.exec('UPDATE queue_jobs SET next_at=0');db.close();q.start();await waitLong(()=>q.status('a:2').status==='completed');assert.equal(executions,2);assert.equal(plans,1)
})

test('model route changes flush the previous group; management lists one batch with truthful status',async t=>{
 const calls=[];let release
 const gate=new Promise(r=>release=r)
 const q=new WritebackQueue(':memory:',async w=>{calls.push(w);await gate;return done},()=>{},()=>({everyTurns:3,idleSeconds:60,maxChars:10000}));t.after(()=>q.close())
 const a=work(1),b=work(2),c=work(3)
 a.snapshot.route=b.snapshot.route={provider:'a',model:'one'};c.snapshot.route={provider:'a',model:'two'}
 q.enqueue(a);q.enqueue(b);q.enqueue(c)
 try{await wait(()=>calls.length===1);assert.deepEqual(calls[0].snapshot.turns.map(x=>x.turn),[1,2]);assert.equal(q.status('a:2').status,'running');assert.equal(q.list('',0,50,'completed').total,0);assert.equal(q.listPage('','running').total,1);assert.equal(q.list().total,2)}finally{release()}
 await wait(()=>q.status('a:2').status==='completed');assert.equal(q.listPage('','completed').total,1);assert.equal(q.status('a:3').buffered,true)
})
