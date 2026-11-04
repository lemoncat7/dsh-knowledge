import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm, rename, writeFile, readFile, mkdir, readdir, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NoteStore} from '../lib/notes/store.js'
import {NoteVault} from '../lib/notes/vault.js'
import {mergeVaultText} from '../lib/notes/vault-merge.js'
const b = s=>Buffer.from(s)
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'vault-reconcile-')), store=new NoteStore(join(root,'store'))
 let now=100000
 const adapters={all:()=>store.syncManifest().nodes,read:id=>store.read(id),readVersion:(id,v)=>store.readVersion(id,v),
 update:(id,bytes,v)=>store.updateContent(id,bytes,v),relocate:(...args)=>store.relocate(...args),
 create:(kind,name,parent,bytes)=>kind==='folder'?store.createFolder(name,parent):store.createDocument(name,parent,Buffer.from(bytes).toString())}
 const path=join(root,'vault'), manifest=join(root,'index.json'), timing={stableMs:1000,missingMs:30000,now:()=>now}
 let vault=new NoteVault(path,adapters,manifest,false,timing)
 t.after(async()=>{await vault.close();await store.close();await rm(root,{recursive:true,force:true})})
 const scan=async(ms=1100)=>{now+=ms;await vault.scan()}
 return {root,path,store,get vault(){return vault},scan,settle:async()=>{await scan();await scan()},
 restart:async()=>{await vault.close();vault=new NoteVault(path,adapters,manifest,false,timing)},
 file:(name)=>join(path,name)}
}
test('external stable edits preserve history; interrupted write waits; restart preserves mapping',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await writeFile(f.file('a.md'),'half');await f.scan();assert.equal((await f.store.read(n.id)).content.toString(),'base')
 await writeFile(f.file('a.md'),'complete');await f.scan();await f.scan()
 assert.equal((await f.store.read(n.id)).content.toString(),'complete');assert.equal(f.store.listVersions(n.id).length,2)
 await f.restart();await f.settle();assert.equal(f.store.listVersions(n.id).length,2)
 assert.ok(f.vault.status().events.some(e=>e.action==='外部文件修改'))
})
test('rename and move including changed content retain ID and original history',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await mkdir(f.file('folder'));await rename(f.file('a.md'),f.file('folder/b.md'));await writeFile(f.file('folder/b.md'),'changed')
 await f.settle();await f.settle()
 assert.equal(f.store.get(n.id).name,'b.md');assert.equal((await f.store.read(n.id)).content.toString(),'changed')
 assert.equal(f.store.syncManifest().nodes.filter(n=>n.kind==='document').length,1)
 assert.equal(f.store.listVersions(n.id).length,2)
})
test('directory move preserves nested identities and does not recreate the old directory',async t=>{
 const f=await fixture(t),dir=await f.store.createFolder('old'),child=await f.store.createDocument('a',dir.id,'base');await f.scan()
 await rename(f.file('old'),f.file('new'));await f.settle()
 assert.equal(f.store.get(dir.id).name,'new');assert.equal(f.store.get(child.id).parentId,dir.id)
 assert.ok(!(await readdir(f.path)).includes('old'))
})
test('atomic editor replace is an edit, not a deletion or new note',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await writeFile(f.file('.tmp'),'new');await rename(f.file('.tmp'),f.file('a.md'));await f.settle()
 assert.equal((await f.store.read(n.id)).content.toString(),'new');assert.equal(f.store.syncManifest().nodes.length,1)
})
test('confirmed deletion is reversible and retains versions and same ID',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await rm(f.file('a.md'));await f.scan();await f.scan();assert.equal(f.vault.status().recycle.length,0)
 await f.scan(30000);assert.equal(f.vault.status().recycle.length,1);assert.ok(f.store.get(n.id));assert.equal(f.store.listVersions(n.id).length,1)
 await f.vault.restore(n.id);assert.equal(await readFile(f.file('a.md'),'utf8'),'base');assert.equal(f.store.get(n.id).parentId,null)
})
test('mount disappearance and sentinel loss never propagate deletes or recreate mount',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await rename(f.path,join(f.root,'unmounted'));await f.scan(40000);await f.scan(40000)
 assert.equal(f.vault.status().recycle.length,0);assert.ok(f.store.get(n.id));await assert.rejects(readFile(f.file('.dsh-vault-id')))
 await rename(join(f.root,'unmounted'),f.path);await rm(f.file('.dsh-vault-id'));await f.scan(40000)
 assert.equal(f.vault.status().recycle.length,0)
})
test('copy then delete with duplicate content stays ambiguous without duplicate import',async t=>{
 const f=await fixture(t),a=await f.store.createDocument('a',null,'same');await f.store.createDocument('b',null,'same');await f.scan()
 await rm(f.file('a.md'));await writeFile(f.file('c.md'),'same');await f.settle();await f.scan(40000)
 assert.equal(f.store.get(a.id).name,'a.md');assert.equal(f.store.syncManifest().nodes.length,2)
 assert.equal(f.vault.status().recycle.length,0);assert.ok(f.vault.status().externalConflicts)
})
test('different-line edits merge, overlapping edits retain both and version-bound resolution rejects stale views',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'a\nb\nc\nd\n');await f.scan()
 await f.store.updateContent(n.id,b('A\nb\nc\nd\n'));await writeFile(f.file('a.md'),'a\nb\nc\nD\n');await f.settle()
 assert.equal((await f.store.read(n.id)).content.toString(),'A\nb\nc\nD\n');assert.equal(await readFile(f.file('a.md'),'utf8'),'A\nb\nc\nD\n')
 await f.store.updateContent(n.id,b('web'));await writeFile(f.file('a.md'),'external');await f.settle()
 assert.equal(f.vault.status().externalConflicts,1)
 const detail=await f.vault.conflictDetail(n.id);await writeFile(f.file('a.md'),'new external')
 await assert.rejects(f.vault.resolveExternal(n.id,'external',detail.fingerprint,detail.externalHash),/变化/)
 const next=await f.vault.conflictDetail(n.id);await f.vault.resolveExternal(n.id,'external',next.fingerprint,next.externalHash)
 assert.equal((await f.store.read(n.id)).content.toString(),'new external')
})
test('symlink blocks reconciliation and concurrent application edits prevent deletion',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await rm(f.file('a.md'));await f.store.updateContent(n.id,b('web'));await f.settle();await f.scan(40000)
 assert.equal(f.vault.status().recycle.length,0);assert.equal((await f.store.read(n.id)).content.toString(),'web')
 await symlink('/etc',f.file('unsafe'));await f.scan();assert.match(f.vault.status().warning,/符号链接/)
})
test('merge keeps newlines and refuses invalid utf8 and ambiguous overlapping inserts',()=>{
 assert.equal(mergeVaultText(b('a\nb\nc\n'),b('A\nb\nc\n'),b('a\nb\nC\n')).toString(),'A\nb\nC\n')
 assert.equal(mergeVaultText(b('a'),b('xa'),b('ya')),null)
 assert.equal(mergeVaultText(Buffer.from([255]),b('a'),b('b')),null)
})
test('ambiguous move can be manually linked without losing history; stale destination rejects',async t=>{
 const f=await fixture(t),a=await f.store.createDocument('a',null,'same');await f.store.createDocument('b',null,'same');await f.scan()
 await rm(f.file('a.md'));await writeFile(f.file('c.md'),'same');await f.settle();await f.scan(40000)
 const detail=await f.vault.conflictDetail(a.id),candidate=detail.candidates.find(e=>e.path==='c.md')
 await writeFile(f.file('c.md'),'changed');await assert.rejects(f.vault.linkExternalPath(a.id,candidate.path,candidate.signature,detail.fingerprint),/变化/)
 const fresh=await f.vault.conflictDetail(a.id),next=fresh.candidates.find(e=>e.path==='c.md')
 await f.vault.linkExternalPath(a.id,next.path,next.signature,fresh.fingerprint);await f.settle()
 assert.equal(f.store.get(a.id).name,'c.md');assert.equal((await f.store.read(a.id)).content.toString(),'changed')
 assert.equal(f.store.syncManifest().nodes.length,2)
})
test('deleted directories restore nested notes and reject conflicting recreated paths',async t=>{
 const f=await fixture(t),dir=await f.store.createFolder('folder'),n=await f.store.createDocument('a',dir.id,'base');await f.scan()
 await rm(f.file('folder'),{recursive:true});await f.settle();await f.scan(40000)
 assert.equal(f.vault.status().recycle.length,1)
 await mkdir(f.file('folder'));await writeFile(f.file('folder/a.md'),'different')
 await assert.rejects(f.vault.restore(dir.id),/占用/)
 assert.equal(await readFile(f.file('folder/a.md'),'utf8'),'different')
 await rm(f.file('folder/a.md'));await f.vault.restore(dir.id)
 assert.equal(await readFile(f.file('folder/a.md'),'utf8'),'base');assert.equal(f.store.get(n.id).parentId,dir.id)
})
test('a concurrent application rename prevents automatic external relocation',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await rename(f.file('a.md'),f.file('external.md'));f.store.rename(n.id,'web.md');await f.settle()
 assert.equal(f.store.get(n.id).name,'web.md');assert.ok(f.vault.status().externalConflicts)
 assert.equal(await readFile(f.file('external.md'),'utf8'),'base')
})
test('restarting during a missing-file interval requires a fresh confirmation window',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan();await rm(f.file('a.md'));await f.settle()
 await f.restart();await f.scan(40000);await f.scan();assert.equal(f.vault.status().recycle.length,0)
 await f.scan(40000);assert.equal(f.vault.status().recycle.length,1);assert.ok(f.store.get(n.id))
})
test('replaced nested directory is not interpreted as child deletions',async t=>{
 const f=await fixture(t),dir=await f.store.createFolder('mount'),n=await f.store.createDocument('a',dir.id,'base');await f.scan()
 await rename(f.file('mount'),join(f.root,'detached'));await mkdir(f.file('mount'))
 await f.settle();await f.scan(40000)
 assert.equal(f.vault.status().recycle.length,0);assert.ok(f.store.get(n.id));assert.ok(f.vault.status().externalConflicts)
 assert.equal((await readdir(f.file('mount'))).length,0)
 const detail=await f.vault.conflictDetail(dir.id);await f.vault.resolveExternal(dir.id,'application',detail.fingerprint,detail.externalHash)
 assert.equal(await readFile(f.file('mount/a.md'),'utf8'),'base')
})
test('history sources are persisted without relabeling old snapshots',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base')
 await f.store.updateContent(n.id,b('web'),1,'网页修改');await f.store.updateContent(n.id,b('agent'),2,'AI 修改')
 const versions=f.store.listVersions(n.id)
 assert.equal(versions[0].source,'AI 修改');assert.equal(versions[1].source,'网页修改');assert.equal(versions[2].source,undefined)
 assert.equal((await f.store.readVersion(n.id,2)).version.source,'网页修改')
})
test('native rename and move change the disk path while preserving note ID and external edits',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base'),folder=await f.store.createFolder('target');await f.scan()
 await writeFile(f.file('a.md'),'external latest')
 f.store.rename(n.id,'b.md');f.store.move(n.id,folder.id);await f.settle();await f.settle()
 assert.equal(await readFile(f.file('target/b.md'),'utf8'),'external latest')
 await assert.rejects(readFile(f.file('a.md')))
 assert.equal((await f.store.read(n.id)).content.toString(),'external latest')
 assert.equal(f.store.syncManifest().nodes.filter(n=>n.kind==='document').length,1)
})
test('native folder rename moves descendants together and leaves no duplicate old directory',async t=>{
 const f=await fixture(t),folder=await f.store.createFolder('old'),n=await f.store.createDocument('a',folder.id,'body');await f.scan()
 f.store.rename(folder.id,'new');await f.settle()
 assert.equal(await readFile(f.file('new/a.md'),'utf8'),'body');assert.ok(!(await readdir(f.path)).includes('old'))
 assert.equal(f.store.get(n.id).parentId,folder.id);assert.equal(f.vault.status().externalConflicts,0)
})
test('native destination collision preserves both files and retries after collision is removed',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'original');await f.scan()
 await writeFile(f.file('b.md'),'unrelated');f.store.rename(n.id,'b.md');await f.settle()
 assert.equal(await readFile(f.file('a.md'),'utf8'),'original');assert.equal(await readFile(f.file('b.md'),'utf8'),'unrelated')
 assert.ok(f.vault.status().externalConflicts)
 await rm(f.file('b.md'));await f.restart();await f.settle()
 assert.equal(await readFile(f.file('b.md'),'utf8'),'original');await assert.rejects(readFile(f.file('a.md')))
})
test('native delete archives external changes instead of importing the deleted note again',async t=>{
 const f=await fixture(t),n=await f.store.createDocument('a',null,'base');await f.scan()
 await writeFile(f.file('a.md'),'unsynced external');await f.store.delete(n.id);await f.settle()
 await assert.rejects(readFile(f.file('a.md')));assert.equal(f.store.syncManifest().nodes.length,0)
 const archived=(await readdir(f.file('.dsh-deleted'))).filter(name=>!name.endsWith('.json'));assert.equal(archived.length,1)
 assert.equal(await readFile(f.file('.dsh-deleted/'+archived[0]),'utf8'),'unsynced external')
})
test('directory move resumes its durable reservation after interruption',async t=>{
 const {moveVaultEntry}=await import('../lib/notes/vault-move.js')
 const {vaultIdentity}=await import('../lib/notes/vault-snapshot.js')
 const root=await mkdtemp(join(tmpdir(),'vault-move-resume-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const from=join(root,'from'),to=join(root,'to'),stage=join(root,'.stage','op')
 await mkdir(from);await writeFile(join(from,'a.md'),'retained')
 const move={from,to,stage,identity:(await vaultIdentity(from)).identity,directory:true,name:'to',parentId:null}
 let saved
 await assert.rejects(moveVaultEntry(move,async()=>{saved=JSON.stringify(move);throw Error('simulated interruption')}),/interruption/)
 assert.equal(await readFile(join(stage,'a.md'),'utf8'),'retained')
 await moveVaultEntry(JSON.parse(saved))
 assert.equal(await readFile(join(to,'a.md'),'utf8'),'retained');await assert.rejects(readFile(join(from,'a.md')))
})
test('native deletion of a directory archives nested notes and never recreates them',async t=>{
 const f=await fixture(t),dir=await f.store.createFolder('dir');await f.store.createDocument('a',dir.id,'body');await f.scan()
 await f.store.delete(dir.id);await f.settle();await f.restart();await f.settle()
 assert.equal(f.store.syncManifest().nodes.length,0);assert.ok(!(await readdir(f.path)).includes('dir'))
 const entries=(await readdir(f.file('.dsh-deleted'))).filter(n=>!n.endsWith('.json'))
 assert.equal(entries.length,1);assert.equal(await readFile(f.file('.dsh-deleted/'+entries[0]+'/a.md'),'utf8'),'body')
})
