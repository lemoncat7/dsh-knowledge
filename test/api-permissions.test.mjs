import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const LEVELS = ['read', 'propose', 'write', 'admin']
const ALLOWED = {
  read: new Set(LEVELS),
  propose: new Set(['propose', 'write', 'admin']),
  write: new Set(['write', 'admin']),
  admin: new Set(['admin']),
}

test('public API routes enforce the read/propose/write/admin capability matrix', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-api-permissions-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const tokens = Object.fromEntries(LEVELS.map(level => [level, provider.createApiToken(level, [level]).token]))
  let handler
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    get() { return undefined },
  }
  registerKnowledgeApi(ctx, provider, '/knowledge-api/v1')
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}/knowledge-api/v1`
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal((await fetch(`${base}/health`)).status, 200)
  assert.equal((await fetch(`${base}/stats`)).status, 401)

  const cases = [
    { required: 'read', method: 'GET', path: '/stats' },
    { required: 'read', method: 'GET', path: '/knowledge-bases' },
    { required: 'read', method: 'GET', path: '/mounts' },
    { required: 'read', method: 'GET', path: '/documents' },
    { required: 'read', method: 'GET', path: '/entries' },
    { required: 'read', method: 'GET', path: '/entries/missing/note-references' },
    { required: 'read', method: 'GET', path: '/candidates?status=pending' },
    { required: 'read', method: 'GET', path: '/notes' },
    { required: 'propose', method: 'POST', path: '/candidates', body: {} },
    { required: 'propose', method: 'POST', path: '/extraction-jobs/test/claim', body: {} },
    { required: 'write', method: 'POST', path: '/knowledge-bases', body: {} },
    { required: 'write', method: 'POST', path: '/mounts', body: {} },
    { required: 'write', method: 'POST', path: '/entries', body: {} },
    { required: 'write', method: 'POST', path: '/entries/missing/note-references', body: {} },
    { required: 'write', method: 'POST', path: '/documents/missing/move', body: {} },
    { required: 'write', method: 'DELETE', path: '/entries/missing/note-references/missing' },
    { required: 'write', method: 'POST', path: '/candidates/direct', body: {} },
    { required: 'write', method: 'POST', path: '/notes/folders', body: {} },
    { required: 'admin', method: 'PUT', path: '/settings', body: {} },
    { required: 'admin', method: 'POST', path: '/knowledge-bases/missing/archive', body: {} },
    { required: 'admin', method: 'DELETE', path: '/entries/missing' },
    { required: 'admin', method: 'DELETE', path: '/notes/missing' },
    { required: 'admin', method: 'GET', path: '/tokens' },
  ]

  for (const route of cases) {
    for (const level of LEVELS) {
      const response = await fetch(`${base}${route.path}`, {
        method: route.method,
        headers: {
          authorization: `Bearer ${tokens[level]}`,
          ...route.body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...route.body === undefined ? {} : { body: JSON.stringify(route.body) },
      })
      const allowed = ALLOWED[route.required].has(level)
      assert.equal(
        response.status === 403,
        !allowed,
        `${level} token ${route.method} ${route.path} should ${allowed ? 'pass its permission gate' : 'be forbidden'}; received ${response.status}`,
      )
    }
  }
})
