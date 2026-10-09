// Isolated host-slot fixture. No live profile, server or credentials required.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const css = await readFile(new URL('../src/client.css', import.meta.url), 'utf8')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
let cases = 0
try {
  const page = await browser.newPage()
  for (const dark of [false, true]) for (const wide of [true, false]) for (const layout of ['row', 'column', 'contents']) {
    const width = wide ? 256 : 48
    await page.setViewportSize({ width: 375, height: 667 })
    await page.setContent(`<style>
      .host { display:flex; flex-direction:${wide ? 'row' : 'column'}; align-items:center; width:${width}px; height:211px; }
      .slot { display:${layout === 'contents' ? 'contents' : 'flex'}; flex-direction:${layout === 'column' ? 'column' : wide ? 'row' : 'column'}; width:100%; height:211px; gap:4px; align-items:${wide ? 'stretch' : 'center'}; }
      .other { flex:none; width:36px; height:36px; }
      </style><body ${dark ? 'data-ds-dark-theme' : ''}><section data-slot="sidebar"><div class="host"><div class="slot" data-slot="sidebar.footer.action">
      <div class="dsh-knowledge-launcher${wide ? '' : ' dsh-knowledge-launcher--rail'}" role="group">
      ${wide ? '<button class="dsh-knowledge-trigger">知识库</button>' : ''}<button class="dsh-knowledge-trigger dsh-knowledge-panel-trigger" aria-label="展开知识库">K</button></div>
      <button class="other">MCP</button><button class="other">SSH</button></div></div></section></body>`)
    const hostStyles = () => page.locator('.host, .slot').evaluateAll(nodes => nodes.map(n => {
      const s = getComputedStyle(n); return [s.display,s.flexDirection,s.alignItems]
    }))
    const before = await hostStyles()
    await page.addStyleTag({ content: css })
    assert.deepEqual(await hostStyles(), before, 'plugin must not change host layout')
    const bounds = await page.locator('.host').boundingBox()
    const launcher = await page.locator('.dsh-knowledge-launcher').boundingBox()
    if (wide) {
      assert.ok(Math.abs(launcher.width - bounds.width) < 1, 'wide launcher owns a full row without theme')
      for (const other of await page.locator('.other').all()) {
        const r = await other.boundingBox()
        assert.ok(r.y >= launcher.y + launcher.height, 'other plugins must not share knowledge row')
      }
    } else assert.ok(Math.abs(launcher.x + launcher.width / 2 - bounds.x - bounds.width / 2) < 1, `rail launcher is centered: ${layout} ${JSON.stringify({launcher,bounds})}`)
    for (const button of await page.locator('button').all()) {
      const r = await button.boundingBox()
      assert.ok(r.width > 0 && r.height > 0)
      assert.ok(r.x >= bounds.x && r.x+r.width <= bounds.x+bounds.width+1, `${layout}/${wide}: horizontal overflow`)
      assert.ok(r.y >= bounds.y && r.y+r.height <= bounds.y+bounds.height+1, `${layout}/${wide}: vertical overflow`)
    }
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('button:focus').count(), 1)
    cases++
  }
  console.log(`Launcher layout: ${cases} light/dark × wide/rail × host-layout cases passed`)
} finally { await browser.close() }
