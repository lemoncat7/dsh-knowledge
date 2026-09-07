import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSearchQuery } from '../lib/search-query.js'

test('writeback query prioritizes the question, headings and code without copying the turn', () => {
  const user = '你看下 异常上报，我们什么时候会上报 总结一下'
  const assistant = '我按当前代码梳理了一遍。\n## 不停机风险条件\n`nonStopCrypto` `report_analyse_result`\n'
    + '这里介绍一些代码处理的说明。'.repeat(400)
    + '\n## Prepared Statement 重复执行\n`NSC_5006`'
  const query = buildSearchQuery(user, assistant)
  assert.match(query, /异常/)
  assert.match(query, /上报/)
  assert.match(query, /风险/)
  assert.match(query, /nonStopCrypto/)
  assert.match(query, /NSC_5006/)
  assert.doesNotMatch(query, /[\n`#]/)
  assert.ok(query.split(' ').length <= 20)
  assert.ok(new URLSearchParams({ q: query }).toString().length <= 2002)
  assert.equal(query, buildSearchQuery(user, assistant))
})

test('query normalization is bounded, deduplicated and handles empty or unusual text', () => {
  assert.equal(buildSearchQuery('', ''), '')
  assert.equal(buildSearchQuery('🤔\ud800'), '')
  assert.equal(buildSearchQuery('SQL sql Sql'), 'SQL')
  assert.equal(buildSearchQuery('x'.repeat(20000)), '')
  const query = buildSearchQuery('知识库风险版本处理'.repeat(5000))
  assert.ok(encodeURIComponent(query).length < 2100)
})
