import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, globalAgent } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('share import keeps validated HTTP/HTTPS hops direct under environment proxies', {
  timeout: 30000,
  skip: !Object.hasOwn(globalAgent.options, 'proxyEnv') && 'Node runtime has no built-in environment proxy support',
}, async t => {
  const seen = []
  const proxy = createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(502).end('Test proxy cannot route the share host')
  })
  proxy.on('connect', (req, socket) => {
    seen.push(req.url)
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => { proxy.closeAllConnections(); proxy.close() })
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options|node_extra_ca_certs|node_tls_reject_unauthorized)$/i.test(key)) delete env[key]
  }
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  Object.assign(env, {
    NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '',
    NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./fixtures/share-test-cert.pem', import.meta.url)),
  })
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/share-import-proxy.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => child.kill(), 25000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`Share proxy fixture exited ${code}: ${stderr}`)) })
  })
  assert.equal(result.imports, 4)
  assert.equal(result.validatedLookups, 16)
  assert.equal(result.privateConfirmationChecks, 2)
  assert.equal(result.blockedRedirects, 8)
  assert.equal(result.tlsIdentityCheck, true)
  assert.deepEqual(seen, [], 'No manifest, content, redirect, or share token may reach the environment proxy')
})
