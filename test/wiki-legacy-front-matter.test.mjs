import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { parseWikiMarkdown, salvageFrontMatterScalars, serializeWikiMarkdown, updateWikiFrontMatter } from '../lib/wiki/markdown.js'
import { explainWikiFailure, explainWikiRejection } from '../lib/wiki/diagnostics.js'

const codeOf = error => error && typeof error === 'object' ? error.code : undefined
const windowsSource = 'E:\\资料\\归档资料\\04_调试与标定\\旧流程说明.docx'
const sourceNote = '素材类型：DOCX 派生说明（extract_quality: full）｜章节范围：全篇'
const legacyText = '---\n'
  + 'title: 旧页：旧调试流程\n'
  + 'tags: [调试, 旧页]\n'
  + 'author: kb-bot\n'
  + 'sources:\n'
  + `  - ${windowsSource}\n`
  + '  - raw/04_调试与标定/旧流程说明.md\n'
  + `source-note: ${sourceNote}\n`
  + '---\n'
  + '\n# 旧页：旧调试流程\n\n旧页正文 unique-legacy-token-8f3a。\n'
const legacy = Buffer.from(legacyText, 'utf8')
const broken = Buffer.from('---\ntitle: [broken\ntags: 甲\n---\n\n# 坏页\n\n正文\n', 'utf8')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-legacy-yaml-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'workspace')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const base = await provider.createKnowledgeBase({ name: '旧页修复', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  await provider.wiki.configure({ kbId: base.id, sourceDir, workspaceRoot })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  return { provider, base: base.id, sourceDir, workspaceRoot, wikiDir: join(workspaceRoot, 'wiki'), store: provider.wiki.store(base.id) }
}

test('legacy front matter with unquoted Windows paths and colon values is read without changing a byte', () => {
  const parsed = parseWikiMarkdown(legacy)
  assert.equal(parsed.title, '旧页：旧调试流程')
  assert.deepEqual(parsed.tags, ['调试', '旧页'])
  assert.equal(parsed.scope, undefined, 'a missing scope must stay unresolved for the caller to supply')
  assert.deepEqual(parsed.frontMatter.values.sources, [windowsSource, 'raw/04_调试与标定/旧流程说明.md'])
  assert.equal(parsed.frontMatter.values['source-note'], sourceNote, 'quoted scalars must keep their exact text')
  assert.ok(parsed.salvage, 'the restricted salvage must be recorded')
  assert.equal(parsed.salvage.kind, 'quoted-scalars')
  assert.deepEqual(parsed.salvage.fields, ['source-note'])
  assert.deepEqual(parsed.salvage.lines, [5, 7], 'both the Windows path item and the colon value are quoted (front-matter line numbers)')
  assert.deepEqual(Buffer.from(serializeWikiMarkdown(parsed)), legacy)
  assert.deepEqual(Buffer.from(parsed.original), legacy)
  assert.equal(parsed.body, '\n# 旧页：旧调试流程\n\n旧页正文 unique-legacy-token-8f3a。\n')
})

test('CRLF and BOM legacy pages are salvaged while keeping their exact bytes', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(legacyText.replaceAll('\n', '\r\n'), 'utf8')])
  const parsed = parseWikiMarkdown(bytes)
  assert.equal(parsed.bom, true); assert.equal(parsed.newline, '\r\n')
  assert.equal(parsed.frontMatter.values['source-note'], sourceNote)
  assert.deepEqual(Buffer.from(serializeWikiMarkdown(parsed)), bytes)
  const updated = Buffer.from(updateWikiFrontMatter(parsed, { scope: { kind: 'global' } }))
  const reparsed = parseWikiMarkdown(updated)
  assert.deepEqual(reparsed.scope, { kind: 'global' })
  assert.equal(reparsed.frontMatter.values['source-note'], sourceNote)
  assert.equal(reparsed.salvage, undefined, 'after an explicit metadata edit the front matter is valid again')
})

test('the restricted salvage only touches plain scalars that YAML would otherwise read as structure', () => {
  assert.equal(salvageFrontMatterScalars('title: 正常标题\ntags: [甲, 乙]\n'), undefined)
  assert.equal(salvageFrontMatterScalars('note: |\n  one: x: y\n'), undefined, 'block scalar content stays untouched')
  assert.equal(salvageFrontMatterScalars('note: 说明 # 备注\n'), undefined, 'inline comments stay untouched')
  assert.equal(salvageFrontMatterScalars('- key: value\n'), undefined, 'a list item that is a nested mapping stays untouched')
  assert.deepEqual(salvageFrontMatterScalars('key: a: b\n').yaml, "key: 'a: b'\n")
  assert.deepEqual(salvageFrontMatterScalars('key: C:\\资料\\a.docx\n').yaml, "key: 'C:\\资料\\a.docx'\n")
  assert.deepEqual(salvageFrontMatterScalars('- C:\\资料\\a.docx\n').yaml, "- 'C:\\资料\\a.docx'\n")
  assert.deepEqual(salvageFrontMatterScalars("key: it's a: b\n").yaml, "key: 'it''s a: b'\n")
})

test('genuinely broken front matter still fails as INVALID_MARKDOWN with a reason', () => {
  for (const bytes of [broken, Buffer.from('---\ntags: [a\n---\n\n# x\n', 'utf8'),
    Buffer.from('---\ntitle: a\ntitle: b\n---\n\n# x\n', 'utf8'), Buffer.from([0x23, 0x20, 0xff])]) {
    assert.throws(() => parseWikiMarkdown(bytes), error => codeOf(error) === 'INVALID_MARKDOWN')
  }
  try { parseWikiMarkdown(broken) } catch (error) { assert.match(String(error.detail), /YAML 解析错误/u) }
  assert.throws(() => parseWikiMarkdown(Buffer.from('---\ntitle: [broken\ntags: 甲\n---\n\n# 坏页\n', 'utf8')),
    error => codeOf(error) === 'INVALID_MARKDOWN')
  // A page that both carries a salvageable scalar and a real syntax error stays invalid.
  assert.throws(() => parseWikiMarkdown(Buffer.from('---\ntitle: [broken\nsource-note: a: b\n---\n\n# 坏页\n', 'utf8')),
    error => codeOf(error) === 'INVALID_MARKDOWN')
})

test('a legacy page is registered, searchable and left byte-identical while a broken page is reported with a reason', async t => {
  const f = await fixture(t)
  await mkdir(join(f.wikiDir, 'howtos'), { recursive: true }); await mkdir(join(f.wikiDir, 'notes'), { recursive: true })
  const legacyPath = join(f.wikiDir, 'howtos', 'legacy.md'), brokenPath = join(f.wikiDir, 'howtos', 'broken.md')
  const notePath = join(f.wikiDir, 'notes', 'plain.md')
  await writeFile(legacyPath, legacy); await writeFile(brokenPath, broken)
  await writeFile(notePath, Buffer.from('---\nscope:\n  kind: global\n---\n\n# 新页\n\n普通正文\n', 'utf8'))
  const before = await readFile(legacyPath)

  const connection = await f.provider.wiki.connect({ kbId: f.base, sourceDir: f.sourceDir, workspaceRoot: f.workspaceRoot, scope: { kind: 'project', id: 'legacy-project' } })
  assert.equal(connection.state, 'partial')
  const report = connection.report
  assert.equal(report.registered, 2); assert.equal(report.rejected, 1); assert.equal(report.repaired, 1)
  const legacyItem = report.items.find(item => item.relPath === 'howtos/legacy.md')
  assert.equal(legacyItem.status, 'new'); assert.equal(legacyItem.error, undefined)
  assert.equal(legacyItem.metadataRepair.kind, 'quoted-scalars')
  assert.deepEqual(legacyItem.metadataRepair.fields, ['source-note'])
  const brokenItem = report.items.find(item => item.relPath === 'howtos/broken.md')
  assert.equal(brokenItem.status, 'invalid'); assert.equal(brokenItem.errorCode, 'INVALID_MARKDOWN')
  assert.match(brokenItem.error, /^INVALID_MARKDOWN：/u); assert.match(brokenItem.errorReason, /front matter 解析失败/u)
  assert.equal(report.issues.length, 1)
  assert.deepEqual(report.issues[0], { code: 'INVALID_MARKDOWN', reason: brokenItem.errorReason, count: 1, examples: ['howtos/broken.md'] })

  const manifest = await f.store.manifest()
  assert.equal(manifest.pages.length, 2)
  const legacyPage = manifest.pages.find(page => page.relPath === 'wiki/howtos/legacy.md')
  assert.equal(legacyPage.metadataRepair.kind, 'quoted-scalars')
  assert.deepEqual(legacyPage.scope, { kind: 'project', id: 'legacy-project' }, 'a page without front-matter scope inherits the explicit connection scope')
  assert.equal(manifest.pages.some(page => page.relPath === 'wiki/howtos/broken.md'), false)

  assert.deepEqual(await readFile(legacyPath), before, 'registration must never rewrite the legacy page')
  assert.deepEqual(await readFile(brokenPath), broken)
  const listed = await f.provider.list({ knowledgeBaseId: f.base, status: 'active', limit: 10 })
  assert.ok(listed.items.some(item => item.title === '旧页：旧调试流程'))
  const hits = await f.provider.search({ text: '旧页正文', projectId: 'legacy-project', limit: 10 })
  assert.ok(hits.length >= 1, 'the salvaged page must be searchable')
})

test('a rejected page becomes registerable once its front matter is repaired, keeping the original identity', async t => {
  const f = await fixture(t), target = join(f.wikiDir, 'repair.md')
  await writeFile(target, broken)
  const config = { kbId: f.base, sourceDir: f.sourceDir, workspaceRoot: f.workspaceRoot, scope: { kind: 'global' } }
  assert.equal((await f.provider.wiki.connect(config)).state, 'partial')
  await writeFile(target, legacy)
  const value = await f.provider.wiki.connect(config)
  assert.equal(value.state, 'ready')
  assert.equal(value.report.registered, 1); assert.equal(value.report.repaired, 1); assert.equal(value.report.rejected, 0)
  assert.equal(value.report.issues.length, 0)
  const page = (await f.store.manifest()).pages.find(item => item.relPath === 'wiki/repair.md')
  assert.ok(page)
  assert.equal(page.metadataRepair.kind, 'quoted-scalars')
  assert.deepEqual(await readFile(target), legacy)
})

test('too-long pages are classified instead of counted only', async t => {
  const f = await fixture(t)
  await writeFile(join(f.wikiDir, 'long.md'), Buffer.from('# 太长\n\n' + 'a'.repeat(51_000), 'utf8'))
  const connection = await f.provider.wiki.connect({ kbId: f.base, sourceDir: f.sourceDir, workspaceRoot: f.workspaceRoot, scope: { kind: 'global' } })
  assert.equal(connection.state, 'partial')
  assert.deepEqual(connection.report.issues, [{ code: 'WIKI_PAGE_BODY_TOO_LONG',
    reason: '正文超过 50000 字符，因此未登记、不可检索；原文件未被改写', count: 1, examples: ['long.md'] }])
})

test('rejection and connection failures carry a code plus a human-readable reason', () => {
  assert.deepEqual(explainWikiRejection('WIKI_PAGE_BODY_TOO_LONG'),
    { code: 'WIKI_PAGE_BODY_TOO_LONG', reason: '正文超过 50000 字符，因此未登记、不可检索；原文件未被改写' })
  assert.equal(explainWikiRejection(new Error('WIKI_PAGE_BODY_EMPTY')).reason, '页面正文为空，因此未登记、不可检索；原文件未被改写')
  assert.deepEqual(explainWikiFailure(new Error('WIKI_SCOPE_REQUIRED')),
    { code: 'WIKI_SCOPE_REQUIRED', message: 'WIKI_SCOPE_REQUIRED：未指定知识范围，请选择全局或具体项目' })
  assert.deepEqual(explainWikiFailure(new Error('INJECT_INDEX_FAILURE')), { code: 'INJECT_INDEX_FAILURE', message: 'INJECT_INDEX_FAILURE' })
  assert.equal(explainWikiFailure(new Error('WIKI_DIRECTORY_NAME_REQUIRED：请选择名为 wiki 的成文文件夹')).message,
    'WIKI_DIRECTORY_NAME_REQUIRED：请选择名为 wiki 的成文文件夹', 'an explicit explanation is never rewritten')
})
