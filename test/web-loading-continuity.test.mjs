import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createNoteHistoryView } from '../lib/web-note-history.js'
import { isPendingShell } from '../web/workspace-shell.js'

test('repeated pending updates do not rebuild the target route', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const render = parsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'renderShell').getText(parsed)
  // Any accidental teardown reaches undefined globals and fails this test.
  const context = { state: { loading: true, view: 'notes' }, app: { querySelector: () => ({ dataset: { loading: 'true', view: 'notes' } }) }, shellModule: { isPendingShell } }
  runInNewContext(render + '\nrenderShell(); renderShell()', context)
})

class Element {
  children = []; dataset = {}; attrs = new Map(); listeners = new Map(); textContent = ''; hidden = false
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attrs.set(key, value) }
  removeAttribute(key) { this.attrs.delete(key) }
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  querySelectorAll() { return walk(this).filter(n => n.dataset.noteVersion !== undefined) }
  click() { this.listeners.get('click')?.() }
}

test('another route must switch immediately even while the previous route is pending', () => {
  const shell = { dataset: { loading: 'true', view: 'entries' } }
  assert.equal(isPendingShell(shell, 'notes'), false)
  assert.equal(isPendingShell(shell, 'entries'), true)
  assert.equal(isPendingShell(null, 'entries'), false)
  assert.equal(isPendingShell({ dataset: { loading: 'false', view: 'entries' } }, 'entries'), false)
})
function walk(root) { return root.children.flatMap(child => [child, ...walk(child)]) }
function fixture(t, loadContent) {
  const previous = globalThis.document
  globalThis.document = { createElement: () => new Element() }
  t.after(() => { globalThis.document = previous })
  const errors = [], options = {
    versions: [3, 2, 1].map(version => ({ version, createdAt: '', size: 0 })),
    currentVersion: 3, currentContent: '', currentContentKnown: true,
    loadContent, renderPreview: value => Object.assign(new Element(), { textContent: value }),
    renderDiff: () => new Element(), formatDate: () => '', formatBytes: () => '',
    onRestore: async () => {}, onError: error => errors.push(error),
  }
  const view = createNoteHistoryView(options)
  t.after(() => view.destroy())
  return {
    view, errors,
    content: walk(view.element).find(n => n.className === 'note-history-content'),
    version: number => walk(view.element).find(n => n.dataset.noteVersion === String(number)),
  }
}

test('known empty current content is a real cached value, never a loading placeholder', t => {
  let calls = 0
  const { content } = fixture(t, async () => { calls++; return 'unexpected' })
  assert.equal(calls, 0)
  assert.equal(content.children.length, 1)
  assert.equal(content.children[0].textContent, '')
  assert.equal(content.attrs.has('aria-busy'), false)
})

test('slow and superseded history reads preserve current content and ignore stale completion', async t => {
  let resolve, signal
  const { content, version } = fixture(t, (_version, abort) => { signal = abort; return new Promise(done => { resolve = done }) })
  const original = content.children[0]
  version(1).click()
  assert.equal(content.children[0], original)
  assert.equal(content.attrs.get('aria-busy'), 'true')
  version(3).click()
  assert.equal(signal.aborted, true)
  resolve('stale content')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(content.children[0].textContent, '')
  assert.equal(content.attrs.has('aria-busy'), false)
})

test('failed history read keeps old content and remains retryable', async t => {
  let calls = 0
  const { content, version, errors } = fixture(t, async () => { if (++calls === 1) throw Error('offline'); return 'loaded' })
  const original = content.children[0]
  version(2).click(); await Promise.resolve(); await Promise.resolve()
  assert.equal(errors.length, 1)
  assert.equal(content.children[0], original)
  version(2).click(); await Promise.resolve(); await Promise.resolve()
  assert.equal(content.children[0].textContent, 'loaded')
  assert.equal(content.attrs.has('aria-busy'), false)
})

test('closing history aborts reads and prevents late content mutation', async t => {
  let resolve, signal
  const { content, version, view } = fixture(t, (_version, abort) => { signal = abort; return new Promise(done => { resolve = done }) })
  version(1).click(); const original = content.children[0]
  view.destroy(); assert.equal(signal.aborted, true)
  resolve('late content'); await Promise.resolve(); await Promise.resolve()
  assert.equal(content.children[0], original)
})
