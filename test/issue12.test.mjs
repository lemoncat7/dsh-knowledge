import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { explicitlyRequestsKnowledgeNote as allows } from '../lib/tool-authorization.js'

test('issue 12: long conversational queries retain a trailing document topic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-issue12-'))
  const p = new LocalKnowledgeProvider(join(root, 'test.sqlite'))
  t.after(async () => { await p.close(); await rm(root, { recursive: true, force: true }) })
  const doc = await p.create({ group: '课程', title: '课件2.1', body: '线性代数的矩阵运算', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .9 })
  for (const text of ['课件2.1 整理进笔记', '这轮别用任何工具，请先解释你的工作流程和操作步骤并说明注意事项，假设我要你把课件2.1整理进笔记里面']) {
    const hits = await p.search({ text, limit: 10 })
    assert.ok(hits.some(h => h.entry.id === doc.id && h.score >= .2), text)
  }
  assert.equal((await p.search({ text: '火星轨道推进器', limit: 10 })).length, 0)
})

test('issue 12: explicit knowledge-base document requests need no magic note word', () => {
  assert.equal(allows('', 'inspect'), true)
  assert.equal(allows('笔记文档', 'update', 'document'), false)
  assert.equal(allows('假设修改这篇笔记文档', 'update', 'document'), false)
  assert.equal(allows('不要把内容写进笔记文档', 'create', 'document'), false)
  assert.equal(allows('把这篇课件写进知识库的课程目录', 'create', 'folder'), true)
  assert.equal(allows('把这篇课件写进知识库的课程目录', 'create', 'document'), true)
  assert.equal(allows('不要把这篇课件写进知识库的课程目录', 'create', 'document'), false)
  assert.equal(allows('修改知识库里的课程文档', 'update', 'document'), true)
  for (const text of ['假设把这篇课件写进知识库的课程目录', '不要修改知识库里的课程文档', '知识库里的课程文档', '修改本地课程文档']) {
    assert.equal(allows(text, 'update', 'document'), false, text)
  }
  assert.equal(allows('查看知识库里的课程文档', 'delete', 'document'), false)
  assert.equal(allows('查看知识库里的课程文档', 'update', 'document'), false)
})
