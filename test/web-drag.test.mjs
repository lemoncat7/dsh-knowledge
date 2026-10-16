import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const code = name => parsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name).getText(parsed)
function fixture({ documents = [], search = [], readOnly = false, moving = null } = {}) {
  const calls = [], messages = [], workspace = { view: { searchResults: search } }
  const context = {
    KNOWLEDGE_DOCUMENT_DRAG_TYPE: 'document', movingDocumentId: moving,
    documentWorkspaceReadOnly: () => readOnly,
    documentWorkspaceDocuments: () => documents,
    clearKnowledgeDocumentDragState() {},
    applyDocumentGroup: async (...args) => calls.push(args),
    showToast: (...args) => messages.push(args), friendlyError: e => e.message,
  }
  runInNewContext(code('hasDragType') + '\n' + code('dropDocumentIntoGroup'), context)
  return { calls, messages, async drop(id, baseId = 'base', group = 'next', type = 'document') {
    const event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { types: [type], getData: () => id } }
    await context.dropDocumentIntoGroup(event, workspace, baseId, group)
  } }
}
test('group drop resolves DataTransfer without relying on volatile global drag state', async () => {
  const f = fixture({ documents: [{ id: 'doc', knowledgeBaseId: 'base', group: 'before' }] })
  await f.drop('doc')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][1], 'base')
  assert.equal(f.calls[0][2][0], 'doc')
  assert.equal(f.calls[0][3], 'next')
  assert.equal(f.messages.length, 0)
})
test('group drop resolves search-only documents', async () => {
  const f = fixture({ search: [{ id: 'doc', knowledgeBaseId: 'base' }] })
  await f.drop('doc')
  assert.equal(f.calls.length, 1)
})
test('cross-library and unknown drags give distinct errors without writing', async () => {
  const f = fixture({ documents: [{ id: 'doc', knowledgeBaseId: 'elsewhere' }] })
  await f.drop('doc'); await f.drop('missing')
  assert.equal(f.calls.length, 0)
  assert.match(f.messages[0][0], /跨库/)
  assert.match(f.messages[1][0], /无法识别/)
})
test('same group, read-only, in-flight and unrelated drops do not write', async () => {
  const documents = [{ id: 'doc', knowledgeBaseId: 'base', group: 'next' }]
  for (const options of [{ documents }, { documents, readOnly: true }, { documents, moving: 'doc' }]) {
    const f = fixture(options)
    await f.drop('doc'); await f.drop('doc', 'base', 'other', 'text/plain')
    assert.equal(f.calls.length, 0)
    assert.equal(f.messages.length, 0)
  }
})
test('global drop cleanup is scheduled after event dispatch, not in capture', () => {
  const listeners = {}, timers = [], calls = []
  const context = {
    window: { addEventListener: (name, fn) => { listeners[name] = fn }, setTimeout: fn => timers.push(fn) },
    document: { addEventListener() {} }, clearNoteDragState: () => calls.push('notes'), clearKnowledgeDocumentDragState: () => calls.push('documents'),
  }
  runInNewContext(code('installDragRecovery') + '\ninstallDragRecovery()', context)
  listeners.drop()
  assert.equal(calls.length, 0)
  timers[0]()
  assert.deepEqual(calls, ['notes', 'documents'])
})
