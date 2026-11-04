// Isolated filesystem and SQLite; never operates on the production vault.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {LocalKnowledgeProvider} from '../lib/local-provider.js'
import {NoteVault} from '../lib/notes/vault.js'
import {registerKnowledgeApi,LOCAL_MANAGEMENT_API_PREFIX} from '../lib/api.js'
import {registerKnowledgeWeb} from '../lib/web.js'
const {chromium}=await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE?pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href:'playwright-core')
const root=await mkdtemp(join(tmpdir(),'vault-ui-')),provider=new LocalKnowledgeProvider(join(root,'kb.sqlite'))
let now=100000
const vault=new NoteVault(join(root,'vault'),{all:()=>provider.notes.syncManifest().nodes,read:id=>provider.readNote(id),readVersion:(id,v)=>provider.readNoteVersion(id,v),
 update:(id,b,v)=>provider.updateNoteContent(id,b,undefined,v,'外部文件修改'),relocate:(...args)=>provider.notes.relocate(...args),
 create:(k,n,p,b)=>k==='folder'?provider.createNoteFolder(n,p):provider.createNoteDocument(n,p,Buffer.from(b).toString())},join(root,'index.json'),false,{stableMs:0,missingMs:30000,now:()=>now})
const routes=[],ctx={webServer:{register:r=>{routes.push(r);return()=>{}}},get(){}}
registerKnowledgeApi(ctx,provider,LOCAL_MANAGEMENT_API_PREFIX,{authMode:'same-origin',noteWorkspace:{vault},service:{current:()=>({publicApiEnabled:false,publicApiPrefix:'/knowledge-api/v1'})}})
registerKnowledgeWeb(ctx,'/knowledge',LOCAL_MANAGEMENT_API_PREFIX,'same-origin')
const server=createServer((req,res)=>{const route=routes.find(r=>req.url.split('?')[0]===r.path||req.url.startsWith(r.path+'/'));if(route)void route.handler(req,res);else{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const base=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const n=await provider.createNoteDocument('初始笔记',null,'最初正文')
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`${base}/knowledge/?view=notes&noteId=${n.id}`)
 await page.locator('.ProseMirror').waitFor()
 const folder=await provider.createNoteFolder('新目录')
 await page.getByRole('treeitem').filter({hasText:'新目录'}).waitFor({timeout:12000})
 await provider.renameNote(n.id,'更名笔记.md');await provider.moveNote(n.id,folder.id)
 await page.waitForFunction(()=>document.querySelector('.notes-document-title')?.textContent==='更名笔记',{timeout:12000})
 await page.waitForFunction(()=>document.querySelector('.notes-document-toolbar .notes-breadcrumb')?.textContent.includes('新目录'),{timeout:12000})
 await provider.updateNoteContent(n.id,Buffer.from('外部更新正文'),undefined,n.version,'外部文件修改')
 await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('外部更新正文'),{timeout:12000})
 await page.locator('.ProseMirror').fill('正在输入的草稿')
 await page.evaluate(()=>{window.originalNoteEditor=document.querySelector('.ProseMirror')})
 await provider.renameNote(folder.id,'目录已改名')
 await page.waitForFunction(()=>document.querySelector('.notes-document-toolbar .notes-breadcrumb')?.textContent.includes('目录已改名'),{timeout:12000})
 assert.equal(await page.locator('.ProseMirror').innerText(),'正在输入的草稿')
 assert.equal(await page.evaluate(()=>window.originalNoteEditor===document.querySelector('.ProseMirror')),true)
 await provider.updateNoteContent(n.id,Buffer.from('另一份外部更新'),undefined,2,'外部文件修改')
 await page.getByText('文档有新版本，当前内容已保留',{exact:true}).waitFor({timeout:12000})
 assert.equal(await page.locator('.ProseMirror').innerText(),'正在输入的草稿')
 await provider.deleteNote(n.id)
 await page.getByText('文档已删除或不可访问，草稿仍保留',{exact:true}).waitFor({timeout:12000})
 assert.equal(await page.locator('.ProseMirror').innerText(),'正在输入的草稿')
 const clean=await provider.createNoteDocument('待删除',null,'无草稿')
 const other=await browser.newPage({viewport:{width:1440,height:900}})
 await other.goto(`${base}/knowledge/?view=notes&noteId=${clean.id}`);await other.locator('.ProseMirror').waitFor()
 await provider.deleteNote(clean.id)
 await other.locator('.notes-content.is-folder').waitFor({timeout:12000})
 const many=[]
 for(let i=0;i<45;i++)many.push(await provider.createNoteDocument(`分页${String(i).padStart(2,'0')}`,folder.id,'内容'))
 const listing=await browser.newPage({viewport:{width:1440,height:900}})
 await listing.goto(`${base}/knowledge/?view=notes&noteId=${folder.id}`)
 await listing.locator('.notes-content [data-load-more]').click()
 await listing.waitForFunction(()=>document.querySelectorAll('.notes-content .notes-file-row').length===45)
 await provider.renameNote(many[0].id,'实时改名.md')
 await listing.locator('.notes-content .notes-file-main').filter({hasText:'实时改名.md'}).waitFor({timeout:12000})
 assert.equal(await listing.locator('.notes-content .notes-file-row').count(),45,'background refresh must preserve loaded pages')
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({result:'passed',checks:['automatic tree insertion','rename and move breadcrumb','clean body update','dirty draft/editor identity preserved','dirty deletion preserved','clean deletion returns to root']}))
}finally{await browser.close();await vault.close();await provider.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})}
