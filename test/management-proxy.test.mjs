import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { registerRemoteManagementProxy } from '../lib/management-proxy.js'

test('remote management proxy keeps credentials server-side and exposes a synthetic service view', async (t) => {
  const token = 'remote_management_token_longer_than_24_chars'
  let receivedAuthorization = ''
  const central = createServer(async (req, res) => {
    receivedAuthorization = req.headers.authorization || ''
    if (req.url?.endsWith('/notes/files?name=proxy.txt') && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const content = Buffer.concat(chunks)
      const payload = JSON.stringify({ id: 'note_1234567890abcdef1234567890abcdef', name: 'proxy.txt', size: content.byteLength, mediaType: req.headers['content-type'] })
      res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
      return
    }
    if (req.url?.endsWith('/notes/note_1234567890abcdef1234567890abcdef/content')) {
      const content = Buffer.from('proxied note file')
      res.writeHead(200, {
        'content-type': 'text/plain', 'content-length': content.byteLength,
        'content-disposition': 'inline; filename="proxy.txt"',
        'content-security-policy': "sandbox; default-src 'none'",
      })
      res.end(content)
      return
    }
    const payload = JSON.stringify({ entries: { active: 3 }, path: req.url })
    res.writeHead(receivedAuthorization === `Bearer ${token}` ? 200 : 401, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  })
  await new Promise(resolve => central.listen(0, '127.0.0.1', resolve))
  const centralAddress = central.address()
  const remoteUrl = `http://127.0.0.1:${centralAddress.port}/knowledge-api/v1`

  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  let localRoute = { writebackProvider: 'cli', writebackModel: 'client-model' }
  registerRemoteManagementProxy(ctx, '/knowledge-local/v1', () => ({
    backend: 'remote', remoteUrl, remoteToken: token, remoteTimeoutMs: 5000,
  }), {
    current: () => localRoute,
    async update(patch) {
      localRoute = patch.writebackProvider && patch.writebackModel
        ? { writebackProvider: patch.writebackProvider, writebackModel: patch.writebackModel }
        : {}
      return localRoute
    },
  })
  const proxy = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddress = proxy.address()
  const base = `http://127.0.0.1:${proxyAddress.port}/knowledge-local/v1`
  t.after(async () => {
    await new Promise(resolve => proxy.close(resolve))
    await new Promise(resolve => central.close(resolve))
  })

  assert.equal((await fetch(`${base}/stats`)).status, 401)
  const headers = { 'x-dsh-knowledge-client': 'management-web' }
  const service = await (await fetch(`${base}/service`, { headers })).json()
  assert.deepEqual(service, {
    publicApiEnabled: true, publicApiPrefix: remoteUrl, remote: true,
    writebackProvider: 'cli', writebackModel: 'client-model',
  })
  const updated = await (await fetch(`${base}/service`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ writebackProvider: 'local', writebackModel: 'device-model' }),
  })).json()
  assert.equal(updated.writebackModel, 'device-model')
  assert.equal(receivedAuthorization, '')
  const centralToggle = await fetch(`${base}/service`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ publicApiEnabled: false }),
  })
  assert.equal(centralToggle.status, 409)
  const stats = await (await fetch(`${base}/stats`, { headers })).json()
  assert.equal(stats.entries.active, 3)
  assert.equal(stats.path, '/knowledge-api/v1/stats')
  assert.equal(receivedAuthorization, `Bearer ${token}`)
  const uploaded = await (await fetch(`${base}/notes/files?name=proxy.txt`, {
    method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: 'proxy body',
  })).json()
  assert.equal(uploaded.size, 10)
  assert.equal(uploaded.mediaType, 'text/plain')
  const proxiedContent = await fetch(`${base}/notes/${uploaded.id}/content`, { headers })
  assert.equal(proxiedContent.headers.get('content-disposition'), 'inline; filename="proxy.txt"')
  assert.equal(proxiedContent.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  assert.equal(await proxiedContent.text(), 'proxied note file')
  assert.doesNotMatch(JSON.stringify(service), new RegExp(token))
})

test('remote frequency settings stay local, validate bounds and preserve the selected model',async t=>{
 let handler,state={writebackProvider:'p',writebackModel:'m'}
 registerRemoteManagementProxy({webServer:{register(r){handler=r.handler;return ()=>{}}},get(){}},'/knowledge-local/v1',()=>({backend:'remote',remoteUrl:'http://127.0.0.1:1',remoteToken:'not-used',remoteTimeoutMs:100}),{current:()=>state,async update(patch){state={...state,...patch};return state}})
 const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const url=`http://127.0.0.1:${server.address().port}/knowledge-local/v1/service`,headers={'x-dsh-knowledge-client':'management-web','content-type':'application/json'}
 const send=body=>fetch(url,{method:'PUT',headers,body:JSON.stringify(body)})
 const response=await send({extractionEveryTurns:5,extractionIdleSeconds:90});assert.equal(response.status,200);const data=await response.json();assert.equal(data.extractionEveryTurns,5);assert.equal(data.writebackModel,'m')
 assert.equal((await send({extractionEveryTurns:0})).status,400);assert.equal(state.extractionEveryTurns,5)
 assert.equal((await (await fetch(url,{headers})).json()).extractionIdleSeconds,90)
})
