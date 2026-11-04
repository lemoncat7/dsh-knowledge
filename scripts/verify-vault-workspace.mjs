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
 const n=await provider.createNoteDocument('测试',null,'base');await vault.scan()
 await provider.updateNoteContent(n.id,Buffer.from('网页内容'),undefined,1,'网页修改')
 await writeFile(join(root,'vault','测试.md'),'OB 内容');await vault.scan()
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`${base}/knowledge/?view=notes&noteId=${n.id}`)
 await page.getByRole('button',{name:'同步与本地文件',exact:true}).click()
 await page.getByRole('button',{name:'查看冲突',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'外部文件版本',exact:true}).inputValue(),'OB 内容')
 await page.getByRole('button',{name:'采用外部版本',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector('[aria-label="外部文件版本"]'))
 assert.equal((await provider.readNote(n.id)).content.toString(),'OB 内容')
 assert.equal((await provider.listNoteVersions(n.id))[0].source,'外部文件修改')
 await rm(join(root,'vault','测试.md'));await vault.scan();await vault.scan();now+=31000;await vault.scan()
 await page.reload();await page.getByRole('button',{name:'同步与本地文件',exact:true}).click()
 await page.locator('summary').filter({hasText:'回收站'}).click()
 await page.getByRole('button',{name:'恢复',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector('details summary')?.textContent?.includes('回收站'))
 assert.equal(await readFile(join(root,'vault','测试.md'),'utf8'),'OB 内容')
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({result:'passed',checks:['external conflict API and UI','version source','recycle restore API and UI'],root}))
}finally{await browser.close();await vault.close();await provider.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})}
