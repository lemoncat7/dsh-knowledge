import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {LocalKnowledgeProvider} from '../lib/local-provider.js'
import {registerKnowledgeNoteTools} from '../lib/note-tools.js'
import {KnowledgeNoteHandleCodec} from '../lib/note-reference-handle.js'
import {KnowledgeHandleCodec} from '../lib/retrieval.js'

async function fixture(t,content='# 甲\n旧甲\n# 乙\n旧乙'){
  const root=await mkdtemp(join(tmpdir(),'note-batch-')),provider=new LocalKnowledgeProvider(join(root,'db.sqlite'))
  t.after(async()=>{await provider.close();await rm(root,{recursive:true,force:true})})
  const tools=new Map(),codec=new KnowledgeNoteHandleCodec(Buffer.alloc(32,1))
  registerKnowledgeNoteTools({tools:{register(tool){tools.set(tool.name,tool)}}},provider,codec,new KnowledgeHandleCodec(Buffer.alloc(32,2)))
  const session={id:'batch-test',events:[],snapshotEvents(){return this.events},header:{}}
  const exec={agent:{session},signal:new AbortController().signal}
  const user=text=>session.events.push({type:'turn/start',seq:session.events.length,data:{}},{type:'user/message',seq:session.events.length+1,data:{source:{kind:'user'},content:[{type:'text',text}]}})
  user('把甲乙两章一起优化，先给我看修改预览')
  const node=await provider.createNoteDocument('测试',null,content),handle=codec.encode(session.id,node.id)
  const call=async(name,args,context=exec)=>JSON.parse(await tools.get(name).execute(args,context))
  const update=args=>call('knowledge_note_update',{noteHandle:handle,expectedVersion:node.version,...args})
  const read=async()=>new TextDecoder().decode((await provider.readNote(node.id)).content)
  return {provider,tools,exec,user,node,handle,call,update,read}
}

test('one multi-section proposal, one confirmation and one version increment with explicit diff',async t=>{
  const f=await fixture(t)
  const plan=await f.update({operation:'batch_edit',summary:'同步甲乙两章规则',edits:[{oldText:'旧甲',newText:'新甲'},{oldText:'旧乙',newText:'新乙'}]})
  assert.equal(plan.status,'pending_confirmation');assert.equal(plan.changeCount,2);assert.equal(plan.nextPreviewOffset,null)
  assert.equal(await f.read(),'# 甲\n旧甲\n# 乙\n旧乙')
  const rendered=f.tools.get('knowledge_note_update').output.render({},JSON.stringify(plan))[0].text
  for(const term of ['第 2–2 行','第 4–4 行','旧甲','新甲','旧乙','新乙','尚未保存'])assert.ok(rendered.includes(term),term)
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId}),/下一轮/)
  f.user('可以')
  await f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId})
  assert.equal(await f.read(),'# 甲\n新甲\n# 乙\n新乙')
  assert.equal((await f.provider.getNote(f.node.id)).version,f.node.version+1)
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId}),/失效/)
})

test('version conflict never writes a partial batch',async t=>{
  const f=await fixture(t)
  const plan=await f.update({operation:'batch_edit',edits:[{oldText:'旧甲',newText:'新甲'},{oldText:'旧乙',newText:'新乙'}]})
  await f.provider.updateNoteContent(f.node.id,new TextEncoder().encode('外部新版本'))
  f.user('确认')
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId}),/变化/)
  assert.equal(await f.read(),'外部新版本')
})

test('long preview is pageable and session-bound, missing pages cannot be silently confirmed',async t=>{
  const f=await fixture(t,'# 长章\n'+ '旧内容'.repeat(6000))
  const plan=await f.update({operation:'replace_content',value:'# 长章\n'+ '新内容'.repeat(6000)})
  assert.ok(plan.nextPreviewOffset>0);assert.ok(plan.previewTotalChars>plan.preview.length)
  await assert.rejects(()=>f.call('knowledge_note_preview',{confirmationId:plan.confirmationId,offset:plan.previewTotalChars-1}),/不可跳过/)
  const other={...f.exec,agent:{session:{...f.exec.agent.session,id:'other'}}}
  await assert.rejects(()=>f.call('knowledge_note_preview',{confirmationId:plan.confirmationId},other),/失效/)
  f.user('确认')
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId}),/预览尚未读取完整/)
  let offset=plan.nextPreviewOffset,complete=plan.preview
  while(offset!==null){const page=await f.call('knowledge_note_preview',{confirmationId:plan.confirmationId,offset});complete+=page.preview;offset=page.nextPreviewOffset}
  assert.equal(complete.length,plan.previewTotalChars);assert.ok(complete.includes('修改后'))
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId}),/下一轮/)
  f.user('按这个改')
  await f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId})
  assert.equal(await f.read(),'# 长章\n'+'新内容'.repeat(6000))
})

test('rejected proposals do not write; replaced plans invalidate old confirmation IDs',async t=>{
  const f=await fixture(t)
  const args={operation:'batch_edit',edits:[{oldText:'旧甲',newText:'新甲'}]}
  const first=await f.update(args),second=await f.update({...args,edits:[...args.edits,{oldText:'旧乙',newText:'新乙'}]})
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:first.confirmationId}),/失效/)
  f.user('取消')
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:second.confirmationId}),/取消/)
  assert.equal(await f.read(),'# 甲\n旧甲\n# 乙\n旧乙')
})

test('expired previews and aborted preview requests cannot be used to write',async t=>{
  const f=await fixture(t)
  const plan=await f.update({operation:'batch_edit',edits:[{oldText:'旧甲',newText:'新甲'}]})
  const controller=new AbortController();controller.abort()
  await assert.rejects(()=>f.call('knowledge_note_preview',{confirmationId:plan.confirmationId},{...f.exec,signal:controller.signal}),{name:'AbortError'})
  const now=Date.now();t.mock.method(Date,'now',()=>now+16*60_000)
  await assert.rejects(()=>f.call('knowledge_note_preview',{confirmationId:plan.confirmationId}),/失效/)
  f.user('确认')
  await assert.rejects(()=>f.call('knowledge_note_confirm',{confirmationId:plan.confirmationId}),/失效/)
  assert.equal(await f.read(),'# 甲\n旧甲\n# 乙\n旧乙')
})
