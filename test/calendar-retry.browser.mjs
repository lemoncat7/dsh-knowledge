import assert from 'node:assert/strict'
import {build} from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
const {chromium}=await import(process.env.DSH_PLAYWRIGHT_MODULE??'playwright')
const repo=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-retry-')),report=process.env.DSH_CALENDAR_REPORT
let server,browser
try{
 await build({stdin:{resolveDir:repo,loader:'jsx',contents:`
import {createRoot} from 'react-dom/client';import {Calendar} from './worklog/ui/Calendar.jsx';import css from './worklog/client.css';
const style=document.createElement('style');style.textContent=css;document.head.append(style);
window.calls=[];window.review={enabled:true,last:{day:'2026-11-24',status:'failed',message:'目标核对不完整，等待重新核对'}};window.behavior='normal';window.cursor=0;
const day='2026-11-25',event={id:'goal',uid:'goal@fixture',kind:'goal',day,endDay:'2026-11-26',allDay:true,status:'planned',priority:'normal',title:'测试构建流程',description:'',project:'',tags:[],revision:1,deletedAt:null,progressSummary:{count:0,text:''}};
window.fetch=async(url,options={})=>{const u=new URL(url,location.href),method=options.method||'GET';window.calls.push({path:u.pathname,method,body:options.body?JSON.parse(options.body):undefined});
if(u.pathname.endsWith('/calendar-info'))return Response.json({calendarId:'fixture',today:day,timeZone:'Asia/Shanghai',cursor:1,orderCursor:0,progressCursor:window.cursor,workdaysRevision:0,reportReview:structuredClone(window.review),dailyProgress:true,progressHistory:true});
if(u.pathname.endsWith('/calendar'))return Response.json({calendarId:'fixture',cursor:1,orderCursor:0,progressCursor:window.cursor,items:[{...event,progressSummary:window.cursor?{count:1,day:'2026-11-24',text:'核对完成后的新进度'}:event.progressSummary}],goalOrders:{},nextOffset:null});
if(u.pathname.endsWith('/calendar-report-recheck')){if(window.behavior==='network'){window.behavior='normal';throw Error('网络暂不可用')}if(window.behavior==='empty')return Response.json({report:window.review,recheck:{queued:0}});if(window.behavior==='forbidden')return Response.json({error:'需要管理员权限'}, {status:403});const body=JSON.parse(options.body);return new Promise(resolve=>{window.release=()=>{window.review={enabled:true,last:{day:body.from,status:'queued',message:''}};resolve(Response.json({report:window.review,recheck:{queued:1}}))}})}
if(u.pathname.endsWith('/calendar-progress-history'))return Response.json({calendarId:'fixture',items:window.cursor?[{day:'2026-11-24',text:'核对完成后的新进度',revision:1}]:[],before:null});
return Response.json({})};createRoot(document.getElementById('root')).render(<Calendar/>);
`},outfile:path.join(temp,'fixture.js'),bundle:true,platform:'browser',jsx:'automatic',loader:{'.css':'text'}})
 const js=await fs.readFile(path.join(temp,'fixture.js'));server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/fixture.js'?js:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/fixture.js"></script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({args:['--no-sandbox']});const errors=[],results=[]
 for(const width of [390,1280])for(const dark of [false,true]){
  const page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date('2026-11-25T02:00:00Z')});await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark)
  const section=page.getByRole('region',{name:'日报进度核对'})
  await section.getByRole('button',{name:'重试 2026-11-24 进度',exact:true}).waitFor()
  await section.getByRole('button').evaluate(b=>{for(let i=0;i<20;i++)b.click()})
  await page.waitForFunction(()=>typeof window.release==='function')
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='POST').length),1,'double clicks coalesce')
  assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.method==='POST').body),{from:'2026-11-24',to:'2026-11-24'})
  await page.evaluate(()=>window.release());await section.getByRole('button',{name:'核对中…',exact:true}).waitFor();assert.equal(await section.getByRole('button').isDisabled(),true)
  const lists=await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/calendar')).length)
  // Failed status refreshes independently of event/progress cursors.
  await page.evaluate(()=>window.review={enabled:true,last:{day:'2026-11-24',status:'failed',message:'重试暂未完成'}});await page.clock.fastForward(16000)
  await section.getByRole('button',{name:'重试 2026-11-24 进度',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/calendar')).length),lists,'status updates do not reload event lists')
  await page.evaluate(()=>window.behavior='network');await section.getByRole('button').click();await section.getByRole('alert').filter({hasText:'网络暂不可用'}).waitFor();await section.getByRole('button',{name:'重试提交',exact:true}).click();await page.waitForFunction(()=>window.calls.filter(c=>c.method==='POST').length===3);await page.evaluate(()=>window.release())
  await page.evaluate(()=>{window.review={enabled:true,last:{day:'2026-11-24',status:'done',message:'已核对 2 个目标，更新 1 个目标'}};window.cursor=1});await page.clock.fastForward(16000)
  await section.getByText(/更新 1 个目标/).waitFor();await page.locator('.wc-progress-preview').filter({hasText:'核对完成后的新进度'}).waitFor()
  const settledLists=await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/calendar')).length);await page.clock.fastForward(65000);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/calendar')).length),settledLists)
  const infoReads=await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/calendar-info')).length)
  await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));await page.clock.fastForward(65000)
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/calendar-info')).length),infoReads,'hidden calendars do not poll the network')
  await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>false}));await page.clock.fastForward(16000)
  assert.ok(await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/calendar-info')).length)>infoReads,'visible calendars resume updates')
  // A past date uses that date; a failed request is surfaced without auto-reposting.
  await page.getByLabel('跳转日期',{exact:true}).fill('2026-11-20');await page.getByRole('button',{name:'重新核对当日进度',exact:true}).click();await page.waitForFunction(()=>window.calls.filter(c=>c.method==='POST').length===4);assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.method==='POST').at(-1).body),{from:'2026-11-20',to:'2026-11-20'});await page.evaluate(()=>window.release())
  await page.evaluate(()=>window.review={enabled:true,last:{day:'2026-11-20',status:'failed',message:'可手动重新核对'}});await page.clock.fastForward(16000);await page.evaluate(()=>window.behavior='forbidden');await page.getByRole('button',{name:'重试 2026-11-20 进度',exact:true}).click();await page.getByRole('alert').filter({hasText:'需要管理员权限'}).waitFor();const posts=await page.evaluate(()=>window.calls.filter(c=>c.method==='POST').length);await page.clock.fastForward(16000);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='POST').length),posts)
  await page.evaluate(()=>window.behavior='empty');await page.getByRole('button',{name:'重试提交',exact:true}).click();await page.getByText('没有新增核对任务，请确认当天已有日报，或等待当前核对完成。',{exact:true}).waitFor();assert.equal(await page.getByRole('region',{name:'日报进度核对'}).getByRole('button').isDisabled(),false)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  if(report)await page.screenshot({path:path.join(report,'retry-'+width+'-'+(dark?'dark':'light')+'.png'),fullPage:true})
  await page.getByLabel('跳转日期',{exact:true}).fill('2026-11-30');assert.equal(await page.getByRole('region',{name:'日报进度核对'}).count(),0)
  await page.getByRole('button',{name:'今天',exact:true}).click();await page.evaluate(()=>window.review={enabled:false,last:null});await page.clock.fastForward(16000);await page.getByRole('button',{name:'前往日历设置',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'重新核对昨日进度',exact:true}).count(),0)
  results.push({width,dark,retryAndNetworkRecovery:true,doubleClickPosts:1,statusOnlyListReloads:0,idleListReloads:0,historyDateCorrect:true,permissionFailureSurfaced:true});await page.close()
 }
 assert.deepEqual(errors,[]);if(report)await fs.writeFile(path.join(report,'browser-results.json'),JSON.stringify({results,pageErrors:errors,apiStubbed:true},null,2));console.log('PASS: direct calendar retry; double-click coalescing, network recovery, pending/result/failure states, history dates, permissions, no idle event reloads; mobile/desktop light/dark.')
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await fs.rm(temp,{recursive:true,force:true})}
