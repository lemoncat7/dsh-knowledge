import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectKnowledgePassage } from '../lib/retrieval-passages.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { KnowledgeHandleCodec, searchMountedKnowledge, formatSearchResults, formatAutomaticRecall, formatKnowledgeEntry } from '../lib/retrieval.js'
import { KnowledgeNoteHandleCodec } from '../lib/note-reference-handle.js'
import { registerKnowledgeTools } from '../lib/tools.js'

test('retrieval selects the matching late paragraph with exact Unicode offsets and heading context', () => {
  const body = '# 运维\n\n' + '😀这里介绍服务背景。'.repeat(130) + '\n\n## 故障恢复\n\n回写网络中断后，先核对前一轮状态，再重试回写。\n\n## 其他\n\n其他记录。'
  const p = selectKnowledgePassage(body, '回写网络中断怎么恢复')
  assert.match(p.text, /网络中断/)
  assert.equal(p.heading, '运维 / 故障恢复')
  assert.ok(p.offset > 420)
  assert.equal(Array.from(body).slice(p.offset, p.endOffset).join(''), p.text)
  assert.equal(p.startLine, 5)
  assert.equal(p.truncated, true)
  assert.equal(p.matched, true)
  assert.ok(Array.from(p.text).length <= 420)
})

test('long single paragraphs and fenced blocks expose truncation without breaking code-point offsets', () => {
  for (const fence of ['```', '~~~~']) {
    const body = '# 操作\n\n' + fence + 'txt\n# 不是标题\n' + '🧭背景'.repeat(500) + 'TLS_CERT_EXPIRED 必须续期证书。' + '结尾'.repeat(500) + '\n' + fence
    const p = selectKnowledgePassage(body, 'TLS_CERT_EXPIRED', 180)
    assert.match(p.text, /TLS_CERT_EXPIRED/)
    assert.equal(p.heading, '操作')
    assert.equal(Array.from(body).slice(p.offset, p.endOffset).join(''), p.text)
    assert.equal(Array.from(p.text).length, 180)
    assert.equal(p.truncated, true)
    assert.ok(!/[\uD800-\uDBFF]$/u.test(p.text))
  }
})

test('small documents and unmatched previews are deterministic and bounded', () => {
  assert.deepEqual(selectKnowledgePassage('', ''), { text: '', heading: '', offset: 0, endOffset: 0, totalChars: 0, startLine: 1, endLine: 1, truncated: false, matched: false })
  const p = selectKnowledgePassage('完整说明。', '未匹配')
  assert.equal(p.truncated, false)
  assert.equal(p.matched, false)
  assert.equal(p.text, '完整说明。')
  assert.equal(selectKnowledgePassage('abc', '', NaN).text, 'abc')
})

test('heading-only matches retain their first substantive paragraph', () => {
  const p = selectKnowledgePassage('# 概览\n\n无关介绍。\n\n## TLS_CERT_EXPIRED\n\n续签证书并检查系统时间。\n\n## 其他\n\n其他说明。', 'TLS_CERT_EXPIRED')
  assert.match(p.text, /续签证书并检查系统时间/)
  assert.equal(p.heading, '概览 / TLS_CERT_EXPIRED')
  assert.doesNotMatch(p.text, /无关介绍/)
})

test('consecutive parent and child headings cannot become title-only evidence', () => {
  const body = '# Docker 部署\n\n## 参考与目录\n- 目标主机的安装目录需要确认。\n\n## 其他\n其他说明。'
  const p = selectKnowledgePassage(body, 'Docker 部署')
  assert.match(p.text, /目标主机/)
  assert.equal(p.heading, 'Docker 部署 / 参考与目录')
  assert.equal(Array.from(body).slice(p.offset, p.endOffset).join(''), p.text)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-passages-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const draft = { knowledgeBaseId: 'default', group: '运维', title: '部署手册', body: '参考资料。', type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: .9 }
  const mount = { targetKind: 'session', targetId: 's', knowledgeBaseId: 'default', enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '' }
  await provider.upsertMount(mount)
  return { provider, draft, mount, agent: { session: { id: 's', header: { cwd: '/demo' }, snapshotEvents: () => [] } } }
}

test('exact quoted document names survive a crowded candidate pool without widening permissions', async t => {
  const { provider, draft } = await fixture(t)
  const target = await provider.create(draft)
  for (let i = 0; i < 12; i++) await provider.create({ ...draft, title: `正文匹配 ${i}`, body: '部署手册 '.repeat(12) })
  const secret = await provider.create({ ...draft, scope: { kind: 'project', id: '/secret' } })
  const excluded = await provider.create({ ...draft, tags: ['private'] })
  const other = await provider.createKnowledgeBase({ name: '其他库', description: '', defaultTags: [], extractionInstructions: '' })
  await provider.create({ ...draft, knowledgeBaseId: other.id })
  for (const query of ['部署手册', '《部署手册》', '"部署手册"']) {
    const hits = await provider.search({ text: query, knowledgeBaseIds: ['default'], projectId: '/demo', excludeTags: ['private'], limit: 1 })
    assert.equal(hits[0].entry.id, target.id)
    assert.equal(hits[0].score, 1)
    assert.notEqual(hits[0].entry.id, secret.id)
    assert.notEqual(hits[0].entry.id, excluded.id)
  }
  await provider.archive(target.id)
  assert.ok(!(await provider.search({ text: '部署手册', knowledgeBaseIds: ['default'], projectId: '/demo', excludeTags: ['private'], limit: 20 })).some(hit => hit.entry.id === target.id))
})

test('tool and automatic recall return the same passage, readable location and stale-version recovery', async t => {
  const { provider, draft, agent } = await fixture(t)
  const body = '# 概览\n\n' + '😀服务说明。'.repeat(200) + '\n\n## 恢复流程\n\nNETWORK_RESET：先检查 DNS，再重试。'
  const entry = await provider.create({ ...draft, body })
  const codec = new KnowledgeHandleCodec(Buffer.alloc(32, 7))
  const mounts = await provider.resolveMounts('s', '/demo')
  const hits = await searchMountedKnowledge(provider, agent, mounts, 'NETWORK_RESET', 4, codec)
  assert.equal(hits.length, 1)
  const search = formatSearchResults('NETWORK_RESET', hits)
  const auto = formatAutomaticRecall(hits, 5000)
  for (const output of [search, auto]) {
    assert.match(output, /NETWORK_RESET/)
    assert.match(output, /恢复流程/)
    assert.match(output, /expectedVersion=1/)
    assert.match(output, /truncated=true/)
    assert.doesNotMatch(output, /😀服务说明/)
  }
  assert.ok(formatKnowledgeEntry(entry, mounts[0], hits[0].passage.offset, 500).includes(hits[0].passage.text))
  const tools = new Map()
  registerKnowledgeTools({ tools: { register(tool) { tools.set(tool.name, tool) } }, llm: {} }, provider, codec, new KnowledgeNoteHandleCodec(Buffer.alloc(32, 8)))
  const read = tools.get('knowledge_read')
  const exec = { agent, signal: new AbortController().signal }
  const args = { handle: hits[0].handle, offset: hits[0].passage.offset, expectedVersion: entry.version }
  assert.match(await read.execute(args, exec), /NETWORK_RESET/)
  await provider.update(entry.id, { ...draft, body: '新版前言\n\n' + body })
  await assert.rejects(read.execute(args, exec), /DOCUMENT_VERSION_CHANGED/)
  assert.match(await read.execute({ handle: args.handle }, exec), /新版前言/)
  await provider.upsertMount({ ...mounts[0], enabled: false })
  await assert.rejects(read.execute({ handle: args.handle }, exec), /mounted/)
})
