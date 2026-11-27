import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Store } from '../worklog/store.js'
import { JournalService } from '../worklog/service.js'
import { ICloudSync } from '../worklog/calendar/icloud-sync.js'
import { addDays } from '../worklog/calendar/time.js'
const {chromium}=await import(process.env.DSH_PLAYWRIGHT_MODULE??'playwright')
const repo=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-groups-')),report=process.env.DSH_CALENDAR_REPORT
let server,browser,store
try{
  store=new Store(':memory:');const c=store.calendar,day=c.info().today,calls=[],errors=[],results=[]
  c.configureGroups({revision:0,items:[...c.groups().items,...Array.from({length:11},(_,i)=>({id:'group-'+i,name:i===0?'生活与个人安排':'项目分组 '+(i+1),color:['blue','purple','rose','green'][i%4]}))]})
  for(let i=0;i<60;i++)c.mutate('create',{requestId:randomUUID(),event:{title:(i%3===0?'一条需要完整阅读的较长安排标题：核对构建产物并同步验收结果 ':'安排 ')+i,kind:['goal','event','reminder'][i%3],day,groupId:i<4?'default':'group-'+(i%11),tags:[i%2?'验收':'构建'],...(i===2?{remindAt:new Date(Date.now()-60000).toISOString()}:{})}})
  const cloud='https://p12-caldav.icloud.com/123/calendars/'
  store.icloud=new ICloudSync(store,undefined,()=>({discover:async()=>[{id:cloud+'work/',name:'工作'},{id:cloud+'personal/',name:'个人'}]}))
  await store.icloud.connect({account:'fixture@example.test',password:'aaaa-bbbb-cccc-dddd',calendar:cloud+'work/'},new AbortController().signal)
  const service=new JournalService(store,{},async()=>[])
  await build({stdin:{resolveDir:repo,loader:'jsx',contents:`import {createRoot} from 'react-dom/client';import {Calendar} from './worklog/ui/Calendar.jsx';import {CalendarReminders} from './src/calendar-reminders.tsx';import css from './worklog/client.css';import hostCss from './src/client.css';const style=document.createElement('style');style.textContent=css+hostCss;document.head.append(style);window.openedCalendar=[];createRoot(document.getElementById('root')).render(<Calendar/>);createRoot(document.getElementById('reminders')).render(<CalendarReminders openCalendar={day=>window.openedCalendar.push(day)}/>);`},outfile:path.join(temp,'fixture.js'),bundle:true,platform:'browser',jsx:'automatic',loader:{'.css':'text'}})
  const js=await fs.readFile(path.join(temp,'fixture.js'))
  server=createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,'http://localhost')
      if(u.pathname==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(js);return}
      if(u.pathname.startsWith('/worklog-control/v1/')){
        assert.equal(req.headers['x-dsh-worklog-client'],'workspace')
        let data={};if(req.method==='POST'){const parts=[];for await(const chunk of req)parts.push(chunk);data=JSON.parse(Buffer.concat(parts))}
        calls.push({path:u.pathname,method:req.method,data})
        const result=await service.browser(req.method,u.pathname.slice('/worklog-control/v1'.length),data,u.searchParams)
        res.writeHead(200,{'content-type':'application/json;charset=utf-8'});res.end(JSON.stringify(result));return
      }
      res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#27313a;--text-secondary:#69757c;--dialog-surface:#f0f2f4;--accent:#38606b;--on-accent:white;--border:#a5b2bd33;--material-pane:#f0f2f4}body{margin:0;font:14px system-ui;background:var(--dialog-surface)}*{box-sizing:border-box}#reminders{position:fixed;right:12px;bottom:8px}#root{min-height:100dvh}</style><div id="root"></div><div id="reminders"></div><script src="/fixture.js"></script>')
    }catch(e){res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({args:['--no-sandbox']})
  for(const width of [320,390,1024,1440])for(const dark of [false,true]){
    const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.clock.install();await page.addInitScript(()=>{window.ackCalls=[];window.failAck=true;const original=window.fetch.bind(window);window.fetch=(url,options={})=>{if(String(url).endsWith('/calendar-reminder-ack')){window.ackCalls.push(JSON.parse(options.body));if(window.failAck){window.failAck=false;return Promise.reject(Error('模拟提醒网络失败'))}}return original(url,options)}});await page.goto('http://127.0.0.1:'+server.address().port)
    await page.evaluate(d=>{document.body.toggleAttribute('data-ds-dark-theme',d);if(d){document.documentElement.style.setProperty('--text','#e4e9ed');document.documentElement.style.setProperty('--text-secondary','#9da9b2');document.documentElement.style.setProperty('--dialog-surface','#252b31')}},dark)
    await page.getByRole('button',{name:'＋ 新建',exact:true}).waitFor();console.log('Loaded UI',width,dark)
    const popup=page.getByRole('region',{name:'到期提醒',exact:true})
    if(await popup.count()){
      const before=calls.filter(call=>call.path.endsWith('/calendar-reminder-ack')).length
      await popup.getByRole('button',{name:'知道了',exact:true}).evaluate(button=>{for(let i=0;i<20;i++)button.click()})
      await popup.getByRole('alert').filter({hasText:'模拟提醒网络失败'}).waitFor()
      assert.equal(await page.evaluate(()=>window.ackCalls.length),1)
      await popup.getByRole('button',{name:'知道了',exact:true}).click()
      await popup.getByText('没有待处理的到期提醒。',{exact:true}).waitFor()
      assert.equal(calls.filter(call=>call.path.endsWith('/calendar-reminder-ack')).length-before,1)
      assert.equal(await page.evaluate(()=>window.ackCalls[0].requestId===window.ackCalls[1].requestId),true)
      await popup.getByRole('button',{name:'收起到期提醒',exact:true}).click()
      const beforeHidden=calls.filter(call=>call.path.endsWith('/calendar-reminders')).length
      await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))})
      await page.clock.fastForward(180000);assert.equal(calls.filter(call=>call.path.endsWith('/calendar-reminders')).length,beforeHidden)
      const resumed=page.waitForResponse(response=>response.url().endsWith('/calendar-reminders'))
      await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))})
      await resumed;assert.equal(await popup.count(),0)
    }
    const reads=calls.filter(call=>call.path.endsWith('/calendar')).length
    await page.getByRole('search',{name:'筛选日历'}).getByLabel('分组筛选',{exact:true}).selectOption('group-0')
    await page.getByRole('search',{name:'筛选日历'}).getByLabel('类型筛选',{exact:true}).selectOption('event')
    await page.getByRole('searchbox').fill('安排')
    assert.equal(calls.filter(call=>call.path.endsWith('/calendar')).length,reads,'typing filters must not refetch calendar pages')
    await page.getByRole('button',{name:'列表',exact:true}).click()
    await page.getByRole('button',{name:'清除筛选',exact:true}).click()
    assert.equal(await page.locator('.wc-list-item').count(),60)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    if(report)await page.screenshot({path:path.join(report,'groups-list-'+width+'-'+(dark?'dark':'light')+'.png'),fullPage:true})
    // Create an actual reminder through the real editor and server, then clear it.
    await page.getByRole('button',{name:'＋ 新建',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'新建安排',exact:true})
    await dialog.getByLabel('类型',{exact:true}).selectOption('reminder')
    await dialog.getByLabel('分组',{exact:true}).selectOption('group-0')
    await dialog.getByLabel('标题',{exact:true}).fill('浏览器新提醒 '+width+' '+dark)
    await dialog.getByLabel('提醒时间',{exact:true}).fill(day+'T15:30')
    await dialog.getByRole('button',{name:'保存安排',exact:true}).click();await dialog.waitFor({state:'detached'})
    const saved=c.list(new URLSearchParams({from:day,to:addDays(day,1),query:'浏览器新提醒 '+width+' '+dark})).items[0]
    assert.equal(saved.kind,'reminder');assert.equal(saved.groupId,'group-0');assert.equal(saved.remindAt,Date.parse(day+'T15:30:00+08:00'))
    c.mutate('delete',{requestId:randomUUID(),id:saved.id,revision:saved.revision})
    // Calendar grouping and saved-account mappings use actual API handlers.
    await page.locator('summary[aria-label="日历更多操作"]').click();await page.getByRole('button',{name:'管理分组',exact:true}).click()
    const groupDialog=page.getByRole('dialog',{name:'日历分组',exact:true})
    await groupDialog.getByRole('button',{name:'＋ 添加分组',exact:true}).click()
    await groupDialog.locator('.wc-group-editor input').last().fill('浏览器分组 '+width+' '+dark)
    if(report)await page.screenshot({path:path.join(report,'groups-dialog-'+width+'-'+(dark?'dark':'light')+'.png'),fullPage:true})
    await groupDialog.getByRole('button',{name:'保存分组',exact:true}).click();await groupDialog.waitFor({state:'detached'})
    assert.ok(c.groups().items.some(group=>group.name==='浏览器分组 '+width+' '+dark))
    await page.getByRole('button',{name:'日历账号',exact:true}).click()
    const accounts=page.getByRole('dialog',{name:'日历账号',exact:true})
    await accounts.getByRole('checkbox',{name:'同步 个人',exact:true}).check()
    await accounts.getByLabel('个人 的本地分组',{exact:true}).selectOption('group-0')
    await accounts.getByLabel('个人 同步方向',{exact:true}).selectOption('pull')
    await accounts.getByRole('button',{name:'保存同步选择',exact:true}).click()
    await accounts.getByRole('status').filter({hasText:'同步选择已保存'}).waitFor()
    assert.equal(store.icloud.status().mappings.find(mapping=>mapping.groupId==='group-0').direction,'pull')
    if(report)await page.screenshot({path:path.join(report,'groups-account-'+width+'-'+(dark?'dark':'light')+'.png'),fullPage:true})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    results.push({width,dark,denseItems:60,groupCount:c.groups().items.length,filtersWithoutReads:true,reminderCreated:true,mappingSaved:true,noOverflow:true})
    await page.close()
    // Reset mapping for the next independent browser context.
    await store.icloud.configureMappings({revision:store.icloud.status().revision,mappings:[{groupId:'default',calendar:cloud+'work/',direction:'both'}]},new AbortController().signal)
  }
  assert.deepEqual(errors,[])
  if(report)await fs.writeFile(path.join(report,'groups-browser-results.json'),JSON.stringify({results,pageErrors:errors,realStore:true,externalICloudMocked:true},null,2)+'\n')
  console.log('PASS: 8 dense calendar UI scenarios; real editor reminder writes, local filters, group settings, saved-account mapping, due acknowledgment and phone/desktop fit.')
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}store?.close();await fs.rm(temp,{recursive:true,force:true})}
