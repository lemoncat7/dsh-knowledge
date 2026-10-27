import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { KnowledgeHandleCodec, searchMountedKnowledge, formatSearchResults, formatMountCatalog } from '../lib/retrieval.js'
import { citationMarkdown, citationFromHref, citationFromFilePath, encodeCitation, parseCitation } from '../lib/knowledge-citations.js'
import { readCitation } from '../lib/citation-reader.js'

async function fixture(t) {
  const provider = new LocalKnowledgeProvider(':memory:')
  t.after(() => provider.close())
  const draft = { knowledgeBaseId: 'default', group: '运维', title: '部署 (验证) [记录]', body: '# 手册\n\n## 验证\n\n服务启动不代表验证通过。\n\n应检查业务功能。', type: 'lesson', tags: ['ops'], scope: { kind: 'global' }, confidence: .9 }
  const entry = await provider.create(draft)
  const mount = { targetKind: 'session', targetId: 's', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'none', includeTags: [], excludeTags: [], extractionInstructions: '' }
  await provider.upsertMount(mount)
  let source = 'a'.repeat(64)
  const sourceKey = () => source, codec = new KnowledgeHandleCodec(Buffer.alloc(32, 1), sourceKey)
  const agent = { session: { id: 's', header: { cwd: '/demo (work)' } } }
  return { provider, entry, draft, mount, codec, agent, sourceKey, switchSource: () => { source = 'b'.repeat(64) } }
}

test('inline citation is a safe clickable local destination and round-trips Unicode and parentheses', async t => {
  const f = await fixture(t), citation = f.codec.citation(f.agent, f.entry, 3, 5)
  const markdown = citationMarkdown(citation), href = markdown.match(/\]\((.*)\)$/)[1]
  assert.ok(!/[()]/.test(href))
  assert.match(markdown, /第 3–5 行/)
  assert.deepEqual(citationFromHref(href, 'http://dsh.local'), citation)
  assert.deepEqual(citationFromFilePath(decodeURIComponent(href)), citation)
  assert.equal(citationFromHref('https://evil.test' + href, 'http://dsh.local'), undefined)
  assert.equal(parseCitation(JSON.stringify({ ...citation, startLine: -1 })), undefined)
  assert.equal(parseCitation(JSON.stringify({ ...citation, endLine: 2 })), undefined)
  assert.equal(parseCitation('null'), undefined)
  const result = await readCitation(f.provider, JSON.stringify(citation), 's', f.sourceKey)
  assert.equal(result.lines.find(line => line.number === 5).text, '服务启动不代表验证通过。')
  assert.equal(result.section, '手册 / 验证')
  assert.equal(result.version, 1)
  const mounts = await f.provider.resolveMounts('s', '/demo (work)')
  const hits = await searchMountedKnowledge(f.provider, f.agent, mounts, '验证', 5, f.codec)
  assert.match(formatSearchResults('验证', hits), /Knowledge citation:/)
  assert.match(formatMountCatalog(mounts, 20000, 'conservative'), /inline parenthesis/)
})

test('citation reads reject stale versions, switched sources and revoked or filtered mounts', async t => {
  const f = await fixture(t), raw = JSON.stringify(f.codec.citation(f.agent, f.entry, 3, 5))
  await assert.rejects(readCitation(f.provider, raw, 'other', f.sourceKey), { status: 400 })
  await f.provider.upsertMount({ ...f.mount, excludeTags: ['ops'] })
  await assert.rejects(readCitation(f.provider, raw, 's', f.sourceKey), { status: 404 })
  await f.provider.upsertMount({ ...f.mount, recallEnabled: false })
  await assert.rejects(readCitation(f.provider, raw, 's', f.sourceKey), { status: 403 })
  await f.provider.upsertMount(f.mount)
  await f.provider.update(f.entry.id, { ...f.draft, body: '新版\n' + f.entry.body })
  await assert.rejects(readCitation(f.provider, raw, 's', f.sourceKey), /v1.*v2/)
  f.switchSource()
  await assert.rejects(readCitation(f.provider, raw, 's', f.sourceKey), /连接已切换/)
})

test('citation validates source again after asynchronous retrieval and never returns unauthorized content', async t => {
  const f = await fixture(t), raw = JSON.stringify(f.codec.citation(f.agent, f.entry, 3, 5))
  const get = f.provider.get.bind(f.provider)
  f.provider.get = async id => { const entry = await get(id); f.switchSource(); return entry }
  await assert.rejects(readCitation(f.provider, raw, 's', f.sourceKey), /连接已切换/)
})
