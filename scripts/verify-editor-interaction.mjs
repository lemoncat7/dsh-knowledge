// Browser-only fixture: no real documents, API writes or system clipboard access.
// Run after build with KNOWLEDGE_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const bundle = await readFile(new URL('../web/note-editor.js', import.meta.url))
const styles = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8')
const tokens = await readFile(new URL('../web/design-tokens.css', import.meta.url), 'utf8')
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/editor.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/editor.js' ? bundle : '<main id="frame" style="padding:48px"><div id="scroll"><div id="editor"></div></div><aside id="outline"></aside></main>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.addStyleTag({ content: styles + tokens })
  await page.addScriptTag({ url: '/editor.js' })
  for (const mode of ['markdown', 'plain']) {
    await mount(page, mode)
    await select(page)
    const original = await page.locator('.ProseMirror').innerText()
    for (const modifier of ['none', 'ctrlKey', 'altKey']) {
      const result = await page.locator('.ProseMirror').evaluate((node, modifier) => {
        const transfer = new DataTransfer()
        const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer, ...modifier === 'none' ? {} : { [modifier]: true } })
        node.dispatchEvent(event)
        return { cancelled: event.defaultPrevented, types: [...transfer.types] }
      }, modifier)
      assert.deepEqual(result, { cancelled: true, types: [] }, `${mode}: selected text must not be exported as a move/copy drag`)
    }
    assert.equal(await page.locator('.ProseMirror').innerText(), original)
    assert.equal(await page.evaluate(() => changes), 0, 'selecting/dragging must not edit text')
    await page.locator('.ProseMirror').press('Control+a')
    assert.equal(await page.locator('.ProseMirror').evaluate(node => {
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
      node.dispatchEvent(event)
      return event.defaultPrevented
    }), true, 'select-all must also be protected from accidental dragging')
    await select(page)
    const copied = await page.locator('.ProseMirror').evaluate(node => {
      const data = new DataTransfer()
      node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
      return data.getData('text/plain')
    })
    assert.equal(copied, 'Alpha Bravo', 'normal copy serialization must remain intact')
    await page.locator('.ProseMirror').evaluate(node => {
      const data = new DataTransfer(); data.setData('text/plain', 'PASTE_ONCE')
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    })
    assert.equal((await page.locator('.ProseMirror').innerText()).split('PASTE_ONCE').length - 1, 1)
    assert.equal(await page.evaluate(() => changes), 1, 'one paste must produce one content update')
    await page.keyboard.press('Control+z')
    assert.equal(await page.locator('.ProseMirror').innerText(), original, 'undo must still work')
    // Incoming text from outside the editor remains supported; only outgoing
    // selected-text drags are blocked, not the drop/paste pipeline.
    await page.locator('.ProseMirror').evaluate(node => {
      const data = new DataTransfer(); data.setData('text/plain', 'EXTERNAL_DROP')
      const bounds = node.querySelector('p').getBoundingClientRect()
      node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: bounds.x + 8, clientY: bounds.y + 8 }))
    })
    assert.equal((await page.locator('.ProseMirror').innerText()).split('EXTERNAL_DROP').length - 1, 1)
  }

  await mount(page, 'markdown')
  await select(page)
  await page.evaluate(() => {
    window.bodyDragCancelled = undefined
    document.addEventListener('dragstart', event => { window.bodyDragCancelled = event.defaultPrevented }, { once: true })
  })
  const origin = await page.locator('.ProseMirror p').first().boundingBox()
  const destination = await page.locator('.ProseMirror p').last().boundingBox()
  await page.mouse.move(origin.x + 20, origin.y + 10)
  await page.mouse.down()
  await page.mouse.move(destination.x + 30, destination.y + 10, { steps: 15 })
  await page.mouse.up()
  assert.equal(await page.evaluate(() => bodyDragCancelled), true, 'real mouse text drag must be cancelled')
  assert.equal(await page.evaluate(() => changes), 0, 'real mouse text drag must not edit text')
  await mount(page, 'markdown')
  const menu = page.locator('.notes-selection-menu')
  await pointer(page, 'pointerdown')
  await select(page)
  await frames(page)
  assert.equal(await menu.isVisible(), false, 'menu must stay hidden while selecting')
  await pointer(page, 'pointerup')
  await frames(page)
  assert.equal(await menu.isVisible(), true, 'normal pointer release should reveal the menu')
  await page.getByRole('button', { name: '加粗', exact: true }).click()
  assert.match(await page.evaluate(() => handle.getMarkdown()), /\*\*Alpha Bravo\*\*/, 'formatting controls must still work')

  for (const interrupted of ['pointercancel', 'blur', 'dragstart', 'outside']) {
    await mount(page, 'markdown')
    await pointer(page, 'pointerdown')
    await select(page)
    await page.evaluate(interrupted => {
      if (interrupted === 'outside') {
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, isPrimary: true }))
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true }))
      } else if (interrupted === 'dragstart') {
        document.querySelector('.ProseMirror').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
      } else if (interrupted === 'blur') window.dispatchEvent(new Event('blur'))
      else window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7, isPrimary: true }))
      document.querySelector('#scroll').dispatchEvent(new Event('scroll'))
    }, interrupted)
    await page.waitForTimeout(150)
    assert.equal(await menu.isVisible(), false, `${interrupted}: a timer/transaction must not reopen the cancelled menu`)
    assert.equal(await page.evaluate(() => changes), 0)
    await page.locator('.ProseMirror').press('Control+a')
    await frames(page)
    assert.equal(await menu.isVisible(), true, 'select-all must recover immediately after cancellation')
    await page.locator('.ProseMirror').press('ArrowLeft')
    await page.keyboard.press('Shift+ArrowRight')
    await frames(page)
    assert.equal(await menu.isVisible(), true, 'keyboard selection must recover after a cancelled gesture')
  }

  await mount(page, 'markdown')
  await pointer(page, 'pointerdown')
  await select(page)
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, isPrimary: true }))
    handle.destroy()
  })
  await frames(page)
  assert.equal(await menu.count(), 0, 'destroy must cancel a queued menu reveal')
  for (const width of [375, 1024]) {
    await page.setViewportSize({ width, height: 850 })
    await mount(page, 'markdown')
    await pointer(page, 'pointerdown', 'touch')
    await select(page)
    assert.equal(await menu.isVisible(), false)
    await pointer(page, 'pointercancel', 'touch')
    await frames(page)
    assert.equal(await menu.isVisible(), false, 'touch cancellation must not open the toolbar')
    await pointer(page, 'pointerdown', 'touch')
    await select(page)
    await pointer(page, 'pointerup', 'touch')
    await frames(page)
    assert.equal(await menu.isVisible(), true, 'a new touch selection must recover')
    assert.equal(await menu.getAttribute('data-placement'), 'bottom')
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', checks: ['Markdown/plain text drag prevention', 'Ctrl/Alt copy-drag prevention', 'copy/paste exactly once', 'undo', 'external text drop', 'pointer release vs cancellation', 'blur/outside/drag cancellation', 'formatting and keyboard selection', 'destroy cleanup'] }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}

async function mount(page, mode) {
  await page.evaluate(mode => {
    window.handle?.destroy()
    window.changes = 0
    const common = { host: document.querySelector('#editor'), label: '隔离测试正文', onChange() { changes++ }, onSave() {} }
    window.handle = mode === 'markdown'
      ? DshKnowledgeNoteEditor.createMarkdownEditor({ ...common, frame: document.querySelector('#frame'), scrollHost: document.querySelector('#scroll'), outlineHost: document.querySelector('#outline'), markdown: 'Alpha Bravo Charlie.\n\nTarget paragraph.' })
      : DshKnowledgeNoteEditor.createPlainTextEditor({ ...common, text: 'Alpha Bravo Charlie.\nTarget paragraph.' })
  }, mode)
}

async function select(page) {
  await page.locator('.ProseMirror p').first().evaluate(node => {
    node.closest('[contenteditable]').focus()
    const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 11)
    getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  await frames(page)
}

async function pointer(page, type, pointerType = 'mouse') {
  await page.locator('.ProseMirror').dispatchEvent(type, { bubbles: true, pointerId: 7, isPrimary: true, pointerType, button: 0 })
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
}
