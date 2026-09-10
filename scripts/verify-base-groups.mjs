// Isolated real-browser grouping regression. Never touches a live profile.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerKnowledgeWeb } from '../lib/web.js'
import { registerKnowledgeApi, LOCAL_MANAGEMENT_API_PREFIX } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const { chromium } = await import(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.KNOWLEDGE_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = await mkdtemp(join(tmpdir(), 'knowledge-base-groups-ui-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const routes = []
const ctx = { webServer: { register(route) { routes.push(route); return () => {} } }, get() {} }
registerKnowledgeApi(ctx, provider, LOCAL_MANAGEMENT_API_PREFIX, { authMode: 'same-origin',
  service: { current: () => ({ publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1' }) },
})
registerKnowledgeWeb(ctx, '/knowledge', LOCAL_MANAGEMENT_API_PREFIX, 'same-origin')
const server = createServer((req, res) => {
  const route = routes.find(route => req.url.split('?')[0] === route.path || req.url.startsWith(route.path + '/'))
  if (route) void route.handler(req, res)
  else if (req.url.startsWith('/knowledge-control/v1/models')) { res.setHeader('content-type', 'application/json'); res.end('{"providers":[]}') }
  else { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/knowledge/`
const draft = { description: '用于验证分组', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' }
const work = await provider.createKnowledgeBase({ ...draft, name: '工作规范' })
await provider.createKnowledgeBase({ ...draft, name: '家庭设备', group: '家里助手' })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const open = async () => {
    await page.goto(url)
    await page.getByRole('button', { name: '知识库与挂载', exact: true }).click()
    await page.getByRole('heading', { name: '我的知识库', exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
      console.error({ errors, body: await page.locator('body').innerText() }); throw error
    })
  }
  await open()
  await page.getByRole('button', { name: '新建分组', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('分组名称', { exact: true }).fill('工作')
  await dialog.getByRole('button', { name: '创建分组', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '请至少选择一个知识库' }).waitFor()
  await dialog.getByRole('checkbox', { name: /工作规范/ }).check()
  await dialog.getByRole('button', { name: '创建分组', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal((await provider.getKnowledgeBase(work.id)).group, '工作')
  let section = page.locator('.base-group[aria-label="工作"]')
  await section.getByRole('button', { name: /工作.*1/ }).click()
  assert.equal(await section.locator('.base-card').count(), 0)
  await open()
  section = page.locator('.base-group[aria-label="工作"]')
  assert.equal(await section.locator('.base-card').count(), 0, 'collapsed group survives reload')
  await page.getByRole('searchbox', { name: '搜索知识库' }).fill('工作')
  await section.locator('.base-card').waitFor()
  await page.getByRole('searchbox', { name: '搜索知识库' }).fill('')
  await page.getByRole('button', { name: '重命名分组 工作', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('分组名称', { exact: true }).fill('个人')
  await dialog.getByRole('button', { name: '保存分组', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal((await provider.getKnowledgeBase(work.id)).group, '个人')
  await page.locator('.base-group[aria-label="个人"]').getByRole('button', { name: '编辑', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('所属分组', { exact: true }).fill('')
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal((await provider.getKnowledgeBase(work.id)).group, undefined)
  for (const width of [1280, 375, 812]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 812 ? 375 : 850 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    assert.ok((await page.locator('.base-search').boundingBox()).height < 80, 'search flex basis must not become a tall spacer on mobile')
    await page.screenshot({ path: join(root, `groups-${width}-${theme}.png`), fullPage: true })
  }
  const toggle = page.locator('.base-group-toggle').first()
  await toggle.focus()
  const before = await toggle.getAttribute('aria-expanded')
  await page.keyboard.press('Enter')
  assert.notEqual(await toggle.getAttribute('aria-expanded'), before)
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.goto(`${url}?sessionId=group-mount-fixture`)
  await page.getByRole('button', { name: '知识库与挂载', exact: true }).click()
  await page.getByRole('tab', { name: /项目与会话挂载/ }).click()
  await page.locator('.mount-base-path').first().waitFor()
  assert.deepEqual(await page.locator('.mount-base-path').allTextContents(), ['家里助手 / 家庭设备', '未分组 / 工作规范', '未分组 / 默认知识库'])
  await page.getByRole('checkbox', { name: '选择 家里助手 / 家庭设备', exact: true }).check()
  await page.getByRole('searchbox', { name: '搜索可挂载知识库' }).fill('家里助手')
  assert.deepEqual(await page.locator('.mount-base-path').allTextContents(), ['家里助手 / 家庭设备'])
  assert.equal(await page.getByRole('checkbox', { name: '选择 家里助手 / 家庭设备', exact: true }).isChecked(), true)
  await page.getByRole('button', { name: '批量挂载', exact: true }).click()
  await page.getByRole('dialog').getByText('家里助手 / 家庭设备', { exact: true }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索可挂载知识库' }).fill('')
  await page.evaluate(() => {
    const table=document.querySelector('.mount-table'), row=table.firstElementChild
    for(let i=0;i<30;i++) table.append(row.cloneNode(true))
  })
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 850 })
    await page.evaluate(async () => { await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations !== Infinity).map(a=>a.finished.catch(()=>{}))) })
    const layout = await page.evaluate(() => {
      const main=document.querySelector('.main'), page=document.querySelector('.page'), header=document.querySelector('.topbar')
      const table=document.querySelector('.mount-table')
      table.scrollTop=100000
      if (table.scrollTop <= 0) throw new Error('long mount list must remain scrollable')
      page.scrollTop=100000
      const trailing = page.getBoundingClientRect().bottom - document.querySelector('.bases-page').getBoundingClientRect().bottom
      if (page.scrollTop > 0) assertTrailing(trailing)
      function assertTrailing(value) { if (value > 25) throw new Error(`excess trailing scroll space ${value}; scrollHeight=${page.scrollHeight}, height=${page.clientHeight}`) }
      return { outerOverflow:main.scrollHeight-main.clientHeight, pageHeight:page.clientHeight, mainHeight:main.clientHeight, overflow:getComputedStyle(page).overflow, flex:getComputedStyle(page).flex, pageTop:page.getBoundingClientRect().top, headerBottom:header.getBoundingClientRect().bottom, padding:parseFloat(getComputedStyle(page).paddingBottom) }
    })
    assert.ok(layout.outerOverflow <= 1, `management shell must not scroll: ${width} ${JSON.stringify(layout)}`)
    assert.ok(layout.pageTop >= layout.headerBottom - 1, 'content scroller must stay below header')
    assert.ok(layout.padding <= 24, 'no oversized trailing padding')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await page.screenshot({ path: join(root, `mount-groups-${width}.png`), fullPage: true })
  }
  assert.deepEqual(await provider.listMounts(), [], 'display, sorting and selection must not change mounts')
  assert.deepEqual(errors, [])
  console.log(`Base groups browser checks passed; screenshots: ${root}`)
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await provider.close() }
