// Visual catalogue of management routes/dialogs, backed only by a temporary DB.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeApi, LOCAL_MANAGEMENT_API_PREFIX } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
const {chromium}=await import(pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href)
const root=await mkdtemp(join(tmpdir(),'knowledge-catalog-'))
const provider=new LocalKnowledgeProvider(join(root,'knowledge.sqlite'))
const routes=[],ctx={webServer:{register(route){routes.push(route);return()=>{}}},get(){}}
registerKnowledgeApi(ctx,provider,LOCAL_MANAGEMENT_API_PREFIX,{authMode:'same-origin',service:{current:()=>({publicApiEnabled:false,publicApiPrefix:'/knowledge-api/v1'})}})
registerKnowledgeWeb(ctx,'/knowledge',LOCAL_MANAGEMENT_API_PREFIX,'same-origin')
const library=await provider.createKnowledgeBase({name:'设计验收库',group:'工作规范',description:'隔离界面审查',defaultTags:[],extractionInstructions:''})
const draft={knowledgeBaseId:library.id,group:'设计规范',title:'界面一致性验收',body:'## 验收记录\n\n检查按钮、菜单、确认与响应式布局。',type:'procedure',tags:[],scope:{kind:'global'},confidence:.9}
const entry=await provider.create(draft)
await provider.propose({action:'create',draft:{...draft,title:'待审核的设计规范'},reason:'本次审查已确认的交互约定'})
const note=await provider.createNoteDocument('审查笔记.md',null,'# 界面审查\n\n## 按钮\n\n统一交互反馈。')
const server=createServer((req,res)=>{
  const route=routes.find(route=>req.url.split('?')[0]===route.path||req.url.startsWith(route.path+'/'))
  if(route)return void route.handler(req,res)
  if(req.url.startsWith('/knowledge-control/v1/models'))return res.writeHead(200,{'content-type':'application/json'}).end('{"providers":[]}')
  res.writeHead(404).end()
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${server.address().port}/knowledge/`
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1280,height:850},reducedMotion:'reduce'})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
let count=0
async function visit(view,params={}) {
  await page.setViewportSize({width:1280,height:850})
  await page.goto(base+'?'+new URLSearchParams({view,projectId:'/workspace/design',sessionId:'fixture',...params}))
  await page.locator('.app-shell[data-loading="false"]').waitFor()
  const labels={overview:'概览',entries:'知识文档',notes:'笔记文档',shares:'已分享',candidates:'待审核',bases:'知识库与挂载',tokens:'访问管理'}
  if(await page.locator('.app-shell').getAttribute('data-view')!==view){
    await page.locator('.sidebar .nav-button').filter({hasText:labels[view]}).click()
    await page.locator(`.app-shell[data-view="${view}"][data-loading="false"]`).waitFor()
  }
}
async function inspect(name,open,{compact=false}={}) {
  await page.setViewportSize({width:1280,height:850});await open()
  const dialog=page.getByRole('dialog');await dialog.waitFor()
  for(const [width,height,scheme]of [[1280,850,'light'],[375,812,'dark'],[812,375,'dark']]){
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'})
    const box=await dialog.boundingBox(),footer=await dialog.locator('.dialog-footer').boundingBox()
    assert.ok(box.x>=0 && box.y>=0 && box.x+box.width<=width+1 && box.y+box.height<=height+1,`${name}: viewport ${width}`)
    assert.ok(Math.abs(box.y+box.height/2-height/2)<2 && Math.abs(box.x+box.width/2-width/2)<2,`${name}: centered`)
    assert.ok(footer.y+footer.height<=height+1,`${name}: footer visible`)
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`${name}: no inner overflow`)
    if(compact)assert.ok(box.height<440,`${name}: short form must shrink`)
    if(name==='笔记历史'){
      const content=dialog.locator('.note-history-content')
      await content.getByText('统一交互反馈。',{exact:true}).waitFor()
      assert.ok((await content.boundingBox()).height>50,'history content must not collapse behind the timeline')
      await content.getByText('统一交互反馈。',{exact:true}).scrollIntoViewIfNeeded()
      const paragraph=await content.getByText('统一交互反馈。',{exact:true}).boundingBox()
      assert.ok(paragraph.y>=box.y && paragraph.y+paragraph.height<=footer.y,'history text reachable without hiding footer')
    }
    await page.screenshot({path:join(root,`${name}-${width}-${scheme}.png`)})
  }
  await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click()
  if(await page.getByRole('alertdialog').count())await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click()
  await dialog.waitFor({state:'hidden'});count++
}
try {
  for(const view of ['entries','notes','shares','candidates','bases','tokens']){
    await visit(view)
    for(const [width,height,scheme]of [[1280,850,'light'],[375,812,'dark']]){
      await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${view}: page overflow`)
      await page.screenshot({path:join(root,`page-${view}-${width}-${scheme}.png`)})
    }
  }
  await visit('bases')
  await page.getByRole('tab',{name:/^知识库/}).click()
  await inspect('创建知识库',()=>page.getByRole('button',{name:'+ 创建知识库',exact:true}).click())
  await inspect('本机回写模型',()=>page.getByRole('button',{name:'本机回写模型',exact:true}).click())
  await inspect('创建分组',()=>page.getByRole('button',{name:'新建分组',exact:true}).click())
  const card=page.locator('.base-card').filter({hasText:'设计验收库'})
  await inspect('编辑知识库',()=>card.getByRole('button',{name:'编辑',exact:true}).click())
  await inspect('归档知识库',()=>card.getByRole('button',{name:'归档',exact:true}).click(),{compact:true})
  await page.setViewportSize({width:1280,height:850})
  await page.getByRole('tab',{name:/项目与会话挂载/}).click()
  await inspect('挂载设置',()=>page.locator('.mount-list-row').filter({hasText:'设计验收库'}).getByRole('button',{name:'挂载',exact:true}).click())
  await visit('tokens')
  await inspect('创建令牌',()=>page.getByRole('button',{name:'+ 创建令牌',exact:true}).click())
  await visit('notes')
  await inspect('新建笔记',()=>page.locator('.notes-content-actions').getByRole('button',{name:'新建文档',exact:true}).click(),{compact:true})
  await inspect('新建目录',()=>page.locator('.notes-content-actions').getByRole('button',{name:'新建目录',exact:true}).click(),{compact:true})
  await inspect('笔记指令',()=>page.getByRole('button',{name:'会话指令',exact:true}).click())
  await visit('shares')
  await inspect('导入分享',()=>page.getByRole('button',{name:'从分享导入',exact:true}).click())
  await visit('notes',{noteId:note.id})
  await page.locator('.ProseMirror').waitFor()
  const noteAction=async name=>{await page.locator('.notes-document-more > summary').click();await page.getByRole('menuitem',{name,exact:true}).click()}
  await inspect('笔记历史',()=>noteAction('页面历史'))
  await inspect('笔记重命名',()=>noteAction('重命名'),{compact:true})
  await provider.upsertMount({knowledgeBaseId:library.id,targetKind:'session',targetId:'fixture',enabled:true,recallEnabled:true,writeMode:'audit',includeTags:[],excludeTags:[],extractionInstructions:''})
  const [document]=await provider.listDocuments(library.id)
  await visit('entries',{knowledgeBaseId:library.id,documentId:document.id})
  await page.locator('.ProseMirror').waitFor()
  const docAction=async name=>{await page.locator('.notes-document-more > summary').click();await page.getByRole('menuitem',{name,exact:true}).click()}
  await inspect('结束文档',()=>docAction('标记结束'))
  await inspect('删除文档',()=>docAction('删除文档'),{compact:true})
  await visit('candidates')
  await inspect('拒绝候选',()=>page.locator('.candidate-actions').getByRole('button',{name:'拒绝',exact:true}).click(),{compact:true})
  await inspect('编辑候选',()=>page.locator('.candidate-actions button').nth(1).click())
  assert.deepEqual(errors,[])
  console.log(`PASS: 6 management routes + ${count} dialog families, light/dark, desktop/mobile/landscape, centered/content-sized/visible footer. Screenshots: ${root}`)
} catch(error){console.error('Catalogue:',root,error);await page.screenshot({path:join(root,'failed.png')}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,1500));throw error}
finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await provider.close()}
