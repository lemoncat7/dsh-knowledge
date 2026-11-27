import assert from 'node:assert/strict'
import {build} from 'esbuild'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'node:http'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {Store} from '../worklog/store.js'
import {JournalService} from '../worklog/service.js'
import {ICloudSync} from '../worklog/calendar/icloud-sync.js'
const {chromium}=await import(process.env.DSH_PLAYWRIGHT_MODULE??'playwright')
const repo=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-selection-')),report=process.env.DSH_CALENDAR_REPORT
let server,browser,store
try{
  const names=['工作','生活','旅行','项目甲','共享只读','很长的日历分组名称，用来验证手机上展开选项不会出现白底或超出屏幕'],url='https://p12-caldav.icloud.com/123/calendars/'
  let discovery=0,holdInfo=false,pendingInfo
  const calendars=names.map((name,i)=>({id:url+i+'/',name,...(i===4?{writable:false}:{})}))
  const calls=[],errors=[],results=[]
  async function reset(){
    store?.close();store=new Store(':memory:')
    store.calendar.configureGroups({revision:0,items:[...store.calendar.groups().items,{id:'life',name:'生活',color:'blue'}]})
    store.calendar.mutate('create',{requestId:randomUUID(),event:{title:'原有目标保持',day:store.calendar.info().today}})
    store.icloud=new ICloudSync(store,undefined,()=>({async discover(){discovery++;return calendars}}))
    await store.icloud.connect({account:'fixture@example.test',password:'aaaa-bbbb-cccc-dddd',calendar:calendars[0].id},new AbortController().signal)
  }
  await reset()
  await build({stdin:{resolveDir:repo,loader:'jsx',contents:`import {createRoot} from 'react-dom/client';import {Calendar} from './worklog/ui/Calendar.jsx';import css from './worklog/client.css';import embedded from './worklog/web-embedded.css';const style=document.createElement('style');style.textContent=css+embedded;document.head.append(style);createRoot(document.getElementById('root')).render(<Calendar/>);`},outfile:path.join(temp,'fixture.js'),bundle:true,platform:'browser',jsx:'automatic',loader:{'.css':'text'}})
  const js=await fs.readFile(path.join(temp,'fixture.js'))
  server=createServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://localhost')
      if(u.pathname==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(js);return}
      if(u.pathname.startsWith('/worklog-control/v1/')){
        assert.equal(req.headers['x-dsh-worklog-client'],'workspace')
        let data={};if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);data=JSON.parse(Buffer.concat(chunks))}
        calls.push({path:u.pathname,method:req.method,data})
        const result=await new JournalService(store,{},async()=>[]).browser(req.method,u.pathname.slice('/worklog-control/v1'.length),data,u.searchParams)
        res.writeHead(200,{'content-type':'application/json;charset=utf-8'});if(holdInfo&&u.pathname.endsWith('/calendar-info')){holdInfo=false;pendingInfo=()=>res.end(JSON.stringify(result));return}res.end(JSON.stringify(result));return
      }
      res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#27313a;--text-secondary:#69757c;--border:#a5b2bd33;--dialog-surface:#eef1f3;--accent:#38606b;--on-accent:white;--material-pane:#eef1f3;--interaction-well:#89939b12;--interaction-tile:#8a929b16}*{box-sizing:border-box}body{margin:0;background:var(--dialog-surface);color:var(--text);font:14px system-ui}#root{min-height:100dvh}</style><body class="knowledge-worklog"><div id="root" data-ui-owned="react"></div><script src="/fixture.js"></script>')
    }catch(e){res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({args:['--no-sandbox']})
  async function choose(scope,label,option){
    const trigger=scope.getByRole('combobox',{name:new RegExp('^'+label+'：')})
    await trigger.click();await scope.getByRole('listbox',{name:label,exact:true}).getByRole('option',{name:option,exact:true}).click()
  }
  for(const width of [320,390,1024,1440])for(const dark of [false,true]){
    await reset();const page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port)
    await page.evaluate(d=>{document.documentElement.dataset.colorScheme=d?'dark':'light';document.body.toggleAttribute('data-ds-dark-theme',d);if(d){for(const [key,value]of Object.entries({'--text':'#e4e9ed','--text-secondary':'#a7b1ba','--dialog-surface':'#252b31','--material-pane':'#252b31','--accent':'#a4c9cf','--on-accent':'#17272c'}))document.documentElement.style.setProperty(key,value)}},dark)
    await page.locator('.wc-entry').first().waitFor()
    holdInfo=true
    await page.locator('summary[aria-label="日历更多操作"]').click();await page.getByRole('button',{name:'刷新日历',exact:true}).click()
    for(let attempt=0;!pendingInfo&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,5))
    assert.ok(pendingInfo,'stale calendar info response should be held for the metadata race')
    await page.locator('summary[aria-label="日历更多操作"]').click();await page.getByRole('button',{name:'管理分组',exact:true}).click()
    let manager=page.getByRole('dialog',{name:'日历分组',exact:true})
    await manager.getByRole('button',{name:'＋ 添加分组',exact:true}).click()
    await manager.locator('.wc-group-editor input').last().fill('项目甲')
    await manager.getByRole('button',{name:'＋ 添加分组',exact:true}).click()
    await manager.locator('.wc-group-editor input').last().fill('项目乙')
    assert.equal(await manager.locator('.wc-group-editor>div').count(),4)
    await choose(manager,'项目甲 的颜色','紫')
    const aligned=await manager.locator('.wc-group-editor>div').evaluateAll(rows=>rows.every(row=>{const a=row.querySelector('input').getBoundingClientRect(),b=row.querySelector('.wl-select-trigger').getBoundingClientRect(),c=row.lastElementChild.getBoundingClientRect();return Math.abs(a.bottom-b.bottom)<2&&Math.abs(a.bottom-c.bottom)<2}))
    assert.ok(aligned,'group inputs and actions must align')
    await manager.getByRole('button',{name:'保存分组',exact:true}).click();await manager.waitFor({state:'detached'});assert.equal(store.calendar.groups().items.length,4)
    pendingInfo();pendingInfo=undefined
    await page.waitForFunction(()=>document.querySelector('.wc-add-goal')?.disabled===false)
    assert.ok((await page.getByLabel('分组筛选',{exact:true}).locator('option').allTextContents()).includes('项目乙'),'a slow pre-save GET must not erase freshly saved group metadata')
    await page.locator('summary[aria-label="日历更多操作"]').click();await page.getByRole('button',{name:'管理分组',exact:true}).click()
    manager=page.getByRole('dialog',{name:'日历分组',exact:true});await manager.getByLabel('分组名称：项目乙',{exact:true}).waitFor();assert.equal(await manager.locator('.wc-group-editor>div').count(),4)
    await manager.getByRole('combobox',{name:/^生活 的颜色：/}).click()
    let menu=manager.getByRole('listbox',{name:'生活 的颜色',exact:true})
    const menuStyle=await menu.evaluate(element=>({background:getComputedStyle(element).backgroundColor,filter:getComputedStyle(element).backdropFilter,bounds:element.getBoundingClientRect().toJSON()}))
    assert.notEqual(menuStyle.background,'rgb(255, 255, 255)');assert.match(menuStyle.filter,/blur/)
    assert.ok(menuStyle.bounds.left>=0&&menuStyle.bounds.right<=width+1&&menuStyle.bounds.bottom<=900)
    if(report)await page.screenshot({path:path.join(report,'groups-menu-'+width+'-'+(dark?'dark':'light')+'.png')})
    await page.keyboard.press('Escape');assert.equal(await menu.count(),0);assert.equal(await manager.count(),1)
    await manager.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'日历账号',exact:true}).click()
    let account=page.getByRole('dialog',{name:'日历账号',exact:true})
    await account.getByRole('checkbox',{name:'同步 旅行',exact:true}).waitFor();assert.equal(await account.locator('.wc-cloud-row').count(),6)
    for(const name of ['工作','生活','项目甲','项目乙'])assert.ok(await account.locator('.wc-local-group-summary').getByText(name,{exact:true}).count())
    await account.getByRole('checkbox',{name:'同步 生活',exact:true}).check();await account.getByRole('checkbox',{name:'同步 旅行',exact:true}).check();await account.getByRole('checkbox',{name:'同步 项目甲',exact:true}).check();await account.getByRole('checkbox',{name:'同步 共享只读',exact:true}).check()
    assert.equal(await account.getByText('已选 5 / 6 个',{exact:true}).count(),1)
    await account.getByRole('combobox',{name:/^生活 的本地分组：/}).click();menu=account.getByRole('listbox',{name:'生活 的本地分组',exact:true})
    assert.ok(await menu.getByRole('option',{name:'工作（已关联）',exact:true}).isDisabled());assert.ok(await menu.getByRole('option',{name:'项目乙',exact:true}).count())
    await page.keyboard.press('End');await page.keyboard.press('Home');await page.keyboard.press('Escape')
    await choose(account,'生活 同步方向','仅下载')
    await account.getByRole('combobox',{name:/^共享只读 同步方向：/}).click();menu=account.getByRole('listbox',{name:'共享只读 同步方向',exact:true});assert.equal(await menu.getByRole('option',{name:'双向',exact:true}).isDisabled(),true);await page.keyboard.press('Escape')
    const alignment=await account.locator('.wc-cloud-row').evaluateAll(rows=>{const positions=rows.map(row=>row.querySelector('.wc-cloud-group .wl-select-trigger').getBoundingClientRect());return positions.every(box=>Math.abs(box.left-positions[0].left)<1&&Math.abs(box.right-positions[0].right)<1)})
    assert.ok(alignment,'account select columns must align across all rows')
    if(report)await page.screenshot({path:path.join(report,'account-multi-'+width+'-'+(dark?'dark':'light')+'.png')})
    await account.getByRole('button',{name:'保存同步选择',exact:true}).click();await account.getByRole('status').filter({hasText:'同步选择已保存'}).waitFor()
    assert.equal(store.icloud.status().mappings.length,5);assert.equal(store.calendar.groups().items.length,6)
    assert.equal(store.calendar.groups().items.find(group=>group.name==='项目甲').color,'purple')
    const before=discovery;await account.getByRole('button',{name:'刷新目录',exact:true}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(button=>button.textContent==='读取中…'));assert.equal(discovery,before+1)
    await account.getByRole('button',{name:'关闭弹窗',exact:true}).click();await account.waitFor({state:'detached'})
    await page.getByRole('button',{name:'日历账号',exact:true}).click();account=page.getByRole('dialog',{name:'日历账号',exact:true});await account.getByText('已选 5 / 6 个',{exact:true}).waitFor()
    assert.equal(await account.getByRole('checkbox',{checked:true}).count(),5)
    await account.getByRole('checkbox',{name:'同步 旅行',exact:true}).uncheck();await account.getByRole('button',{name:'保存同步选择',exact:true}).click();await account.getByRole('status').filter({hasText:'同步选择已保存'}).waitFor();assert.equal(store.calendar.groups().items.length,6)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await account.getByRole('button',{name:'关闭弹窗',exact:true}).click()
    await page.getByRole('button',{name:'＋ 新建',exact:true}).click();const editor=page.getByRole('dialog',{name:'新建安排',exact:true});await choose(editor,'类型','提醒');await choose(editor,'分组','生活')
    await editor.getByLabel('标题',{exact:true}).fill('实际菜单选择后保存');await editor.getByRole('button',{name:'保存安排',exact:true}).click();await editor.waitFor({state:'detached'})
    assert.equal(store.calendar.list(new URLSearchParams({from:store.calendar.info().today,to:store.calendar.info().today.slice(0,8)+String(Number(store.calendar.info().today.slice(8))+1).padStart(2,'0'),query:'实际菜单选择后保存'})).items[0].kind,'reminder')
    results.push({width,dark,localGroupsRetained:true,multipleCloudSelections:5,atomicNewGroups:2,realPopupStyled:true,keyboardEscape:true,columnsAligned:true,persistedAfterReopen:true,staleMetadataReadProtected:true})
    await page.close();console.log('Verified real menu and multi-calendar flow',width,dark)
  }
  assert.deepEqual(errors,[])
  if(report)await fs.writeFile(path.join(report,'selection-browser-results.json'),JSON.stringify({results,pageErrors:errors,realStore:true,externalDirectoryMocked:true},null,2)+'\n')
  console.log('PASS: actual dropdown menus, two group additions, five calendar selections, atomic creation, reopening, cache refresh, keyboard/disabled behavior and aligned mobile/desktop layouts in 8 theme/size scenarios.')
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}store?.close();await fs.rm(temp,{recursive:true,force:true})}
