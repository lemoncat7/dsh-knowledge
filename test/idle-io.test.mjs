import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {NoteStore} from '../lib/notes/store.js'
import {NoteReplica} from '../lib/notes/replica.js'
import {NoteVault} from '../lib/notes/vault.js'
import {WritebackQueue} from '../lib/writeback/queue.js'
import {sqliteRevision} from '../lib/storage/sqlite-revision.js'

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'knowledge-idle-')),server=new NoteStore(join(root,'server'))
 let requests=0,reads=0,corrupt=false
 const path=join(root,'replica.sqlite')
 const replica=new NoteReplica(path,async(route,method,body)=>{
  if(route==='note-sync'){
   requests++
   if(method==='POST')return server.applySyncChange('client',body)
   const manifest=server.syncManifest();if(corrupt)manifest.nodes=[];return manifest
  }
  reads++;return (await server.read(route.split('/')[1])).content
 },false)
 const observer=new DatabaseSync(path)
 t.after(async()=>{observer.close();await replica.close();await server.close();await rm(root,{recursive:true,force:true})})
 return {root,server,replica,observer,corrupt:()=>{corrupt=true},counts:()=>({requests,reads})}
}

test('unchanged remote sync needs one manifest, no body reads, no SQLite commits',async t=>{
 const f=await fixture(t)
 const n=await f.server.createDocument('note',null,'body')
 await f.replica.sync()
 const before=sqliteRevision(f.observer),counts=f.counts(),wal=await stat(join(f.root,'replica.sqlite-wal'),{bigint:true})
 for(let i=0;i<10;i++)await f.replica.sync()
 assert.equal(sqliteRevision(f.observer),before)
 assert.equal(f.counts().requests-counts.requests,10);assert.equal(f.counts().reads,counts.reads)
 const after=await stat(join(f.root,'replica.sqlite-wal'),{bigint:true})
 assert.equal(after.mtimeNs,wal.mtimeNs);assert.equal(after.size,wal.size)
 assert.equal(f.replica.read(n.id).content.toString(),'body')
})

test('remote tombstones are applied once, then idle sync stops rewriting them',async t=>{
 const f=await fixture(t),n=await f.server.createDocument('note',null,'body')
 await f.replica.sync();await f.server.delete(n.id);await f.replica.sync()
 assert.equal(f.replica.get(n.id),undefined)
 const before=sqliteRevision(f.observer)
 for(let i=0;i<5;i++)await f.replica.sync()
 assert.equal(sqliteRevision(f.observer),before)
 assert.ok(f.replica.versions(n.id).some(v=>v.version===1),'deletion must preserve the stored history')
})

test('a truncated manifest cannot turn cached notes into deletions',async t=>{
 const f=await fixture(t),n=await f.server.createDocument('note',null,'body')
 await f.replica.sync();f.corrupt();await f.replica.sync()
 assert.equal(f.replica.read(n.id).content.toString(),'body')
 assert.match(f.replica.status().message,/清单不完整|校验失败/)
})

test('manifest cache detaches callers and sees local writes and another SQLite connection',async t=>{
 const f=await fixture(t),n=await f.server.createDocument('note',null,'body')
 const first=f.server.syncManifest();first.nodes.length=0
 assert.equal(f.server.syncManifest().nodes.length,1)
 await f.server.updateContent(n.id,Buffer.from('changed'))
 assert.notEqual(f.server.syncManifest().revision,first.revision)
 const other=new NoteStore(join(f.root,'server'))
 try{other.rename(n.id,'renamed.md');assert.equal(f.server.syncManifest().nodes[0].name,'renamed.md')}finally{await other.close()}
})

test('a manifest observed inside a rolled-back transaction is never cached',async t=>{
 const f=await fixture(t),n=await f.server.createDocument('note',null,'body'),before=f.server.syncManifest()
 f.server.db.exec('BEGIN IMMEDIATE')
 f.server.db.prepare('UPDATE note_nodes SET name=? WHERE id=?').run('temporary.md',n.id)
 assert.equal(f.server.syncManifest().nodes[0].name,'temporary.md')
 f.server.db.exec('ROLLBACK')
 assert.deepEqual(f.server.syncManifest(),before)
})

test('vault idle backoff retains change capture and never rereads unchanged bodies',async t=>{
 const f=await fixture(t),n=await f.server.createDocument('note',null,'body')
 let reads=0,now=10000
 const path=join(f.root,'vault'),index=join(f.root,'index.json')
 const vault=new NoteVault(path,{all:()=>f.server.syncManifest().nodes,read:id=>{reads++;return f.server.read(id)},
  readVersion:(id,v)=>f.server.readVersion(id,v),update:(id,b,v)=>f.server.updateContent(id,b,v),
  relocate:(...args)=>f.server.relocate(...args),create:(kind,name,parent,b)=>kind==='folder'?f.server.createFolder(name,parent):f.server.createDocument(name,parent,Buffer.from(b).toString())},
  index,false,{stableMs:1000,missingMs:30000,now:()=>now})
 t.after(()=>vault.close())
 for(let i=0;i<8;i++){now+=1100;await vault.scan()}
 const before=await stat(index,{bigint:true}),bodyReads=reads
 assert.ok(vault.idleScans>=3)
 for(let i=0;i<5;i++){now+=1100;await vault.scan()}
 assert.equal(reads,bodyReads);assert.equal((await stat(index,{bigint:true})).mtimeNs,before.mtimeNs)
 await writeFile(join(path,'note.md'),'external');now+=1100;await vault.scan()
 assert.equal(vault.idleScans,0)
 now+=1100;await vault.scan();assert.equal((await f.server.read(n.id)).content.toString(),'external')
 assert.equal(await readFile(join(path,'note.md'),'utf8'),'external')
})

test('an empty outbox claims no write transaction and leaves its WAL untouched',async t=>{
 const root=await mkdtemp(join(tmpdir(),'outbox-idle-')),path=join(root,'q.sqlite')
 const queue=new WritebackQueue(path,async()=>assert.fail('empty queue must not execute'))
 t.after(async()=>{await queue.close();await rm(root,{recursive:true,force:true})})
 const observer=new DatabaseSync(path)
 try{
  const revision=sqliteRevision(observer),wal=await stat(path+'-wal',{bigint:true})
  for(let i=0;i<10;i++)await queue.drain()
  assert.equal(sqliteRevision(observer),revision)
  const after=await stat(path+'-wal',{bigint:true})
  assert.equal(after.mtimeNs,wal.mtimeNs);assert.equal(after.size,wal.size)
 }finally{observer.close()}
})
test('empty outbox polling slows down, but enqueue wakes work without waiting for the idle timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let claims=0,executions=0
 const queue=new WritebackQueue(':memory:',async()=>{executions++;return {status:'completed',summary:'done',retryable:false}})
 const original=queue.claim.bind(queue);queue.claim=()=>{claims++;return original()}
 try{
  queue.start();await queue.active;assert.equal(claims,1)
  t.mock.timers.tick(2000);await Promise.resolve();assert.equal(claims,1)
  queue.enqueue({destination:'local:test',snapshot:{sourceKey:'test:1',sessionId:'test',turn:1,userText:'saved',assistantText:'done',userTextTruncated:false}})
  await queue.active;assert.equal(executions,1)
  const idleClaims=claims
  t.mock.timers.tick(30000);await queue.active;assert.equal(claims,idleClaims+1)
 }finally{await queue.close();t.mock.timers.reset()}
})
