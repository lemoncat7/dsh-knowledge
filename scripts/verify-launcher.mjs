// Exercise the actual launcher with isolated controllers and the official
// footer's flex layout; no live sessions or profile writes are needed.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const source = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function KnowledgeLauncher('), source.indexOf('\nfunction KnowledgeWorkspace('))
const { outputFiles } = await build({ stdin: { contents: `
import React, {useState,useEffect} from 'react';
import {createRoot} from './node_modules/@deepseek-ai/dsh-client-ui-primitives/node_modules/react-dom/client.js';
const IconDataOutline16 = () => <span aria-hidden="true">▤</span>;
const availableActivitySession = () => 'test';
${component}
let full=false, side=false; const listeners=new Set();
const notify=()=>listeners.forEach(fn=>fn());
const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
const workspace={isOpen:()=>full,subscribe,toggle(){full=!full;side=false;notify()}};
const activity={isOpen:()=>side,subscribe,toggle(){side=!side;full=false;notify()}};
window.renderLauncher=(wide=true,session=true)=>root.render(<div className="footer" style={{display:'flex',width:wide?240:48}}>
<button className="neighbor">SSH</button>
<KnowledgeLauncher wide={wide} useSessions={()=>session?'test':undefined} workspace={workspace} activity={activity}/>
<button className="neighbor">设置</button></div>);
const root=createRoot(document.getElementById('app'));window.renderLauncher();
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', jsx: 'automatic' })
const { chromium } = await import(pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href)
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.setContent('<div id="app"></div>')
  await page.addStyleTag({ content: await readFile(new URL('../src/client.css', import.meta.url),'utf8') })
  await page.addScriptTag({ content: outputFiles[0].text })
  const main=page.locator('.dsh-knowledge-trigger:not(.dsh-knowledge-panel-trigger)')
  const side=page.locator('.dsh-knowledge-panel-trigger')
  await main.click();assert.equal(await main.getAttribute('aria-pressed'),'true')
  await side.click();assert.equal(await side.getAttribute('aria-expanded'),'true')
  assert.equal(await main.getAttribute('aria-pressed'),'false')
  await main.click();assert.equal(await side.getAttribute('aria-expanded'),'false')
  for(const wide of [true,false]){
    await page.evaluate(wide=>window.renderLauncher(wide),wide)
    await page.waitForTimeout(50)
    assert.equal(await page.locator('.dsh-knowledge-launcher button').count(), wide ? 2 : 1)
    if (!wide) {
      assert.equal(await main.count(), 0)
      const center = await side.evaluate(node => {
        const button=node.getBoundingClientRect(), row=node.parentElement.getBoundingClientRect()
        return Math.abs(button.x + button.width / 2 - row.x - row.width / 2)
      })
      assert.ok(center < 1, 'collapsed side button must be centered')
      const railCenter = await side.evaluate(node => {
        const footer=node.parentElement.parentElement
        const rail=document.createElement('div')
        rail.style.cssText='display:flex;flex-direction:column;align-items:center;width:48px'
        footer.before(rail);rail.append(footer)
        footer.style.width='auto'
        const settings=document.createElement('button')
        settings.style.cssText='box-sizing:border-box;flex:none;width:36px;height:36px;margin:8px 0 10px;padding:0'
        rail.append(settings)
        const button=node.getBoundingClientRect(), bounds=settings.getBoundingClientRect()
        return Math.abs(button.x + button.width / 2 - bounds.x - bounds.width / 2)
      })
      assert.ok(railCenter < 1, 'button must align with rail even in auto-width host footer')
      await side.click(); assert.equal(await side.getAttribute('aria-expanded'), 'true')
      await side.focus(); await page.keyboard.press('Enter')
      assert.equal(await side.getAttribute('aria-expanded'), 'false')
    }
    const bounds=await page.evaluate(()=>{
      const row=document.querySelector('.dsh-knowledge-launcher').getBoundingClientRect();
      const others=[...document.querySelectorAll('.neighbor')].map(n=>n.getBoundingClientRect());
      const footer=document.querySelector('.footer');
      return {bottom:row.bottom,others:others.map(r=>r.top),overflow:footer.scrollWidth>footer.clientWidth+2}
    })
    assert.ok(bounds.others.every(top=>top>=bounds.bottom),'knowledge owns a separate row')
    assert.equal(bounds.overflow,false)
  }
  await page.evaluate(()=>window.renderLauncher(true,false));await page.waitForTimeout(50)
  assert.equal(await side.isDisabled(),true)
  await page.screenshot({path:'/tmp/knowledge-launcher.png'})
  assert.deepEqual(errors,[])
  console.log('Launcher: independent row, rail, exclusive actions, disabled no-session state passed')
}finally{await browser.close()}
