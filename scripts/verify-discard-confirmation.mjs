// Isolated, real-browser checks for both renderers. No live data/profile access.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = await mkdtemp(join(tmpdir(), 'knowledge-discard-'))
const bundle = await build({ stdin: { contents: `
  import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {Dialog} from './worklog/ui/Dialog.jsx';
  import {createDialogPresenter} from './web/dialogs.js';
  import * as ui from './web/ui-primitives.js';
  const presenter = createDialogPresenter({...ui, friendlyError: e=>e.message});
  window.closedCount=0;
  function knowledge() {
    const field=ui.element('input', {'aria-label':'知识表单内容', value:'原始内容'});
    const handle=presenter.openModal({title:'知识表单',body:ui.element('div', {},field),primaryLabel:'保存',
      onPrimary:async()=>{throw Error('模拟保存失败')},onClose:()=>window.closedCount++});
    window.savedKnowledge=()=>handle.close(true);
    window.repeatClose=()=>{handle.close();handle.close()};
  }
  function Fixture() {
    const [open,setOpen]=useState(false),[value,setValue]=useState('原始内容'),[busy,setBusy]=useState(false);
    window.setFixtureBusy=setBusy; window.unmountWorklog=()=>setOpen(false);
    return <><button onClick={knowledge}>打开知识表单</button><button onClick={()=>{setValue('原始内容');setOpen(true)}}>打开日报表单</button>
      {open&&<Dialog title="日报表单" protectChanges dirty={value!=='原始内容'} busy={busy} close={()=>{window.closedCount++;setOpen(false)}}>
        <label>日报表单内容<input value={value} onChange={e=>setValue(e.target.value)}/></label>
      </Dialog>}</>;
  }
  createRoot(document.querySelector('#root')).render(<Fixture/>);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' })
const css = (await Promise.all(['web/design-tokens.css','web/styles.css','web/interaction-theme.css','worklog/client.css','worklog/web-embedded.css','web/discard-confirmation.css'].map(file => readFile(file,'utf8')))).join('\n')
const helper = await readFile('web/discard-confirmation.js', 'utf8')
const server = createServer((req,res) => {
  const path = req.url.split('?')[0]
  if (path === '/fixture.js') return res.writeHead(200, {'content-type':'text/javascript'}).end(bundle.outputFiles[0].text)
  if (path === '/discard-confirmation.js') return res.writeHead(200, {'content-type':'text/javascript'}).end(helper)
  if (path === '/fixture.css') return res.writeHead(200, {'content-type':'text/css'}).end(css)
  res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const page=await browser.newPage({viewport:{width:1280,height:850}, reducedMotion:'reduce'})
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const prompt=page.getByRole('alertdialog')
  for (const kind of ['知识','日报']) {
    const trigger=page.getByRole('button',{name:`打开${kind}表单`,exact:true})
    const close=page.getByRole('button',{name:kind==='知识'?'关闭对话框':'关闭弹窗',exact:true})
    await trigger.click()
    await close.click()
    assert.equal(await prompt.count(),0,'clean dialog closes without prompting')
    await trigger.click()
    const field=page.getByLabel(`${kind}表单内容`,{exact:true})
    await field.fill('需要保留的草稿')
    const count=await page.evaluate(()=>window.closedCount)
    for (const entry of ['close','escape','outside',...(kind==='知识'?['cancel']:[])]) {
      if(entry==='close') await close.click()
      if(entry==='escape') {await field.focus();await page.keyboard.press('Escape')}
      if(entry==='outside') await page.mouse.click(2,2)
      if(entry==='cancel') await page.getByRole('button',{name:'取消',exact:true}).click()
      await prompt.waitFor()
      assert.equal(await prompt.count(),1)
      assert.equal(await prompt.getByRole('button',{name:'继续编辑',exact:true}).evaluate(el=>el===document.activeElement),true)
      await page.keyboard.press('Tab')
      assert.equal(await prompt.getByRole('button',{name:'放弃修改',exact:true}).evaluate(el=>el===document.activeElement),true)
      await page.keyboard.press('Tab')
      assert.equal(await prompt.getByRole('button',{name:'继续编辑',exact:true}).evaluate(el=>el===document.activeElement),true)
      await page.keyboard.press('Escape')
      assert.equal(await prompt.count(),0)
      assert.equal(await field.inputValue(),'需要保留的草稿')
      assert.equal(await page.evaluate(()=>window.closedCount),count)
    }
    if (kind==='日报') {
      await page.evaluate(()=>window.setFixtureBusy(true))
      await page.waitForFunction(()=>document.querySelector('.wl-dialog header button').disabled)
      await page.keyboard.press('Escape')
      assert.equal(await prompt.count(),0,'no close during save')
      await page.evaluate(()=>window.setFixtureBusy(false))
    } else {
      await page.getByRole('button',{name:'保存',exact:true}).click()
      await page.getByRole('alert').getByText('模拟保存失败',{exact:true}).waitFor()
      assert.equal(await field.inputValue(),'需要保留的草稿','failed save preserves edits')
      await page.evaluate(()=>window.repeatClose())
      assert.equal(await prompt.count(),1,'repeated dismiss never stacks confirmations')
      await prompt.getByRole('button',{name:'继续编辑',exact:true}).click()
    }
    for (const [width,height,scheme] of [[1280,850,'light'],[390,844,'dark'],[812,375,'dark']]) {
      await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme})
      await close.click()
      const box=await prompt.boundingBox()
      assert.ok(Math.abs(box.x+box.width/2-width/2)<2 && Math.abs(box.y+box.height/2-height/2)<2)
      assert.ok(box.height<340 && box.x>=0 && box.y>=0, `${kind} ${width}: ${JSON.stringify(box)}`)
      await page.screenshot({path:join(root,`${kind}-${width}.png`)})
      await prompt.getByRole('button',{name:'继续编辑',exact:true}).click()
    }
    await close.click()
    await prompt.getByRole('button',{name:'放弃修改',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.closedCount),count+1)
    assert.equal(await page.locator('.dialog, .wl-dialog, .knowledge-discard-dialog').count(),0)
  }
  // Owner disposal must never leave a top-layer confirmation over the workspace.
  await page.getByRole('button',{name:'打开日报表单',exact:true}).click()
  await page.getByLabel('日报表单内容').fill('草稿')
  await page.getByRole('button',{name:'关闭弹窗',exact:true}).click()
  await page.evaluate(()=>window.unmountWorklog())
  await page.waitForFunction(()=>!document.querySelector('.knowledge-discard-dialog'))
  await page.getByRole('button',{name:'打开知识表单',exact:true}).click()
  await page.getByLabel('知识表单内容').fill('已保存的内容')
  await page.evaluate(()=>window.savedKnowledge())
  assert.equal(await prompt.count(),0,'successful programmatic close bypasses discard confirmation')
  assert.deepEqual(errors,[])
  console.log(`PASS: shared DOM/React confirmation, all dismiss paths, focus trap, keep/discard, busy/failure, owner cleanup, responsive themes. Screenshots: ${root}`)
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
