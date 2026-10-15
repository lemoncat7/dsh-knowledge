import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { connectInfiniteScroll } from '../web/infinite-scroll.js'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function functions(names, values) {
  return runInNewContext(parsed.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text))
    .map(s => s.getText(parsed)).join('\n') + `\n({${names.join(',')}})`, { URLSearchParams, Map, Set, ...values })
}

test('rapid candidate load-more requests deduplicate; late responses cannot overwrite a different tab', async () => {
  let resolve, calls = 0
  const page = { nextCursor: 'cursor', loading: false, error: '', counts: { pending: 100 } }
  const state = { candidatePage: page, candidateStatus: 'pending', candidates: [], candidateTargets: new Map() }
  const { loadMoreCandidates } = functions(['loadMoreCandidates'], {
    state, navigationRequest: 1, navigationController: null, updateCandidateFooter() {},
    api: () => { calls++; return new Promise(done => { resolve = done }) },
  })
  const first = loadMoreCandidates()
  await loadMoreCandidates()
  assert.equal(calls, 1)
  state.candidatePage = { nextCursor: '', counts: { approved: 30 } }; state.candidateStatus = 'approved'
  resolve({ items: [{ id: 'stale' }], targets: [], counts: { pending: 99 }, total: 99 })
  await first
  assert.equal(state.candidates.length, 0)
  assert.equal(state.candidatePage.counts.approved, 30)
})

test('notes share in-flight page fetches, retain existing data on error and retry the same cursor', async () => {
  let resolve, reject, calls = []
  const page = { loading: false, nextCursor: 'next', total: 80 }
  const notes = { children: new Map([['root', [{ id: 'a' }]]]), loadedFolders: new Set(['root']) }
  const { loadNoteChildren } = functions(['loadNoteChildren'], {
    state: { notes }, notePages: new Map([['root', page]]), friendlyError: e => e.message,
    api: path => { calls.push(path); return new Promise((done, fail) => { resolve = done; reject = fail }) },
  })
  const first = loadNoteChildren(null, false, { append: true })
  const second = loadNoteChildren(null, false, { append: true })
  assert.equal(calls.length, 1)
  reject(Error('offline'))
  await assert.rejects(first, /offline/); await assert.rejects(second, /offline/)
  assert.equal(notes.children.get('root').length, 1)
  assert.equal(page.nextCursor, 'next'); assert.equal(page.loading, false)
  const retry = loadNoteChildren(null, false, { append: true })
  assert.equal(calls[0], calls[1])
  resolve({ items: [{ id: 'a' }, { id: 'b' }], total: 2 })
  await retry
  assert.equal(notes.children.get('root').length, 2)
  assert.equal(page.nextCursor, '')
})

test('infinite observer waits for scrolling, excludes failed/busy buttons, and cleans up', t => {
  const names = ['IntersectionObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'window']
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete globalThis[name]; else globalThis[name] = previous[name] })
  let callback, onScroll, frame, clicked = 0, disconnected = false
  const button = { isConnected: true, disabled: false, dataset: { loadMore: 'auto' }, click() { clicked++ } }
  const root = { querySelectorAll: () => [button], contains: () => true, addEventListener(_event, fn) { onScroll = fn }, removeEventListener() {} }
  globalThis.IntersectionObserver = class { constructor(fn) { callback = fn } observe() {} unobserve() {} disconnect() { disconnected = true } }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.requestAnimationFrame = fn => { frame = fn; return 1 }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  const dispose = connectInfiniteScroll(root)
  callback([{ target: button, isIntersecting: true }]); frame()
  assert.equal(clicked, 0, 'opening short/collapsed lists must not eagerly drain all pages')
  onScroll(); frame(); assert.equal(clicked, 1)
  button.dataset.loadMore = 'manual'; onScroll(); frame(); assert.equal(clicked, 1)
  button.dataset.loadMore = 'auto'; button.disabled = true; onScroll(); frame(); assert.equal(clicked, 1)
  dispose(); assert.equal(disconnected, true)
  button.disabled = false; onScroll(); frame(); assert.equal(clicked, 1)
})

test('a second render before scroll restoration never overwrites the saved position with zero', () => {
  const saved = new Map([['notes', { regions: { folder: { top: 1200, left: 0 } } }]])
  const { captureScrollPosition } = functions(['captureScrollPosition'], {
    scrollRestoreFrame: 1, state: { scrollPositions: saved },
    app: { querySelector() { assert.fail('must not capture un-restored DOM') } },
  })
  captureScrollPosition()
  assert.equal(saved.get('notes').regions.folder.top, 1200)
})
