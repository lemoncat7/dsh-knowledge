import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createLazyResources } from '../web/lazy-resources.js'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function functions(names, values = {}) {
  const declarations = parsed.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text))
  assert.equal(declarations.length, names.length)
  return runInNewContext(declarations.map(s => s.getText(parsed)).join('\n') + `\n({ ${names.join(',')} })`, { URLSearchParams, Set, Map, ...values })
}
function fixture() {
  const view = { knowledgeBaseId: '', documentId: '', editor: null, expandedBases: new Set() }
  const state = { knowledgeBases: [], documents: [], resolvedMounts: [], mountContext: {}, entryFilters: {} }
  const calls = []
  const values = {
    state,
    api: async path => { calls.push(path); throw Error('Unexpected request: ' + path) },
    ensureKnowledgeBases: async () => { calls.push('knowledge-bases'); return [{ id: 'base', status: 'active' }] },
    documentKnowledgeBases: bases => bases,
    sessionDocumentWorkspace: () => ({ kind: 'session', view }),
  }
  return { view, state, calls, values }
}

test('plain workspace open only requests base metadata; no stats, index, default document or expanded base', async () => {
  const { view, calls, values } = fixture()
  await functions(['loadDocuments'], values).loadDocuments()
  assert.deepEqual(calls, ['knowledge-bases'])
  assert.equal(view.documentId, '')
  assert.equal(view.editor, null)
  assert.equal(view.expandedBases.size, 0)
})

test('workspace still resolves session scope without eagerly loading mounted documents', async () => {
  const { calls, values, state } = fixture()
  state.mountContext = { sessionId: 'session', projectId: '/project' }
  values.api = async path => { calls.push(path); return [{ knowledgeBaseId: 'base' }] }
  await functions(['loadDocuments'], values).loadDocuments()
  assert.deepEqual(calls, ['knowledge-bases', 'mounts/resolve?sessionId=session&projectId=%2Fproject'])
})

test('explicit deep links still load their selected document, including links without a base id', async () => {
  for (const baseId of ['', 'base']) {
    const { view, calls, values } = fixture()
    view.documentId = 'chosen'; view.knowledgeBaseId = baseId
    values.api = async path => { calls.push(path); return { id: 'chosen', knowledgeBaseId: 'base' } }
    values.documentSummary = x => x
    values.mergeDocumentSummaries = () => {}
    values.loadDocumentPage = async () => { calls.push('index') }
    values.loadDocumentEditor = async (_workspace, id) => { calls.push('entry:' + id) }
    await functions(['loadDocuments'], values).loadDocuments()
    assert.ok(calls.includes('entry:chosen'))
    assert.equal(view.knowledgeBaseId, 'base')
    assert.equal(view.expandedBases.has('base'), true)
    assert.ok(!calls.includes('stats'))
  }
})

test('unmounted document links are not fetched or opened', async () => {
  const { view, calls, values } = fixture()
  view.documentId = 'private'; view.knowledgeBaseId = 'unmounted'
  await functions(['loadDocuments'], values).loadDocuments()
  assert.deepEqual(calls, ['knowledge-bases'])
  assert.equal(view.documentId, '')
})

test('notes initially fetch only the root metadata; no shares, children or content', async () => {
  const calls = []
  const state = { notes: { children: new Map(), loadedFolders: new Set(), selectedId: '' } }
  const { loadNotes } = functions(['loadNotes', 'loadNoteChildren'], { state, notePages: new Map(), api: async path => { calls.push(path); return { items: [{ id: 'folder', kind: 'folder' }], total: 1 } } })
  await loadNotes(); await loadNotes()
  assert.deepEqual(calls, ['notes?limit=40&paged=1', 'notes?limit=40&paged=1'])
  assert.equal(state.notes.children.get('root').length, 1)
})

test('opening a library detail does not load any documents or choose one', async () => {
  const { createDocumentViewState } = functions(['createDocumentViewState'])
  const state = { libraryDetail: { knowledgeBaseId: '', documents: [], view: createDocumentViewState() } }
  const { openKnowledgeBaseDocuments } = functions(['openKnowledgeBaseDocuments'], {
    state, createDocumentViewState, libraryDetailRequest: 0, captureScrollPosition() {}, renderShell() {}, window: { requestAnimationFrame() {} },
  })
  await openKnowledgeBaseDocuments({ id: 'base' })
  assert.equal(state.libraryDetail.view.documentId, '')
  assert.equal(state.libraryDetail.view.expandedBases.size, 0)
})

test('repeated expansion in flight shares one index load and never fetches a document', async () => {
  let done, count = 0
  const page = { loaded: false, loading: false }, view = { expandedBases: new Set() }
  const values = { navigationRequest: 1, navigationController: null, renderShell() {}, documentPageState: () => page,
    loadDocumentPage: () => { count++; page.loading = true; return new Promise(resolve => { done = () => { page.loading = false; page.loaded = true; resolve() } }) },
  }
  const { toggleDocumentBase } = functions(['toggleDocumentBase'], values)
  const first = toggleDocumentBase({ view }, 'base')
  await toggleDocumentBase({ view }, 'base')
  await toggleDocumentBase({ view }, 'base')
  assert.equal(count, 1)
  done(); await first
  await toggleDocumentBase({ view }, 'base'); await toggleDocumentBase({ view }, 'base')
  assert.equal(count, 1)
})

test('module loads are deferred, deduplicated, and retryable after failure', async () => {
  let count = 0
  const resources = createLazyResources({ moduleUrl: name => name, importModule: async name => { count++; if (count === 1) throw Error('offline'); return { name } } })
  assert.equal(count, 0)
  const a = resources.module('worklog'), b = resources.module('worklog')
  assert.equal(a, b)
  await assert.rejects(a, /offline/)
  assert.deepEqual(await resources.module('worklog'), { name: 'worklog' })
  await resources.module('worklog')
  assert.equal(count, 2)
})

test('classic feature scripts download only on demand, deduplicate and recover after errors', async () => {
  const added = [], global = {}
  const document = { createElement: () => ({ remove() {} }), head: { append: node => added.push(node) } }
  const resources = createLazyResources({ moduleUrl: x => x, scriptUrl: x => x + '.js?v=version', document, global })
  const a = resources.script('history', 'History')
  assert.equal(a, resources.script('history', 'History'))
  assert.equal(added[0].src, 'history.js?v=version')
  added[0].onerror(); await assert.rejects(a, /下载失败/)
  const b = resources.script('history', 'History'); global.History = {}; added[1].onload()
  assert.equal(await b, global.History)
  await resources.script('history', 'History'); assert.equal(added.length, 2)
})

test('stats and feature runtimes are not eagerly loaded by unrelated routes', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  assert.doesNotMatch(html, /markdown-preview\.js|change-review\.js|note-history\.js/)
  assert.doesNotMatch(source, /selectDefaultDocument/)
  const startup = source.slice(0, source.indexOf('const TOKEN_KEY'))
  assert.doesNotMatch(startup, /await import\(moduleUrl\('(worklog-workspace|writeback-workspace|note-excerpt|model-catalog)'/)
  for (const name of ['loadDocuments', 'loadNotes', 'loadCandidates', 'loadTokens', 'loadKnowledgeBasesPage']) {
    const declaration = parsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name).getText(parsed)
    assert.doesNotMatch(declaration, /api\('stats'|refreshStats\(/)
  }
})
