import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeActivitySelection, availableActivitySession } from '../lib/knowledge-activity-state.js'
import { LatestRequest } from '../lib/latest-request.js'
import { createModelCatalogLoader } from '../web/model-catalog.js'
import { knowledgeDesignCss, KNOWLEDGE_PALETTE } from '../lib/design-tokens.js'
import { readFile } from 'node:fs/promises'

test('blank or not-yet-loaded sessions use the workspace instead of a zero-width details column', () => {
  assert.equal(availableActivitySession({ current: undefined, byId: {} }), undefined)
  assert.equal(availableActivitySession({ current: 's', byId: {} }), undefined)
  assert.equal(availableActivitySession({ current: 's', byId: { s: { blank: true } } }), undefined)
  assert.equal(availableActivitySession({ current: 's', byId: { s: { blank: false } } }), 's')
})

test('activity base changes clear stale documents without losing independent notes state', () => {
  const previous = { knowledgeBaseId: 'A', documentId: 'doc-A', noteDocumentId: 'note-A', mode: 'knowledge' }
  const switched = mergeActivitySelection(previous, { knowledgeBaseId: 'B' })
  assert.equal(switched.documentId, undefined)
  assert.equal(switched.noteDocumentId, 'note-A')
  assert.equal(previous.documentId, 'doc-A')
  assert.equal(mergeActivitySelection(previous, { knowledgeBaseId: 'A' }).documentId, 'doc-A')
  assert.equal(mergeActivitySelection(previous, { knowledgeBaseId: 'B', documentId: 'doc-B' }).documentId, 'doc-B')
  assert.equal(mergeActivitySelection(previous, { documentId: undefined }).documentId, undefined)
  assert.equal(mergeActivitySelection(previous, { mode: 'notes' }).documentId, 'doc-A')
})

test('navigation, retry and disposal invalidate previous requests', () => {
  const requests = new LatestRequest()
  const first = requests.start()
  const second = requests.start()
  assert.equal(first.aborted, true)
  assert.equal(second.aborted, false)
  requests.cancel()
  requests.cancel()
  assert.equal(second.aborted, true)
  assert.equal(requests.start().aborted, false)
})

test('model discovery retries transient failures and shares successful pending reads', async () => {
  let calls = 0
  const providers = [{ id: 'test-provider', models: ['test-model'] }]
  const load = createModelCatalogLoader(async () => {
    calls++
    if (calls === 1) throw new Error('offline')
    return { ok: true, json: async () => ({ providers }) }
  })
  await assert.rejects(load(), /offline/)
  const a = load()
  const b = load()
  assert.equal(a, b)
  assert.deepEqual(await a, providers)
  assert.deepEqual(await load(), providers)
  assert.equal(calls, 2)
})

test('invalid model responses are not cached and successful catalogs expire', async () => {
  let calls = 0
  const load = createModelCatalogLoader(async () => ({ ok: true, json: async () => ++calls === 1 ? {} : { providers: [] } }), 0)
  await assert.rejects(load(), /无效数据/)
  assert.deepEqual(await load(), [])
  assert.deepEqual(await load(), [])
  assert.equal(calls, 3)
})

test('generated design asset uses the canonical palette and scoped host rules stay local', async () => {
  assert.equal((await readFile(new URL('../web/design-tokens.css', import.meta.url), 'utf8')).trim(), knowledgeDesignCss())
  const css = knowledgeDesignCss('.plugin', 'body[data-dark] .plugin', false)
  assert.ok(css.includes(KNOWLEDGE_PALETTE.light['--text']))
  assert.ok(css.includes(KNOWLEDGE_PALETTE.dark['--text']))
  assert.ok(!css.includes(':root'))
  assert.ok(!css.includes('@media'))
})
