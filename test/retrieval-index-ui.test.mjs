import test from 'node:test'
import assert from 'node:assert/strict'
import { indexStatusLabel } from '../web/retrieval-index-status.js'

test('index progress labels do not mistake unavailable or empty state for completion', () => {
  assert.equal(indexStatusLabel(), '读取索引状态…')
  assert.equal(indexStatusLabel({ ready: 0, pending: 0, failed: 0, total: 0 }), '暂无文档需要索引')
  assert.equal(indexStatusLabel({ ready: 128, pending: 92, failed: 0, total: 220 }), '索引更新中 · 128 / 220')
  assert.equal(indexStatusLabel({ ready: 220, pending: 0, failed: 0, total: 220 }), '索引已就绪')
  assert.equal(indexStatusLabel({ ready: 128, pending: 89, failed: 3, total: 220 }), '3 篇索引失败 · 89 篇待处理')
})
