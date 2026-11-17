import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {registerKnowledgeWeb} from '../lib/web.js'
import {registerKnowledgeApi} from '../lib/api.js'
import {LocalKnowledgeProvider} from '../lib/local-provider.js'
import {normalizeWritebackFrequency,storeServiceSettings,loadServiceSettings} from '../lib/service-settings.js'
import {WritebackQueue} from '../lib/writeback/queue.js'
import {registerWritebackControl} from '../lib/writeback/control.js'
import {registerWritebackLive} from '../lib/writeback/live-control.js'
import {chromium} from '/home/moye/Online Document/infinite-canvas/node_modules/playwright/index.mjs'
const root=await mkdtemp(join(tmpdir(),'knowledge-frequency-ui-')),provider=new LocalKnowledgeProvider(join(root,'db.sqlite')),routes=[]
let settings={publicApiEnabled:false,extractionEveryTurns:1,extractionIdleSeconds:180},calls=0
const queue=new WritebackQueue(':memory:',async()=>{calls++;return {status:'completed',summary:'已完成',retryable:false}},()=>{},()=>({everyTurns:settings.extractionEveryTurns,idleSeconds:settings.extractionIdleSeconds,maxChars:30000}))
const ctx={webServer:{register(r){routes.push(r);return ()=>{}}},get(){}}
registerKnowledgeApi(ctx,provider,'/knowledge-local/v1',{authMode:'same-origin',service:{current:()=>settings,update:async patch=>{settings={...settings,...normalizeWritebackFrequency(patch)};await storeServiceSettings(join(root,'service.json'),settings);return settings}}})
registerKnowledgeWeb(ctx,'/knowledge','/knowledge-local/v1','same-origin');registerWritebackControl(ctx,queue);const dispose=registerWritebackLive(ctx,queue)
const server=createServer((req,res)=>{const path=req.url.split('?')[0];const route=routes.find(r=>path===r.path||r.kind==='prefix'&&path.startsWith(r.path+'/'));if(route)void route.handler(req,res);else if(path.startsWith('/knowledge-control/v1/models'))res.writeHead(200,{'content-type':'application/json'}).end('{"providers":[]}');else res.writeHead(404).end()})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-webgl']})
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(base+'/knowledge/');await page.getByRole('button',{name:'知识库与挂载',exact:true}).click();await page.getByRole('button',{name:'本机回写设置',exact:true}).click()
 const dialog=page.getByRole('dialog');const every=dialog.getByLabel('每几轮合并提取',{exact:false}),idle=dialog.getByLabel('空闲多久后提取',{exact:false})
 assert.equal(await every.inputValue(),'1');await every.fill('0');await dialog.getByRole('button',{name:'保存',exact:true}).click();assert.equal(settings.extractionEveryTurns,1)
 await every.fill('5');await idle.fill('90');await dialog.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));assert.equal(settings.extractionEveryTurns,5);assert.equal(loadServiceSettings(join(root,'service.json')).extractionIdleSeconds,90)
 await page.reload();await page.getByRole('button',{name:'知识库与挂载',exact:true}).click();await page.getByRole('button',{name:'本机回写设置',exact:true}).click();assert.equal(await every.inputValue(),'5');assert.equal(await idle.inputValue(),'90')
 for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:process.env.REPORT_DIR+'/frequency-'+width+'.png'})}
 for(const turn of [1,2])queue.enqueue({destination:'local:fixture',snapshot:{sourceKey:`ui:${turn}`,sessionId:'ui',turn,userText:'question',assistantText:'answer',userTextTruncated:false}})
 await page.goto(base+'/knowledge/?view=writeback');await page.getByRole('button',{name:'立即回写',exact:true}).first().click();await page.waitForFunction(()=>[...document.querySelectorAll('.writeback-job strong')].some(el=>el.textContent.includes('已完成')));assert.equal(calls,1);assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,savedReloaded:true,invalidRejected:true,manualFlush:true,mobileFits:true,realWrites:false}))
}finally{await browser.close();dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await queue.close();await provider.close();await rm(root,{recursive:true,force:true})}
