import assert from 'node:assert/strict'
import test from 'node:test'

// A content-based identity would incorrectly collapse independent same-text pages.
test('Wiki identities survive serializing and keep same-text pages distinct', async () => {
  const { createWikiPage, validateWikiManifest, wikiStorageKey } = await import('../lib/wiki/identity.js')
  const scope = { kind: 'project', id: '/projects/a' }
  const first = createWikiPage('base-a', 'wiki/one.md', scope, { kind: 'import', originalPath: 'wiki/one.md' })
  const second = createWikiPage('base-a', 'wiki/two.md', scope, { kind: 'import', originalPath: 'wiki/two.md' })
  assert.notEqual(first.pageId, second.pageId)
  assert.notEqual(first.entryId, second.entryId)
  const manifest = validateWikiManifest(JSON.parse(JSON.stringify({ format: 1, kbId: 'base-a', pages: [first, second] })))
  assert.equal(manifest.pages[0].entryId, first.entryId)
  assert.deepEqual(manifest.pages[0].scope, scope)
  assert.notEqual(wikiStorageKey(first), wikiStorageKey(second))
})

test('unknown scope, duplicate identity and unsafe paths cannot become readable pages', async () => {
  const { createWikiPage, validateWikiManifest } = await import('../lib/wiki/identity.js')
  const page = createWikiPage('a', 'wiki/one.md', { kind: 'global' }, { kind: 'manual', actor: 'owner' })
  for (const bad of [
    { ...page, scope: undefined },
    { ...page, scope: { kind: 'project', id: '' } },
    { ...page, relPath: '../outside.md' },
    { ...page, provenance: { kind: 'conversation', sessionId: 's', turn: -1 } },
  ]) assert.throws(() => validateWikiManifest({ format: 1, kbId: 'a', pages: [bad] }))
  assert.throws(() => validateWikiManifest({ format: 1, kbId: 'a', pages: [page, { ...page, relPath: 'wiki/two.md' }] }))
  assert.throws(() => createWikiPage('a', 'C:\\outside.md', { kind: 'global' }, { kind: 'manual', actor: 'owner' }))
})
