import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'

test('connection endpoints require local management auth, validate scope and return actual connection status', async t => {
  const root=await mkdtemp(join(tmpdir(),'wiki-http-')),provider=new LocalKnowledgeProvider(join(root,'db.sqlite'))
  let handler
  registerKnowledgeApi({webServer:{register(route){handler=route.handler;return()=>{}}}},provider,'/test',{authMode:'same-origin'})
  const server=createServer((req,res)=>void handler(req,res))
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await provider.close();await rm(root,{recursive:true,force:true,maxRetries:5})})
  const base=await provider.createKnowledgeBase({name:'HTTP',description:'',defaultTags:[],extractionInstructions:'',writebackPolicy:'conservative'})
  const endpoint=`http://127.0.0.1:${server.address().port}/test/wiki/${base.id}`
  const headers={'x-dsh-knowledge-client':'management-web','content-type':'application/json'}
  assert.equal((await fetch(endpoint+'/connection')).status,401)
  assert.equal((await fetch(endpoint+'/connection',{headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403)
  assert.equal((await (await fetch(endpoint+'/connection',{headers})).json()).state,'unconfigured')
  const sourceDir=join(root,'source'),workspaceRoot=join(root,'work');await mkdir(sourceDir);await mkdir(workspaceRoot)
  const body={sourceDir,workspaceRoot}
  assert.equal((await fetch(endpoint+'/connect',{method:'POST',headers,body:JSON.stringify(body)})).status,400)
  const connected=await fetch(endpoint+'/connect',{method:'POST',headers,body:JSON.stringify({...body,scope:{kind:'global'}})})
  assert.equal(connected.status,200)
  const report=await connected.json();assert.equal(report.state,'ready');assert.equal(report.layout.pageDir,join(workspaceRoot,'wiki'))
  assert.equal((await (await fetch(endpoint+'/connection',{headers})).json()).state,'ready')
})
