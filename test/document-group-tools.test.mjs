import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { documentGroupTools } from '../lib/document-group-tools.js'
import { KnowledgeHandleCodec } from '../lib/retrieval.js'

async function fixture(t, writeMode = 'direct') {
  const root = await mkdtemp(join(tmpdir(), 'group-tools-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const draft = { knowledgeBaseId: 'default', group: '旧分组', title: '部署记录', body: '正文不应改变', type: 'fact', tags: ['allowed'], scope: { kind: 'global' }, confidence: .9 }
  const entry = await provider.create(draft)
  const mount = { targetKind: 'session', targetId: 'ordinary-session', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode, includeTags: ['allowed'], excludeTags: [], extractionInstructions: '' }
  await provider.upsertMount(mount)
  const codec = new KnowledgeHandleCodec(Buffer.alloc(32, 5))
  const [browse, assign] = documentGroupTools(provider, codec)
  const exec = { agent: { session: { id: 'ordinary-session', header: {} } }, signal: new AbortController().signal }
  const args = { group: '部署运维', documents: [{ handle: codec.encode('ordinary-session', entry), expectedVersion: entry.version }] }
  return { provider, entry, draft, mount, codec, browse, assign, exec, args }
}

test('ordinary sessions browse groups without body or out-of-scope metadata', async t => {
  const f = await fixture(t)
  await f.provider.create({ ...f.draft, title: 'hidden tag', group: '秘密组', tags: [] })
  await f.provider.create({ ...f.draft, title: 'other project', group: '私有项目', scope: { kind: 'project', id: '/elsewhere' } })
  const result = JSON.parse(await f.browse.execute({ knowledgeBaseId: 'default' }, f.exec))
  assert.equal(result.documents.length, 1)
  assert.deepEqual(result.groups, [{ name: '旧分组', count: 1 }])
  assert.equal(result.documents[0].handle, f.args.documents[0].handle)
  assert.equal(result.documents[0].body, undefined)
  await assert.rejects(f.browse.execute({ knowledgeBaseId: 'not-mounted' }, f.exec), /挂载/)
})

test('direct group edits preserve finalized state/content and stale retries never overwrite', async t => {
  const f = await fixture(t)
  const finalized = await f.provider.finalize(f.entry.id, 'resolved')
  f.args.documents[0].expectedVersion = finalized.version
  const result = JSON.parse(await f.assign.execute(f.args, f.exec))
  assert.equal(result.results[0].status, 'applied')
  const saved = await f.provider.get(f.entry.id)
  assert.equal(saved.group, '部署运维'); assert.equal(saved.body, f.entry.body)
  assert.equal(saved.documentState, 'resolved'); assert.deepEqual(saved.tags, f.entry.tags)
  assert.equal(JSON.parse(await f.assign.execute(f.args, f.exec)).results[0].status, 'failed')
  assert.equal((await f.provider.get(f.entry.id)).version, saved.version)
})

test('audit creates one review candidate and applies metadata only on approval', async t => {
  const f = await fixture(t, 'audit')
  const first = JSON.parse(await f.assign.execute(f.args, f.exec)).results[0]
  assert.equal(first.status, 'pending-review')
  assert.equal(JSON.parse(await f.assign.execute(f.args, f.exec)).results[0].candidateId, first.candidateId)
  assert.equal((await f.provider.get(f.entry.id)).group, '旧分组')
  await assert.rejects(f.provider.review(first.candidateId, { decision: 'approve', draft: { ...f.entry, body: 'override' } }), /不能替换正文/)
  await f.provider.review(first.candidateId, { decision: 'approve' })
  assert.equal((await f.provider.get(f.entry.id)).group, '部署运维')
  assert.equal((await f.provider.get(f.entry.id)).body, f.entry.body)
})

test('read-only, revoked, foreign-session and tag-excluded handles cannot change groups', async t => {
  const f = await fixture(t, 'none')
  assert.equal(JSON.parse(await f.assign.execute(f.args, f.exec)).results[0].status, 'failed')
  await f.provider.upsertMount({ ...f.mount, writeMode: 'direct', includeTags: ['other'] })
  assert.equal(JSON.parse(await f.assign.execute(f.args, f.exec)).results[0].status, 'failed')
  await f.provider.upsertMount({ ...f.mount, writeMode: 'direct', enabled: false })
  assert.equal(JSON.parse(await f.assign.execute(f.args, f.exec)).results[0].status, 'failed')
  await f.provider.upsertMount({ ...f.mount, writeMode: 'direct' })
  f.args.documents[0].handle = f.codec.encode('another-session', f.entry)
  assert.equal(JSON.parse(await f.assign.execute(f.args, f.exec)).results[0].status, 'failed')
  assert.equal((await f.provider.get(f.entry.id)).group, '旧分组')
})

test('stale audit cannot apply a group to a concurrently updated document', async t => {
  const f = await fixture(t, 'audit')
  const candidate = JSON.parse(await f.assign.execute(f.args, f.exec)).results[0]
  await f.provider.update(f.entry.id, { ...f.entry, body: '新的正文' })
  await assert.rejects(f.provider.review(candidate.candidateId, { decision: 'approve' }), /过期/)
  assert.equal((await f.provider.get(f.entry.id)).group, '旧分组')
})

test('mixed batches report partial failure and an unchanged retry creates no extra version', async t => {
  const f = await fixture(t)
  f.args.documents.push({ handle: 'invalid', expectedVersion: 1 })
  const result = JSON.parse(await f.assign.execute(f.args, f.exec))
  assert.deepEqual(result.results.map(item => item.status), ['applied', 'failed'])
  const saved = await f.provider.get(f.entry.id)
  const retry = JSON.parse(await f.assign.execute({ ...f.args, documents: [{ ...f.args.documents[0], expectedVersion: saved.version }] }, f.exec))
  assert.equal(retry.results[0].status, 'unchanged')
  assert.equal((await f.provider.get(f.entry.id)).version, saved.version)
})

test('permission revocation during document reads blocks mutation', async t => {
  const f = await fixture(t)
  const original = f.provider.get.bind(f.provider)
  let revoke = true
  f.provider.get = async id => {
    const entry = await original(id)
    if (revoke) { revoke = false; await f.provider.upsertMount({ ...f.mount, writeMode: 'none' }) }
    return entry
  }
  assert.equal(JSON.parse(await f.assign.execute(f.args, f.exec)).results[0].status, 'failed')
  assert.equal((await original(f.entry.id)).group, '旧分组')
})
