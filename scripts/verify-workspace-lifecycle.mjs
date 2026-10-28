// Tests the actual host component with synthetic sessions/documents, never production data.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { build } from 'esbuild'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const source = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('client.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(['KnowledgeWorkspace', 'knowledgePanelUrl', 'frameOrigin', 'connectionErrorMessage'])
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text)).map(s => s.getText(ast)).join('\n')
assert.equal(ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text)).length, 4)
const result = await build({ stdin: { contents: `
import React, {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {createConnectionClient,ConnectionRequestError} from './src/connection-client.ts';
const connectionClient=createConnectionClient({readTimeoutMs:300});
const requestConnection=connectionClient.request;
const IconChevronLeftOutline14=()=>null, IconDataOutline16=()=>null;
const deriveCurrentSession=s=>s.selected;
const createKnowledgeHostTheme=()=>({});
const KNOWLEDGE_THEME_READY_MESSAGE='ready',KNOWLEDGE_THEME_PROTOCOL_VERSION=1;
const activatePluginWorkspace=()=>{};
${functions}
let root, state={selected:'session-a',byId:{'session-a':{cwd:'project-a'},'session-b':{cwd:'project-b'}}};
const listeners=new Set();
const useSessions=selector=>useSyncExternalStore(cb=>{listeners.add(cb);return()=>listeners.delete(cb)},()=>selector(state));
let target; const workspaceListeners=new Set();
const workspace={currentTarget:()=>target,subscribe:cb=>{workspaceListeners.add(cb);return()=>workspaceListeners.delete(cb)},close:()=>window.fixture.close()};
let themeListeners=0;
const client={theme:{getTheme:()=>({})},on:()=>{themeListeners++;return()=>themeListeners--},get:()=>undefined};
window.fixture={
 open:()=>{root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><KnowledgeWorkspace useSessions={useSessions} client={client} workspace={workspace}/></React.StrictMode>)},
 close:()=>{root?.unmount();root=null},
 scope:()=>{state={...state,selected:'session-b'};listeners.forEach(cb=>cb())},
 target:()=>{target={view:'notes',noteId:'note-b'};workspaceListeners.forEach(cb=>cb())},
 listeners:()=>({sessions:listeners.size,workspace:workspaceListeners.size,theme:themeListeners}),
};
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } })
let mode = 'ok', calls = 0, iframeLoads = 0
const metadata = { backend: 'local', remoteTimeoutMs: 10000, tokenConfigured: false, canSwitchRemote: true, writable: true, managementAvailable: true, managementPath: '/knowledge/' }
const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/fixture.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(result.outputFiles[0].text)
  if (path === '/knowledge-control/v1/connection') {
    calls++
    if (mode === 'slow') return
    if (mode === 'offline') return res.writeHead(503).end('temporarily unavailable')
    if (mode === 'denied') return res.writeHead(403).end('forbidden')
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...metadata, managementAvailable: mode !== 'disabled' }))
  }
  if (path === '/knowledge/') { iframeLoads++; return res.writeHead(200, { 'content-type': 'text/html' }).end('<label>Draft<textarea id="draft"></textarea></label>') }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="root"></div><script src="/fixture.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const frame = page.frameLocator('.dsh-knowledge-frame')
  const open = () => page.evaluate(() => window.fixture.open())
  const close = () => page.evaluate(() => window.fixture.close())
  const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')))
  await open(); await frame.locator('#draft').waitFor()
  await frame.locator('#draft').fill('unsaved fixture text')
  const initialLoads = iframeLoads
  mode = 'offline'; await online()
  await page.locator('.dsh-knowledge-connection-warning').waitFor()
  assert.equal(await frame.locator('#draft').inputValue(), 'unsaved fixture text')
  assert.equal(iframeLoads, initialLoads, 'failed metadata revalidation must not reload iframe')
  mode = 'ok'; await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.locator('.dsh-knowledge-connection-warning').waitFor({ state: 'detached' })
  assert.equal(await frame.locator('#draft').inputValue(), 'unsaved fixture text')
  assert.equal(iframeLoads, initialLoads, 'successful revalidation of same path preserves editor')
  await page.evaluate(() => window.fixture.scope())
  await page.waitForFunction(() => document.querySelector('iframe')?.src.includes('session-b'))
  await frame.locator('#draft').waitFor()
  assert.equal(await page.locator('iframe').count(), 1)
  await page.evaluate(() => window.fixture.target())
  await page.waitForFunction(() => document.querySelector('iframe')?.src.includes('noteId=note-b'))
  mode = 'denied'; await online()
  await page.locator('iframe').waitFor({ state: 'detached' })
  await page.getByText('连接接口返回 HTTP 403', { exact: true }).waitFor()
  await close()
  for (let i = 0; i < 4; i++) {
    mode = 'ok'; await open(); await frame.locator('#draft').waitFor(); await close()
    assert.deepEqual(await page.evaluate(() => window.fixture.listeners()), { sessions: 0, workspace: 0, theme: 0 })
    assert.equal(page.frames().length, 1)
  }
  const closedCalls = calls
  await online(); await page.waitForTimeout(400)
  assert.equal(calls, closedCalls, 'closed workspace must not respond to reconnect')
  // Expire initial metadata and force a cold, stalled connection load.
  mode = 'denied'; await open(); await page.getByText('暂时无法打开知识库', { exact: true }).waitFor(); await close()
  mode = 'slow'; await open()
  await page.getByText('确认知识库连接超时，请重试。', { exact: true }).waitFor()
  mode = 'ok'; await page.getByRole('button', { name: '重试', exact: true }).click(); await frame.locator('#draft').waitFor()
  mode = 'disabled'; await online(); await page.locator('iframe').waitFor({ state: 'detached' })
  await page.getByText('这台 DSH 未启用知识库管理台', { exact: true }).waitFor()
  await close()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', checks: ['draft preservation', 'permission revocation', 'session scope', 'document navigation', 'StrictMode remount', 'listener cleanup', 'closed reconnect', 'timeout retry', 'disabled management'], calls, iframeLoads }))
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
