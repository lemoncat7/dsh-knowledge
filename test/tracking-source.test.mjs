import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {LocalKnowledgeProvider} from '../lib/index.js'
import {createKnowledgeTrackingService} from '../lib/tracking.js'
import {readTrackingSource} from '../lib/tracking-source.js'

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'tracking-source-'))
  const provider=new LocalKnowledgeProvider(join(root,'kb.sqlite'))
  t.after(async()=>{await provider.close();await rm(root,{recursive:true,force:true})})
  await provider.patchKnowledgeBase('default',{name:'常用规则'})
  const mount={targetKind:'session',targetId:'s',knowledgeBaseId:'default',enabled:true,recallEnabled:true,writeMode:'none',includeTags:[],excludeTags:[],extractionInstructions:''}
  await provider.upsertMount(mount)
  const draft={knowledgeBaseId:'default',group:'规则',title:'关注指定对象的提醒规则',body:'## 检查\n步骤和前置条件\n'+'正文'.repeat(4000),type:'fact',tags:[],scope:{kind:'global'},confidence:1}
  const entry=await provider.create(draft)
  const service=createKnowledgeTrackingService(provider)
  const agent={session:{id:'s',header:{},events:[]}}
  return {provider,service,agent,mount,entry,draft}
}

test('exact title with action words reads complete paginated document without ranked recall',async t=>{
  const f=await fixture(t)
  f.provider.search=()=>assert.fail('must not use ranked search')
  const ref='常用规则/关注指定对象的提醒规则'
  const first=await f.service.readSource(f.agent,ref)
  assert.equal(first.id,f.entry.id)
  assert.equal(first.nextOffset,6000)
  const second=await f.service.readSource(f.agent,ref,first.nextOffset)
  assert.equal(second.nextOffset,null)
  assert.equal(first.content.length+second.content.length,first.totalChars)
  assert.equal(first.revision,second.revision)
  assert.equal((await f.service.readSource(f.agent,'常用规则/'+f.entry.id)).id,f.entry.id)
  await assert.rejects(f.service.readSource(f.agent,'常用规则/指定对象'),/SOURCE_NOT_FOUND/)
  await assert.rejects(f.service.readSource(f.agent,'常用规则'),/SOURCE_DOCUMENT_REQUIRED/)
  await assert.rejects(f.service.readSource(f.agent,ref,999999),/SOURCE_OFFSET_INVALID/)
  await assert.rejects(f.service.readSource(f.agent,'未挂载/文档'),/SOURCE_NOT_MOUNTED/)
})

test('bound reading preserves project/tag filters, detects ambiguity and revoked recall',async t=>{
  const f=await fixture(t),ref='常用规则/'+f.entry.title
  await f.provider.upsertMount({...f.mount,includeTags:['allowed']})
  await assert.rejects(f.service.readSource(f.agent,ref),/SOURCE_OUTSIDE_SCOPE/)
  await f.provider.upsertMount(f.mount)
  await f.provider.update(f.entry.id,{...f.draft,scope:{kind:'project',id:'/other'}})
  await assert.rejects(f.service.readSource(f.agent,ref),/SOURCE_OUTSIDE_SCOPE/)
  await f.provider.update(f.entry.id,f.draft)
  await f.provider.create({...f.draft,body:'不同版本的同名规则'})
  await assert.rejects(f.service.readSource(f.agent,ref),/SOURCE_AMBIGUOUS/)
  await f.provider.upsertMount({...f.mount,recallEnabled:false})
  await assert.rejects(f.service.readSource(f.agent,ref),/SOURCE_NOT_MOUNTED/)
})

test('incomplete/cyclic index cannot be reported as missing document',async()=>{
  const provider={resolveMounts:async()=>[{knowledgeBaseId:'b',base:{name:'规则'},enabled:true,recallEnabled:true}],listDocumentIndex:async()=>({items:[],nextCursor:'same'})}
  await assert.rejects(readTrackingSource(provider,{session:{id:'s',header:{}}},'规则/文档'),/SOURCE_INDEX_INCOMPLETE/)
})

test('an exact host-owned binding permits cross-project read only; ordinary recall stays scoped',async t=>{
 const f=await fixture(t),ref='常用规则/'+f.entry.title
 await f.provider.update(f.entry.id,{...f.draft,scope:{kind:'project',id:'/partners/other'}})
 f.agent.session.header.cwd='/partners/current'
 await assert.rejects(f.service.readSource(f.agent,ref),/SOURCE_OUTSIDE_SCOPE/)
 const binding={sessionId:'s',reference:ref}
 const first=await f.service.readBoundSource(f.agent,binding)
 assert.equal(first.id,f.entry.id)
 assert.equal((await f.service.readBoundSource(f.agent,binding,first.nextOffset)).nextOffset,null)
 await assert.rejects(f.service.readSource(f.agent,ref),/SOURCE_OUTSIDE_SCOPE/)
 await assert.rejects(f.service.readBoundSource(f.agent,{...binding,sessionId:'other'}),/SOURCE_BINDING_INVALID/)
 await assert.rejects(readTrackingSource(f.provider,f.agent,ref,0,undefined,{...binding,reference:'常用规则/别的文档'}),/SOURCE_BINDING_INVALID/)
 await assert.rejects(f.service.readBoundSource(f.agent,{sessionId:'s',reference:'常用规则'}),/SOURCE_DOCUMENT_REQUIRED/)
 await f.provider.upsertMount({...f.mount,includeTags:['ungranted']})
 await assert.rejects(f.service.readBoundSource(f.agent,binding),/SOURCE_OUTSIDE_SCOPE/)
 await f.provider.upsertMount({...f.mount,recallEnabled:false})
 await assert.rejects(f.service.readBoundSource(f.agent,binding),/SOURCE_NOT_MOUNTED/)
})
