// Isolated real API + real editor/dialog. Never reads or writes production data.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = await mkdtemp(join(tmpdir(), 'note-excerpt-browser-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const note = await provider.createNoteDocument('测试来源.md', null, 'Alpha Bravo Charlie.\n\n第二段')
let handler
registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, get() {} }, provider, '/api', { authMode: 'same-origin' })
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/web/design-tokens.css"><link rel="stylesheet" href="/web/styles.css"><main id="frame" style="position:relative;padding:24px"><div id="scroll"><div id="editor"></div></div><aside id="outline"></aside></main><script src="/web/note-editor.js"></script><script type="module">
import {element,actionButton} from '/web/ui-primitives.js';
import {createDialogPresenter} from '/web/dialogs.js';
import {openNoteExcerpt} from '/web/note-excerpt.js';
const showToast=message=>window.lastToast=message, friendlyError=e=>e.message;
const {openSheet}=createDialogPresenter({element,actionButton,interfaceIcon:()=> '×',showToast,friendlyError});
const api=async(path,options={})=>{const r=await fetch('/api/'+path,{...options,headers:{'x-dsh-knowledge-client':'management-web','content-type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});const v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error?.message||v.error||'request failed'),{status:r.status});return v;};
const formField=(label,kind,value,attrs={})=>{const input=element('input',{type:kind,value,class:'input',...attrs});return {input,wrapper:element('div',{class:'field'},element('label',{},label),input)};};
const selectField=(label,items,value)=>{const input=element('select',{class:'select'},items.map(i=>element('option',{value:i.value,selected:i.value===value},i.label)));return {input,wrapper:element('div',{class:'field'},element('label',{},label),input)};};
window.showExcerpt=text=>openNoteExcerpt({node:${JSON.stringify(note)},text,api,element,openSheet,showToast,friendlyError,formField,selectField,knowledgeBasePathLabel:b=>b.name});
window.editorHandle=DshKnowledgeNoteEditor.createMarkdownEditor({host:document.querySelector('#editor'),frame:document.querySelector('#frame'),scrollHost:document.querySelector('#scroll'),outlineHost:document.querySelector('#outline'),markdown:'Alpha Bravo Charlie.\\n\\n第二段',label:'测试笔记',onChange(){},onSave(){},onExcerpt:window.showExcerpt,onOpenNote:id=>window.openedNote=id});
</script>`
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return handler(req, res)
  if (/^\/web\/[\w.-]+$/.test(req.url)) {
    try { res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(new URL('..'+req.url, import.meta.url))); return } catch { res.writeHead(404).end(); return }
  }
  res.setHeader('content-type','text/html'); res.end(html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({args:['--no-sandbox']})
try {
  const page = await browser.newPage({viewport:{width:1280,height:850}})
  const errors=[]; page.on('pageerror', e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('.ProseMirror p').first().evaluate(node=>{
    node.closest('[contenteditable]').focus();const r=document.createRange();r.setStart(node.firstChild,0);r.setEnd(node.firstChild,11);getSelection().removeAllRanges();getSelection().addRange(r)
  })
  await page.getByRole('button',{name:'摘录所选文字到知识库'}).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.locator('.note-excerpt-preview').innerText(),'Alpha Bravo')
  assert.equal(await page.getByLabel('新文档标题').isVisible(),false)
  await page.getByLabel('添加方式').selectOption('new')
  assert.equal(await page.getByLabel('搜索知识文档').isVisible(),false)
  await page.getByLabel('新文档标题').fill('摘录验证')
  await page.waitForFunction(() => document.querySelector('select[aria-label="文档分组"]')?.options.length > 1)
  await page.locator('select[aria-label="文档分组"]').selectOption({ label: '+ 新建分组…' })
  await page.getByLabel('新分组名称', { exact: true }).fill('笔记摘录')
  await page.getByRole('button',{name:'添加摘录',exact:true}).click()
  await page.getByRole('dialog').waitFor({state:'hidden'})
  const entry=(await provider.list({limit:100})).items[0]
  assert.ok(entry.body.includes(`[Alpha Bravo](note://${note.id})`))
  assert.equal((await provider.listKnowledgeNoteReferences(entry.id)).length,1)
  for(const [width,scheme] of [[375,'light'],[844,'dark']]) {
    await page.setViewportSize({width,height:700});await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'})
    const selection = width === 844 ? '长选文'.repeat(4000) + '完整末尾' : '第二段'
    await page.evaluate(text=>window.showExcerpt(text), selection)
    assert.ok((await page.locator('.note-excerpt-preview').innerText()).length < 1300,'long preview remains bounded')
    assert.equal(await page.locator('.note-excerpt-document-row').count(),0,'no documents before searching')
    await page.getByLabel('搜索知识文档').fill('摘录')
    await page.locator('.note-excerpt-document-row').first().waitFor()
    await page.getByLabel('搜索知识文档').fill('')
    assert.equal(await page.locator('.note-excerpt-document-row').count(),0,'clearing search removes results')
    assert.equal(await page.getByRole('button',{name:'添加摘录',exact:true}).isEnabled(),false)
    await page.getByLabel('搜索知识文档').fill('/')
    await page.locator('.note-excerpt-document-row').filter({hasText:'摘录验证'}).waitFor()
    await page.getByLabel('搜索知识文档').fill('摘录')
    await page.getByRole('button').filter({hasText:'摘录验证'}).click()
    const row = page.locator('.note-excerpt-document-row').filter({hasText:'摘录验证'})
    assert.equal(await row.getAttribute('title'),'摘录验证')
    assert.ok(await row.locator('span').evaluate(el=>el.getBoundingClientRect().width > 200),'excerpt text must fill the row rather than the 28px icon column')
    assert.equal(await row.locator('strong').evaluate(el=>el.scrollWidth > el.clientWidth),false,'short document titles must remain fully visible')
    await page.waitForFunction(()=>document.querySelector('.note-excerpt-fields [role="status"]')?.textContent.startsWith('将追加到：'))
    assert.equal(await page.getByRole('button',{name:'添加摘录',exact:true}).isEnabled(),true)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.screenshot({path:join(root,`excerpt-${width}.png`)})
    await page.getByRole('button',{name:'添加摘录',exact:true}).click()
    await page.getByRole('dialog').waitFor({state:'hidden'})
  }
  const updated=await provider.get(entry.id)
  assert.equal(updated.version,3)
  assert.ok(updated.body.includes('长选文'.repeat(4000) + '完整末尾'),'preview truncation must not truncate saved selection')
  await page.evaluate(body=>{
    window.editorHandle.destroy();window.editorHandle=DshKnowledgeNoteEditor.createMarkdownEditor({host:document.querySelector('#editor'),markdown:body,label:'知识正文',onChange(){},onSave(){},onOpenNote:id=>window.openedNote=id});
  },updated.body)
  await page.locator('.ProseMirror a').first().click()
  assert.equal(await page.evaluate(()=>window.openedNote),note.id)
  assert.ok((await page.evaluate(()=>window.editorHandle.getMarkdown())).includes(`note://${note.id}`),'editor round trip preserves source links')
  assert.deepEqual(errors,[])
  console.log('PASS: selection → new / existing document → atomic reference → source link, light/dark and narrow screens')
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));await provider.close();await rm(root,{recursive:true,force:true})
}
