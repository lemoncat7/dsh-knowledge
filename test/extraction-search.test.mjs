import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExtractionCoordinator } from '../lib/extraction.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('writeback retrieves related knowledge with a bounded query but keeps the model conversation intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-extraction-search-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const entry = await provider.create({ group: '测试分组',
    knowledgeBaseId: 'default', title: '异常上报', body: 'nonStopCrypto report_analyse_result NSC_5006 不停机风险上报规则。',
    type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: 0.9,
  })
  await provider.upsertMount({ targetKind: 'session', targetId: 'search-test', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '' })
  const userText = '你看下异常上报，什么时候会上报 总结一下'
  const assistantText = '## 异常上报\n`nonStopCrypto` `report_analyse_result` `NSC_5006`\n' + '风险条件和处理结果。'.repeat(450)
  const session = {
    id: 'search-test', header: { cwd: '/project' },
    snapshotEvents() { return [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] } },
      { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: assistantText }] } } },
    ] },
  }
  let modelCalls = 0
  const ctx = { logger: { debug() {}, info() {}, warn() {}, error() {} }, llm: { async *stream(request) {
    modelCalls++
    const payload = JSON.parse(request.messages[0].content[0].text)
    assert.deepEqual(payload.conversation, { user: userText, assistant: assistantText })
    assert.ok(payload.existing.some(item => item.id === entry.id))
    assert.deepEqual(payload.destinations[0].documentGroups, ['测试分组'])
    assert.equal(payload.existing.find(item => item.id === entry.id).group, '测试分组')
    yield { type: 'text-delta', text: '{"candidates":[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const coordinator = new ExtractionCoordinator(ctx, provider, { extractionMaxInputChars: 20000, extractionMaxTokens: 1000, extractionTimeoutMs: 5000, defaultScope: 'project' })
  t.after(() => coordinator.close())
  const search = provider.search.bind(provider)
  provider.search = async request => {
    assert.ok(new URLSearchParams({ q: request.text }).toString().length < 2100)
    assert.deepEqual(request.knowledgeBaseIds, ['default'])
    assert.equal(request.projectId, '/project')
    return search(request)
  }
  assert.equal((await coordinator.run(session, 1, new AbortController().signal)).status, 'completed')
  assert.equal(modelCalls, 1)
  await provider.resetExtraction('search-test:1')
  provider.search = async () => { throw new Error('search unavailable') }
  await assert.rejects(coordinator.run(session, 1, new AbortController().signal), /search unavailable/)
  assert.equal(modelCalls, 1)
  assert.equal((await provider.extractionJob('search-test:1')).status, 'failed')
})

test('batched extraction sends each ordered turn and later correction to the model',async t=>{
 const root=await mkdtemp(join(tmpdir(),'knowledge-batch-model-')),provider=new LocalKnowledgeProvider(join(root,'db.sqlite'))
 t.after(async()=>{await provider.close();await rm(root,{recursive:true,force:true})})
 await provider.upsertMount({targetKind:'session',targetId:'batched',knowledgeBaseId:'default',enabled:true,recallEnabled:true,writeMode:'audit',includeTags:[],excludeTags:[],extractionInstructions:''})
 const turns=[{turn:1,user:'用旧地址',assistant:'记录旧地址'},{turn:2,user:'刚才错了，用新地址',assistant:'改为新地址'}];let calls=0
 const ctx={logger:{debug(){},info(){},warn(){},error(){}},llm:{async *stream(request){calls++;const payload=JSON.parse(request.messages[0].content[0].text);assert.deepEqual(payload.conversation.turns,turns);assert.match(payload.conversation.instructions,/后续纠正或撤回优先/);yield {type:'text-delta',text:'{"candidates":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}}
 const coordinator=new ExtractionCoordinator(ctx,provider,{extractionMaxInputChars:20000,extractionMaxTokens:1000,extractionTimeoutMs:5000,defaultScope:'global'});t.after(()=>coordinator.close())
 await coordinator.runSnapshot({sourceKey:'batched:1',sessionId:'batched',turn:1,turns,userText:turns.map(x=>x.user).join('\n'),assistantText:turns.map(x=>x.assistant).join('\n'),userTextTruncated:false,route:{provider:'mock',model:'mock'}},new AbortController().signal)
 assert.equal(calls,1)
})
