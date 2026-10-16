// Actual React sidebar/worklog components with isolated APIs; no production data.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { knowledgeDesignCss } from '../lib/design-tokens.js'
import { Store } from '../worklog/store.js'
import { handler } from '../worklog/http.js'
import { dayOf } from '../worklog/domain.js'

const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = await mkdtemp(join(tmpdir(), 'knowledge-surfaces-'))
const store = new Store(':memory:')
const day = dayOf(Date.now(), 'Asia/Shanghai')
store.note(day, '统一知识库侧栏、弹窗和按钮反馈', '/workspace/design')
store.save(day, '# 工作日报\n\n完成界面一致性检查。', 0)
const serveWorklog = handler(store, {}, () => undefined, async () => [{ id: 'test', models: [{ id: 'test', name: '测试模型' }] }])
// Only host icon exports are replaced; business components and React are real.
const iconFiles = await Promise.all(['src/knowledge-activity-panel.tsx','src/knowledge-activity-notes.tsx','src/knowledge-activity-scope.tsx'].map(file => readFile(file, 'utf8')))
const icons = [...new Set(iconFiles.join('\n').match(/Icon\w+OutlineRegular/g))]
const bundle = await build({ stdin: { contents: `
  import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {KnowledgeActivityPanel} from './src/knowledge-activity-panel.tsx';
  import {Workspace} from './worklog/ui/Workspace.jsx';
  const controller={selection:()=>({}),select(){},close(){},openWorkspace(){}};
  const sessions=fn=>fn({byId:{fixture:{cwd:'/workspace/design'}}});
  function Fixture(){const [view,setView]=useState('sidebar');return <>
    <nav id="fixture-nav"><button onClick={()=>setView('sidebar')}>侧栏测试</button><button onClick={()=>setView('worklog')}>日报测试</button></nav>
    {view==='sidebar'?<aside id="sidebar"><KnowledgeActivityPanel sessionId="fixture" useSessions={sessions} controller={controller}/></aside>
    :<div className="knowledge-worklog"><Workspace embedded currentProject="/workspace/design"/></div>}
  </>};createRoot(document.querySelector('#root')).render(<Fixture/>);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', plugins: [{ name: 'host-icons', setup(build) {
  build.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/}, () => ({path:'icons',namespace:'fixture'}))
  build.onLoad({filter:/.*/,namespace:'fixture'}, () => ({loader:'jsx',resolveDir:process.cwd(),contents:`import React from 'react';${icons.map(name=>`export const ${name}=({size=16,...props})=><svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...props}><path d="M5 7h14v12H5zM5 11h14"/></svg>;`).join('\n')}`}))
} }] })
const css = knowledgeDesignCss() + (await Promise.all(['src/client.css','src/knowledge-activity.css','worklog/client.css','worklog/web-embedded.css','web/discard-confirmation.css'].map(file=>readFile(file,'utf8')))).join('\n') + `
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-ui)}
  #fixture-nav{height:44px;display:flex;gap:8px;align-items:center;padding-inline:12px}
  #sidebar{width:min(360px,100vw);height:calc(100dvh - 44px);margin-left:auto}
  .knowledge-worklog{height:calc(100dvh - 44px)}
`
const doc = { id:'doc', knowledgeBaseId:'base-a', relPath:'设计规范/界面一致性.md', title:'知识库界面规范与交互检查清单——包含很长的文件名用于测试完整名称', documentState:'resolved', updatedAt:'2026-10-16T00:00:00Z', group:'设计规范', content:'# 界面规范\n\n## 按钮\n\n' + '按钮和选项保持一致。\n\n'.repeat(40) + '## 动效\n\n短过渡。\n\n### 动效\n\n重复标题也能独立定位。' }
const note = {id:'note',parentId:null,kind:'document',name:'很长的笔记文档名称——记录设计规范与按钮和菜单的交互检查.md',mediaType:'text/markdown',editable:true,size:1234,version:1,updatedAt:doc.updatedAt}
const mounts = ['a','b'].map((key,i)=>({knowledgeBaseId:`base-${key}`,enabled:true,inheritedFrom:i?'session':'project',base:{id:`base-${key}`,name:i?'团队知识库':'产品设计与交互规范知识库'}}))
const server = createServer(async (req,res)=>{
  const url=new URL(req.url,'http://localhost')
  const json=data=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(data))
  if(url.pathname==='/fixture.js') return res.writeHead(200,{'content-type':'text/javascript'}).end(bundle.outputFiles[0].text)
  if(url.pathname==='/fixture.css') return res.writeHead(200,{'content-type':'text/css'}).end(css)
  if(url.pathname==='/worklog-control/v1/collector-state') return json({remote:false})
  if(url.pathname.startsWith('/worklog-control/')) return serveWorklog(req,res)
  if(url.pathname.endsWith('/activity/mounts')) return json(mounts)
  if(url.pathname.endsWith('/activity/documents')) return json({items:[doc],total:1})
  if(url.pathname.endsWith('/activity/documents/doc')) return json(doc)
  if(url.pathname.endsWith('/activity/notes')) return json([note])
  if(url.pathname.endsWith('/activity/notes/note/content')) return json({node:note,content:'# 笔记正文\n\n检查阅读状态与完整标题。'})
  res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const page=await browser.newPage({viewport:{width:1280,height:850}})
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const scope=page.locator('.dsh-knowledge-activity-scope-trigger')
  await scope.waitFor();await scope.focus();await page.keyboard.press('ArrowDown')
  assert.equal(await page.getByRole('option').first().evaluate(el=>el===document.activeElement),true)
  await page.keyboard.press('End');await page.keyboard.press('Enter')
  assert.match(await scope.innerText(),/团队知识库/)
  await scope.click();await page.keyboard.press('Escape')
  assert.equal(await scope.evaluate(el=>el===document.activeElement),true)
  await scope.click();await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('listbox').count(),0)
  assert.equal(await page.getByRole('button',{name:'刷新文档',exact:true}).evaluate(el=>el===document.activeElement),true)
  for(const [width,height,scheme] of [[1280,850,'light'],[390,844,'dark'],[812,375,'dark']]) {
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'})
    await page.evaluate(scheme=>{document.documentElement.dataset.colorScheme=scheme;document.body.toggleAttribute('data-ds-dark-theme',scheme==='dark')},scheme)
    assert.equal(await page.locator('.dsh-knowledge-activity-tabs button.is-active').evaluate(el=>getComputedStyle(el).borderRadius),'10px')
    const group=page.locator('.dsh-knowledge-activity-group-toggle').first();await group.waitFor()
    assert.equal(await group.getAttribute('aria-expanded'),'false','sidebar groups default to collapsed')
    assert.equal(await page.locator('.dsh-knowledge-activity-row').count(),0)
    await group.click()
    const row=page.locator('.dsh-knowledge-activity-row').first();await row.waitFor()
    assert.equal(await row.getAttribute('title'),`${doc.title}\n${doc.relPath}`)
    assert.ok(await row.locator('.dsh-knowledge-activity-row-meta').getByText('已解决').isVisible())
    await scope.click()
    const menu=page.getByRole('listbox');const bounds=await menu.boundingBox()
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width+1 && bounds.y+bounds.height<=height+1)
    assert.equal(await menu.evaluate(el=>el.getAnimations().length),0,'reduced-motion menu')
    await page.screenshot({path:join(root,`sidebar-menu-${width}-${scheme}.png`)})
    await page.keyboard.press('Escape');await row.click()
    assert.equal(await page.locator('.dsh-knowledge-activity-document-heading h2').getAttribute('title'),doc.title)
    await page.getByRole('navigation',{name:'文档大纲'}).waitFor()
    assert.equal(await page.locator('.dsh-knowledge-activity-outline nav button').count(),3)
    const outline=page.locator('.dsh-knowledge-activity-outline')
    const beforeOutline=await outline.boundingBox(),beforeBody=await page.locator('.dsh-knowledge-activity-markdown').boundingBox()
    assert.ok(beforeOutline.x>=beforeBody.x+beforeBody.width,'outline belongs to the right of the complete body')
    assert.ok(Math.abs(beforeOutline.y-beforeBody.y)<1,'outline and body start together')
    await page.locator('.dsh-knowledge-activity-outline nav button').last().click()
    assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'H3')
    assert.ok(await page.locator('.dsh-knowledge-activity-markdown').evaluate(el=>el.scrollTop>0))
    assert.deepEqual(await outline.boundingBox(),beforeOutline,'outline must not move with body scrolling')
    const bodyHandle=await page.locator('.dsh-knowledge-activity-markdown').elementHandle()
    await page.getByRole('button',{name:'收起大纲',exact:true}).click()
    assert.equal(await page.getByRole('navigation',{name:'文档大纲'}).isVisible(),false)
    assert.ok((await page.locator('.dsh-knowledge-activity-markdown').boundingBox()).width>beforeBody.width)
    await page.getByRole('button',{name:'展开大纲',exact:true}).click()
    await page.getByRole('navigation',{name:'文档大纲'}).waitFor()
    assert.ok(await bodyHandle.evaluate(el=>el===document.querySelector('.dsh-knowledge-activity-markdown')),'outline toggle must not remount the body')
    assert.ok(await bodyHandle.evaluate(el=>el.scrollTop>0),'outline toggle must not return the reader to the top')
    await bodyHandle.dispose()
    await page.screenshot({path:join(root,`sidebar-right-outline-${width}-${scheme}.png`)})
    await page.getByRole('button',{name:'文档目录',exact:true}).click()
    await page.getByRole('button',{name:'笔记文档',exact:true}).click()
    await page.locator('.dsh-knowledge-activity-row').first().waitFor()
    assert.equal(await page.locator('.dsh-knowledge-activity-row').first().getAttribute('title'),note.name)
    await page.locator('.dsh-knowledge-activity-row').first().click()
    await page.locator('.dsh-knowledge-activity-markdown').waitFor()
    await page.getByRole('navigation',{name:'文档大纲'}).getByRole('button',{name:'笔记正文',exact:true}).waitFor()
    const noteBody=await page.locator('.dsh-knowledge-activity-markdown').boundingBox(),noteOutline=await outline.boundingBox()
    assert.ok(noteOutline.x>=noteBody.x+noteBody.width,'note reader also keeps the outline to the right')
    await page.screenshot({path:join(root,`sidebar-note-${width}-${scheme}.png`)})
    await page.getByRole('button',{name:'知识文档',exact:true}).click()
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  }
  await page.getByRole('button',{name:'日报测试',exact:true}).click()
  await page.getByRole('button',{name:'补记一条',exact:true}).waitFor()
  for(const [width,height,scheme] of [[1280,850,'light'],[390,844,'dark'],[812,375,'dark']]) {
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'})
    await page.evaluate(scheme=>{document.documentElement.dataset.colorScheme=scheme;document.body.toggleAttribute('data-ds-dark-theme',scheme==='dark')},scheme)
    await page.getByRole('button',{name:'采集设置',exact:true}).click()
    const dialog=page.getByRole('dialog'),footer=dialog.locator('.wl-dialog-actions')
    await dialog.getByRole('button',{name:'保存设置',exact:true}).waitFor()
    const bounds=await dialog.boundingBox(),actions=await footer.boundingBox()
    assert.ok(Math.abs(bounds.y+bounds.height/2-height/2)<2,'worklog centered')
    assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=width+1 && bounds.y+bounds.height<=height+1)
    assert.ok(actions.y+actions.height<=height && actions.height>30,'actions never scroll out of viewport')
    assert.equal(await dialog.locator('header button').innerText(),'','shared icon close, not text button')
    await dialog.locator('.wl-dialog-content').evaluate(el=>el.scrollTop=10000)
    assert.deepEqual(await footer.boundingBox(),actions,'scroll must not move actions')
    await page.screenshot({path:join(root,`worklog-settings-${width}-${scheme}.png`)})
    await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click()
    await page.getByRole('button',{name:'补记一条',exact:true}).click()
    await dialog.locator('textarea').fill(`界面检查 ${width}`)
    await dialog.getByRole('button',{name:'保存',exact:true}).click()
    await dialog.waitFor({state:'hidden'})
    assert.ok(store.detail(day).records.some(r=>r.answer===`界面检查 ${width}`),'portalled submit button still submits the correct form')
    await page.getByLabel('更多日报操作').click()
    await page.getByRole('button',{name:'编辑日报',exact:true}).click()
    await dialog.locator('textarea').fill('# 已修订日报')
    await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click()
    await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
    assert.equal(await dialog.locator('textarea').inputValue(),'# 已修订日报')
    await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click()
    await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click()
    assert.equal(await page.locator('.wl-more').evaluate(el=>el.open),false,'menu closes when an action opens a dialog')
  }
  await page.setViewportSize({width:1280,height:850});await page.emulateMedia({reducedMotion:'no-preference'})
  await page.getByRole('button',{name:'采集设置',exact:true}).click()
  assert.equal(await page.getByRole('dialog').evaluate(el=>getComputedStyle(el).animationDuration),'0.22s')
  await page.getByRole('dialog').getByLabel('启用工作素材采集',{exact:true}).check()
  await page.getByRole('dialog').getByRole('button',{name:'保存设置',exact:true}).click()
  await page.getByRole('dialog').waitFor({state:'hidden'})
  assert.equal(store.config().enabled,true,'settings footer submits original form')
  assert.deepEqual(errors,[])
  console.log(`PASS: real sidebar knowledge/notes, keyboard select, long titles/status, React worklog settings/edit/notes, fixed actions/form submit, light/dark/landscape/reduced motion. Screenshots: ${root}`)
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close()}
