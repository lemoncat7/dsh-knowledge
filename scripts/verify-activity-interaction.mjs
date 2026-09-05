// Read-only integration regression against a DSH session. The optional local
// bundle replacement changes only this browser's response, never the server.
// Requires KNOWLEDGE_PLAYWRIGHT_MODULE, DSH_BROWSER_STATE and DSH_TEST_SESSION_TITLE.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href)
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ storageState: process.env.DSH_BROWSER_STATE, viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  if (process.env.KNOWLEDGE_LOCAL_BUNDLE === '1') {
    const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    await page.route('**/plugins/**', async route => {
      if (!route.request().url().includes('@lemoncat7/dsh-knowledge/client.js')) return route.continue()
      const response = await route.fetch()
      const body = await response.text()
      const start = body.indexOf('window.__ModuleLoader__.load({ id: "@lemoncat7/dsh-knowledge"')
      const footer = 'return module.exports; } });'
      const end = body.indexOf(footer, start)
      assert.ok(start >= 0 && end > start, 'knowledge bundle boundary not found')
      await route.fulfill({ response, body: body.slice(0, start) + bundle + body.slice(end + footer.length) })
    })
  }
  await page.goto(process.env.DSH_TEST_URL || 'http://127.0.0.1:3080')
  await page.getByText(process.env.DSH_TEST_SESSION_TITLE, { exact: true }).click()
  await page.locator('.dsh-knowledge-trigger[aria-label="展开会话知识库"]').waitFor()
  await page.waitForTimeout(800)
  const launch = () => page.locator('.dsh-knowledge-trigger').evaluate(node => node.click())
  await launch()
  await page.locator('.dsh-knowledge-activity-viewport').waitFor()
  const opening = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const panel = document.querySelector('.dsh-knowledge-activity-panel')
    let columnTransitions = 0
    for (let parent = panel.parentElement; parent; parent = parent.parentElement) {
      columnTransitions += parent.getAnimations().filter(animation => animation.transitionProperty === 'grid-template-columns' && animation.playState === 'running').length
    }
    return { width: panel.getBoundingClientRect().width, columnTransitions }
  })
  assert.ok(opening.width > 300, 'opening must reserve the final reader width')
  assert.equal(opening.columnTransitions, 0, 'opening must not reflow the conversation on every frame')
  await page.waitForTimeout(450)
  assert.equal(await page.locator('.dsh-knowledge-activity-panel').evaluate(node => node.getAnimations().length), 0, 'reveal animation must release after settling')
  const samples = []
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      window.panelBeforeClose = document.querySelector('.dsh-knowledge-activity-panel')
      window.panelBeforeClose.style.setProperty('--test-identity', 'retained')
    })
    const snapshot = await page.evaluate(async () => {
      document.querySelector('.dsh-knowledge-trigger').click()
      await new Promise(requestAnimationFrame)
      const viewport = document.querySelector('.dsh-knowledge-activity-viewport')
      const panel = document.querySelector('.dsh-knowledge-activity-panel')
      const snapshot = { width: panel?.getBoundingClientRect().width || 0, hidden: viewport?.getAttribute('aria-hidden'), inert: viewport?.hasAttribute('inert') }
      document.querySelector('.dsh-knowledge-trigger').click()
      return snapshot
    })
    assert.ok(snapshot.width > 300, 'reader squeezed during collapse')
    assert.equal(snapshot.hidden, 'true')
    assert.equal(snapshot.inert, true)
    await page.waitForTimeout(450)
    assert.equal(await page.evaluate(() => window.panelBeforeClose === document.querySelector('.dsh-knowledge-activity-panel')), true, 'rapid reversal remounted the reader')
    assert.equal(await page.locator('.dsh-knowledge-activity-viewport').getAttribute('inert'), null)
    assert.equal(await page.locator('.dsh-knowledge-activity-panel').evaluate(node => node.style.width), '', 'width did not return to fluid layout')
    samples.push(snapshot.width)
  }
  await launch()
  await page.locator('.dsh-knowledge-activity-viewport').waitFor({ state: 'detached' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await launch()
  await page.locator('.dsh-knowledge-activity-panel').waitFor()
  await launch()
  await page.locator('.dsh-knowledge-activity-viewport').waitFor({ state: 'detached', timeout: 1000 })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', checks: ['transform opening without animated column reflow', 'reveal cleanup', 'stable collapsing reader', 'rapid reversal retains reader', 'fluid width restored', 'closed panel released', 'reduced motion'], samples }))
} finally { await browser.close() }
