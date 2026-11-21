import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-connect-'))
  const provider = new LocalKnowledgeProvider(join(root, 'db.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'workspace')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: '接入测试', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  const store = provider.wiki.store(base.id)
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { provider, store, base: base.id, root, sourceDir, workspaceRoot }
}
const page = '# 旧知识\n\n已有原文，不应重写。\n'

test('partial registration admits valid pages, reports bad pages, and preserves originals and identity', async t => {
  const f = await fixture(t)
  const good = join(f.workspaceRoot, 'wiki', 'good.md'), bad = join(f.workspaceRoot, 'wiki', 'bad.md')
  await writeFile(good, page); await writeFile(bad, '---\ntitle: [broken\n---\ntext')
  await writeFile(join(f.sourceDir, 'original.txt'), '原件')
  const result = await f.store.importValid({ kind: 'project', id: 'private-project' }, 'partial-1')
  assert.equal(result.registered, 1); assert.equal(result.rejected, 1)
  assert.equal(result.items.find(i => i.relPath === 'bad.md').status, 'invalid')
  const first = (await f.store.manifest()).pages[0]
  assert.deepEqual(first.scope, { kind: 'project', id: 'private-project' })
  const second = await f.store.importValid({ kind: 'global' }, 'partial-2')
  assert.equal(second.registered, 0); assert.equal(second.existing, 1)
  const again = (await f.store.manifest()).pages[0]
  assert.equal(again.pageId, first.pageId); assert.deepEqual(again.scope, first.scope)
  assert.equal(await readFile(good, 'utf8'), page)
  assert.equal(await readFile(join(f.sourceDir, 'original.txt'), 'utf8'), '原件')
})

test('registration rejects files changed after inspection instead of accepting stale bytes', async t => {
  const f = await fixture(t), target = join(f.workspaceRoot, 'wiki', 'one.md')
  await writeFile(target, page)
  const inspect = f.store.inspect.bind(f.store)
  f.store.inspect = async () => { const result = await inspect(); await writeFile(target, page + '外部修改\n'); return result }
  await assert.rejects(() => f.store.importValid({ kind: 'global' }, 'racing-import'), /WIKI_IMPORT_FILE_CHANGED/)
  assert.equal((await f.store.manifest()).pages.length, 0)
})

test('partial registration rejects a corrupt identity manifest', async t => {
  const f = await fixture(t)
  await mkdir(join(f.workspaceRoot, '_meta', 'knowledge'), { recursive: true })
  await writeFile(join(f.workspaceRoot, '_meta', 'knowledge', 'manifest.json'), '{broken')
  await assert.rejects(() => f.store.importValid({ kind: 'global' }, 'broken-import'))
})


test('connection distinguishes configured, ready empty, partial, and repeat registration without model calls', async t => {
  const f = await fixture(t)
  assert.equal(f.provider.wiki.connectionStatus(f.base).state, 'configured')
  const config = { kbId:f.base, sourceDir:f.sourceDir, workspaceRoot:f.workspaceRoot, scope:{kind:'project',id:'p'} }
  const empty = await f.provider.wiki.connect(config)
  assert.equal(empty.state,'ready'); assert.equal(empty.report.registered,0)
  await writeFile(join(f.workspaceRoot,'wiki','ok.md'),page)
  await writeFile(join(f.workspaceRoot,'wiki','long.md'),'# 太长\n\n'+'a'.repeat(51000))
  const partial = await f.provider.wiki.connect(config)
  assert.equal(partial.state,'partial'); assert.equal(partial.report.registered,1); assert.equal(partial.report.rejected,1)
  assert.equal((await f.provider.list({knowledgeBaseId:f.base,limit:10})).items.length,1)
  const id=(await f.store.manifest()).pages[0].pageId
  const repeat=await f.provider.wiki.connect(config)
  assert.equal(repeat.report.registered,0); assert.equal((await f.store.manifest()).pages[0].pageId,id)
  assert.equal(f.provider.wiki.connectionStatus(f.base).state,'partial')
  assert.equal(f.provider.wiki.ingest.jobs(f.base).length,0)
})

test('failed indexing is persisted as failed rather than ready and connect can be retried', async t => {
  const f=await fixture(t),config={kbId:f.base,sourceDir:f.sourceDir,workspaceRoot:f.workspaceRoot,scope:{kind:'global'}}
  const rebuild=f.provider.wiki.rebuild.bind(f.provider.wiki)
  f.provider.wiki.rebuild=async()=>{throw Error('INJECT_INDEX_FAILURE')}
  await assert.rejects(()=>f.provider.wiki.connect(config),/INJECT_INDEX_FAILURE/)
  assert.equal(f.provider.wiki.connectionStatus(f.base).state,'failed')
  f.provider.wiki.rebuild=rebuild
  assert.equal((await f.provider.wiki.connect(config)).state,'ready')
})


test('daily update registers new authored pages and clearly reuses an existing running job',async t=>{
 const f=await fixture(t),scope={kind:'global'}
 await f.provider.wiki.connect({kbId:f.base,sourceDir:f.sourceDir,workspaceRoot:f.workspaceRoot,scope})
 await writeFile(join(f.workspaceRoot,'wiki','new.md'),page)
 const settings={python:'python',provider:'test',model:'mock',allowModel:true,scope}
 const saved=f.provider.wiki.ingest.start.bind(f.provider.wiki.ingest)
 let starts=0
 f.provider.wiki.ingest.start=async()=>{starts++;return{id:'running',kbId:f.base,state:'running',settings,items:[],createdAt:'now',updatedAt:'now'}}
 f.provider.wiki.ingest.running=()=>starts?{id:'running',kbId:f.base,state:'running',settings,items:[],createdAt:'now',updatedAt:'now'}:undefined
 const first=await f.provider.wiki.update(f.base,settings)
 assert.equal(first.connection.report.registered,1);assert.equal(first.reused,false)
 const second=await f.provider.wiki.update(f.base,settings)
 assert.equal(second.reused,true);assert.equal(starts,1)
 f.provider.wiki.ingest.start=saved
})


test('connection keeps existing valid index when another registered page becomes invalid',async t=>{
 const f=await fixture(t),config={kbId:f.base,sourceDir:f.sourceDir,workspaceRoot:f.workspaceRoot,scope:{kind:'global'}}
 const path=join(f.workspaceRoot,'wiki','first.md');await writeFile(path,page)
 await f.provider.wiki.connect(config)
 await writeFile(path,'---\ntitle: [broken\n---\ninvalid')
 await writeFile(join(f.workspaceRoot,'wiki','second.md'),'# 第二篇\n\n正常正文')
 const value=await f.provider.wiki.connect(config)
 assert.equal(value.state,'partial');assert.equal(value.report.rejected,1)
 const listed=await f.provider.list({knowledgeBaseId:f.base,status:'active',limit:10})
 assert.equal(listed.items.length,1);assert.equal(listed.items[0].title,'第二篇')
})

test('connection persists explicit scope for later daily updates',async t=>{
 const f=await fixture(t)
 const value=await f.provider.wiki.connect({kbId:f.base,sourceDir:f.sourceDir,workspaceRoot:f.workspaceRoot,scope:{kind:'project',id:'private'}})
 assert.deepEqual(value.scope,{kind:'project',id:'private'})
 assert.deepEqual(f.provider.wiki.connectionStatus(f.base).scope,value.scope)
})

test("concurrent daily update requests cannot enqueue duplicate source tasks", async t=>{const f=await fixture(t),scope={kind:"global"};await f.provider.wiki.connect({kbId:f.base,sourceDir:f.sourceDir,workspaceRoot:f.workspaceRoot,scope});let calls=0,release;const barrier=new Promise(r=>release=r);f.provider.wiki.ingest.start=async()=>{calls++;await barrier;return{id:"queued",kbId:f.base,state:"running",settings:{},items:[],createdAt:"now",updatedAt:"now"}};f.provider.wiki.ingest.running=()=>undefined;const settings={python:"python",provider:"mock",model:"model",allowModel:true,scope};const one=f.provider.wiki.update(f.base,settings),two=f.provider.wiki.update(f.base,settings);await new Promise(r=>setTimeout(r,80));release();const result=await Promise.all([one,two]);assert.equal(calls,1);assert.equal(result[0].job.id,result[1].job.id);assert.equal(result.filter(r=>r.reused).length,1);});

test("a quarantined invalid old page does not block subsequent valid Wiki writes",async t=>{const f=await fixture(t),config={kbId:f.base,sourceDir:f.sourceDir,workspaceRoot:f.workspaceRoot,scope:{kind:"global"}};const path=join(f.workspaceRoot,"wiki","bad.md");await writeFile(path,page);await f.provider.wiki.connect(config);await writeFile(path,"---\ntitle: [broken\n---\nbroken");assert.equal((await f.provider.wiki.connect(config)).state,"partial");const entry=await f.provider.wiki.write({knowledgeBaseId:f.base,title:"新知识",body:"正常新知识正文",tags:[],type:"fact",scope:{kind:"global"},confidence:.9},undefined,"after-partial");assert.ok(await f.provider.get(entry));});

test("repairing a rejected page reconnects its original identity and clears partial status",async t=>{const f=await fixture(t),config={kbId:f.base,sourceDir:f.sourceDir,workspaceRoot:f.workspaceRoot,scope:{kind:"project",id:"p"}};const target=join(f.workspaceRoot,"wiki","repair.md");await writeFile(target,page);await f.provider.wiki.connect(config);const id=(await f.store.manifest()).pages[0].pageId;await writeFile(target,"---\ntitle: [broken\n---\nbad");assert.equal((await f.provider.wiki.connect(config)).state,"partial");await writeFile(target,page+"修正内容");assert.equal((await f.provider.wiki.connect(config)).state,"ready");assert.equal((await f.store.manifest()).pages[0].pageId,id);assert.equal((await f.provider.list({knowledgeBaseId:f.base,status:"active",limit:10})).items.length,1);});
