import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('candidate count endpoint reads only counts and follows review changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-counts-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } } }, provider, '/api', { authMode: 'same-origin' })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.address().port}/api/candidates/counts`
  const headers = { 'x-dsh-knowledge-client': 'management-web' }
  const counts = async () => {
    const response = await fetch(url, { headers })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control'), /no-store/)
    return response.json()
  }
  assert.equal((await fetch(url)).status, 401)
  assert.deepEqual(await counts(), { pending: 0, approved: 0, rejected: 0 })
  const candidate = await provider.propose({ action: 'create', reason: '计数测试', draft: {
    knowledgeBaseId: 'default', group: '测试', title: '待审核', body: '不应随数量返回的正文',
    type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .9,
  } })
  for (const method of ['listCandidates', 'candidatePage', 'stats', 'entriesByIds']) {
    provider[method] = () => { throw Error(`count request must not call ${method}`) }
  }
  assert.deepEqual(await counts(), { pending: 1, approved: 0, rejected: 0 })
  await provider.review(candidate.id, { decision: 'reject' })
  assert.deepEqual(await counts(), { pending: 0, approved: 0, rejected: 1 })
})
