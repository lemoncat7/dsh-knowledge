// Isolated subprocess fixture. The certificate/key are PUBLIC TEST MATERIAL,
// never credentials for a real service. No production data or external network.
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

assert.equal(http.globalAgent.options.proxyEnv.HTTP_PROXY, process.env.HTTP_PROXY)
assert.equal(https.globalAgent.options.proxyEnv.HTTPS_PROXY, process.env.HTTPS_PROXY)
const token = `share_${'a'.repeat(32)}`
const body = Buffer.from('# Imported note\n\nProxy-safe content.')
const manifest = {
  version: 1, truncated: false,
  share: { name: 'note.md', kind: 'document', updatedAt: '2026-01-01T00:00:00.000Z', nodeCount: 1, fileCount: 1, totalSize: body.length },
  nodes: [{ id: `note_${'b'.repeat(32)}`, path: 'note.md', kind: 'document', mediaType: 'text/markdown', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }],
}
let redirect, requests = 0, validatedLookups = 0
const serve = (req, res) => {
  const url = new URL(req.url, 'http://fixture')
  if (redirect) { res.writeHead(302, { location: redirect }).end(); return }
  // Exercise the real recursion for both manifest and content requests.
  if (!url.searchParams.has('redirected')) {
    url.searchParams.set('redirected', '1')
    res.writeHead(302, { location: url.pathname + url.search }).end(); return
  }
  if (url.pathname.endsWith('/manifest')) res.setHeader('content-type', 'application/json').end(JSON.stringify(manifest))
  else res.end(body)
}
const servers = {
  'http:': http.createServer(serve),
  'https:': https.createServer({ key: readFileSync(new URL('./share-test-key.pem', import.meta.url)), cert: readFileSync(new URL('./share-test-cert.pem', import.meta.url)) }, serve),
}
await Promise.all(Object.values(servers).map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
const addresses = { 'lan.test': '192.168.10.20', 'public.test': '8.8.8.8', 'other.test': '192.168.10.21', 'wrong.test': '192.168.10.22' }
dns.lookup = async hostname => {
  assert.ok(addresses[hostname], `Unexpected external DNS request: ${hostname}`)
  return [{ address: addresses[hostname], family: 4 }]
}
// Validate the plugin's original pin, then map only the test transport to our
// loopback server. Proxy interception still bypasses this lookup and fails.
for (const module of [http, https]) {
  const original = module.request
  module.request = (url, options, callback) => {
    requests++
    assert.equal(options.agent, false)
    assert.notEqual(options.rejectUnauthorized, false)
    assert.equal(options.checkServerIdentity, undefined)
    const pinned = options.lookup
    return original(url, { ...options, lookup(hostname, opts, done) {
      assert.equal(hostname, url.hostname)
      pinned(hostname, opts, (error, result, family) => {
        assert.ifError(error)
        assert.deepEqual(opts.all ? result : [{ address: result, family }], [{ address: addresses[hostname], family: 4 }])
        validatedLookups++
        if (opts.all) done(null, [{ address: '127.0.0.1', family: 4 }])
        else done(null, '127.0.0.1', 4)
      })
    } }, callback)
  }
}
syncBuiltinESMExports()
const moduleUrl = process.env.DSH_SHARE_TEST_MODULE || new URL('../../lib/notes/share-import.js', import.meta.url).href
const { inspectNoteShareUrl, importNoteShare } = await import(moduleUrl)
let imports = 0, privateConfirmationChecks = 0, blockedRedirects = 0
try {
  for (const protocol of ['http:', 'https:']) {
    const port = servers[protocol].address().port
    for (const host of ['lan.test', 'public.test']) {
      const base = `${protocol}//${host}:${port}/shared/${token}`
      const policy = host === 'lan.test' ? { confirmedPrivateShareUrl: base } : {}
      if (host === 'lan.test') {
        const before = requests
        await assert.rejects(inspectNoteShareUrl(base), { code: 'PRIVATE_SHARE_CONFIRMATION_REQUIRED' })
        assert.equal(requests, before); privateConfirmationChecks++
      }
      let saved
      const store = { getShareByToken() { return undefined }, async createDocument(name, parentId, content) { saved = { name, parentId, content }; return { id: 'imported', name } } }
      const result = await importNoteShare(store, base, null, policy)
      assert.equal(result.importedFiles, 1)
      assert.equal(result.totalBytes, body.length)
      assert.deepEqual(saved, { name: 'note.md', parentId: null, content: body.toString() })
      imports++
    }
    const base = `${protocol}//lan.test:${port}/shared/${token}`
    for (const blocked of [base.replace('lan.test', '127.0.0.1'), base.replace('lan.test', '169.254.169.254'), base.replace('lan.test', 'other.test'), base.replace(token, `share_${'c'.repeat(32)}`)]) {
      redirect = blocked + '/manifest'
      const before = requests
      await assert.rejects(inspectNoteShareUrl(base, undefined, { confirmedPrivateShareUrl: base }))
      assert.equal(requests, before + 1, 'Blocked redirect must never open a second connection')
      blockedRedirects++
    }
    redirect = undefined
  }
  // Count the four successful imports' manifest/content hops separately.
  assert.equal(validatedLookups, 16 + blockedRedirects)
  const base = `https://wrong.test:${servers['https:'].address().port}/shared/${token}`
  await assert.rejects(inspectNoteShareUrl(base, undefined, { confirmedPrivateShareUrl: base }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  console.log(JSON.stringify({ imports, validatedLookups: validatedLookups - blockedRedirects - 1, privateConfirmationChecks, blockedRedirects, tlsIdentityCheck: true }))
} finally {
  for (const server of Object.values(servers)) { server.closeAllConnections(); server.close() }
}
