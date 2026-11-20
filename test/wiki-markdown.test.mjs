import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseWikiMarkdown,
  renderWikiPage,
  serializeWikiMarkdown,
  updateWikiFrontMatter,
} from '../lib/wiki/markdown.js'

const crlfPage = Buffer.from(
  '---\r\n'
  + 'type: note\r\n'
  + 'custom:\r\n'
  + '  nested: true\r\n'
  + 'tags:\r\n'
  + '  - 甲\r\n'
  + '  - 乙\r\n'
  + '---\r\n'
  + '\r\n'
  + '# 原有标题\r\n'
  + '\r\n'
  + '正文第一行\r\n'
  + '第二行\r\n',
  'utf8',
)

function codeOf(error) {
  return error && typeof error === 'object' ? error.code : undefined
}

test('parsing preserves unknown YAML fields and exact CRLF bytes', () => {
  const parsed = parseWikiMarkdown(crlfPage)
  assert.equal(parsed.newline, '\r\n')
  assert.equal(parsed.hasFrontMatter, true)
  assert.equal(parsed.title, '原有标题')
  assert.deepEqual(parsed.tags, ['甲', '乙'])
  assert.equal(parsed.type, 'note')
  assert.equal(parsed.scope, undefined, 'a missing scope must stay unresolved')
  assert.deepEqual(parsed.frontMatter.unknown, { custom: { nested: true } })
  assert.equal(parsed.body, '\r\n# 原有标题\r\n\r\n正文第一行\r\n第二行\r\n')
  assert.deepEqual(Buffer.from(serializeWikiMarkdown(parsed)), crlfPage)
})

test('front matter updates keep unknown fields, body bytes and CRLF', () => {
  const parsed = parseWikiMarkdown(crlfPage)
  const updated = Buffer.from(updateWikiFrontMatter(parsed, {
    scope: { kind: 'project', id: 'project-1' },
    provenance: 'file',
  }))
  const reparsed = parseWikiMarkdown(updated)
  assert.deepEqual(reparsed.scope, { kind: 'project', id: 'project-1' })
  assert.equal(reparsed.provenance, 'file')
  assert.deepEqual(reparsed.frontMatter.unknown, { custom: { nested: true } })
  assert.equal(reparsed.type, 'note')
  assert.deepEqual(reparsed.tags, ['甲', '乙'])
  assert.equal(reparsed.body, parsed.body)
  assert.equal(reparsed.newline, '\r\n')
  assert.match(updated.toString('utf8'), /custom:\r\n {2}nested: true\r\n/u)
})

test('legacy pages without front matter stay importable and gain metadata without body changes', () => {
  const original = Buffer.from('# 旧页\n\n旧正文\n', 'utf8')
  const parsed = parseWikiMarkdown(original)
  assert.equal(parsed.hasFrontMatter, false)
  assert.equal(parsed.title, '旧页')
  assert.equal(parsed.id, undefined)
  assert.equal(parsed.type, undefined)
  const updated = Buffer.from(updateWikiFrontMatter(parsed, { scope: { kind: 'global' }, provenance: 'manual' }))
  const reparsed = parseWikiMarkdown(updated)
  assert.deepEqual(reparsed.scope, { kind: 'global' })
  assert.equal(reparsed.provenance, 'manual')
  assert.equal(reparsed.body.replace(/\r\n/gu, '\n'), '\n# 旧页\n\n旧正文\n')
  assert.deepEqual(Buffer.from(serializeWikiMarkdown(reparsed)), updated)
})

test('a BOM is preserved rather than normalised away', () => {
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\nscope:\n  kind: global\n---\n\n# 标题\n\n正文\n', 'utf8')])
  const parsed = parseWikiMarkdown(original)
  assert.equal(parsed.bom, true)
  assert.deepEqual(Buffer.from(serializeWikiMarkdown(parsed)), original)
  const updated = Buffer.from(updateWikiFrontMatter(parsed, { provenance: 'manual' }))
  assert.equal(updated[0], 0xef)
  assert.equal(parseWikiMarkdown(updated).bom, true)
})

test('malformed YAML, unclosed front matter and invalid UTF-8 are rejected', () => {
  assert.throws(() => parseWikiMarkdown(Buffer.from('---\ntags: [a\n---\n\n# x\n', 'utf8')), error => codeOf(error) === 'INVALID_MARKDOWN')
  assert.throws(() => parseWikiMarkdown(Buffer.from('---\nscope:\n  kind: global\n\n# x\n', 'utf8')), error => codeOf(error) === 'INVALID_MARKDOWN')
  assert.throws(() => parseWikiMarkdown(Buffer.from([0x23, 0x20, 0xff])), error => codeOf(error) === 'INVALID_MARKDOWN')
})

test('unknown scopes, provenance and status never default to global', () => {
  assert.throws(
    () => parseWikiMarkdown(Buffer.from('---\nscope:\n  kind: team\n  id: x\n---\n\n# x\n\nbody\n', 'utf8')),
    error => codeOf(error) === 'UNKNOWN_SCOPE',
  )
  assert.throws(
    () => parseWikiMarkdown(Buffer.from('---\nprovenance: api\n---\n\n# x\n\nbody\n', 'utf8')),
    error => codeOf(error) === 'UNKNOWN_PROVENANCE',
  )
  assert.throws(
    () => parseWikiMarkdown(Buffer.from('---\nstatus: deleted\n---\n\n# x\n\nbody\n', 'utf8')),
    error => codeOf(error) === 'INVALID_ARGUMENT',
  )
})

test('rendering a new page is deterministic and keeps front matter scope explicit', () => {
  const bytes = renderWikiPage({
    title: '新页',
    body: '正文\n',
    frontMatter: { scope: { kind: 'project', id: 'project-1' }, provenance: 'conversation', tags: ['甲'] },
  })
  const text = Buffer.from(bytes).toString('utf8')
  assert.match(text, /^---\n/u)
  assert.match(text, /# 新页\n/u)
  const parsed = parseWikiMarkdown(bytes)
  assert.equal(parsed.title, '新页')
  assert.deepEqual(parsed.scope, { kind: 'project', id: 'project-1' })
  assert.equal(parsed.provenance, 'conversation')
  assert.deepEqual(Buffer.from(renderWikiPage({
    title: '新页',
    body: '正文\n',
    frontMatter: { scope: { kind: 'project', id: 'project-1' }, provenance: 'conversation', tags: ['甲'] },
  })), Buffer.from(bytes))
})
