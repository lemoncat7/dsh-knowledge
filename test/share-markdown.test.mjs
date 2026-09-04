import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSharedMarkdown } from '../lib/notes/share-markdown.js'

test('shared Markdown renders structure and a stable unique outline', () => {
  const rendered = renderSharedMarkdown('# 发布计划\n\n**重点**\n\n## 验收\n\n## 验收\n\n- [x] 已完成')
  assert.match(rendered.html, /<h1 id="发布计划">/)
  assert.match(rendered.html, /<strong>重点<\/strong>/)
  assert.match(rendered.html, /class="task-box is-checked"/)
  assert.deepEqual(rendered.headings, [
    { id: '发布计划', depth: 1, text: '发布计划' },
    { id: '验收', depth: 2, text: '验收' },
    { id: '验收-2', depth: 2, text: '验收' },
  ])
})

test('shared Markdown escapes embedded HTML and disables executable links', () => {
  const rendered = renderSharedMarkdown('<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![远程](https://tracker.example/pixel.gif)')
  assert.doesNotMatch(rendered.html, /<script>/)
  assert.match(rendered.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(rendered.html, /href="javascript:/)
  assert.doesNotMatch(rendered.html, /<img src="https:/)
  assert.match(rendered.html, /class="image-fallback"/)
})
