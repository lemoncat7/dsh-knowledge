import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { SessionReferences } from '../lib/session-references.js'
import { KnowledgeHandleCodec } from '../lib/retrieval.js'
import { applyKnowledgeTextEdits } from '../lib/knowledge-merge.js'

test('short references are stable, session bound and recoverably invalidated', () => {
  const secret = Buffer.alloc(32, 7)
  const codec = new KnowledgeHandleCodec(secret)
  const entry = { id: 'entry-1', knowledgeBaseId: 'base-1' }
  const ref = codec.encode('session-a', entry)
  assert.equal(ref.length, 25)
  assert.equal(codec.encode('session-a', entry), ref)
  assert.equal(codec.decode(ref, 'session-a').entryId, entry.id)
  assert.throws(() => codec.decode(ref, 'session-b'), /REFERENCE_SESSION_MISMATCH/)
  assert.throws(() => codec.decode(ref.slice(0, -1), 'session-a'), /REFERENCE_FORMAT_INVALID/)
  assert.throws(() => new KnowledgeHandleCodec(secret).decode(ref, 'session-a'), /REFERENCE_UNAVAILABLE/)
  codec.clear()
  assert.throws(() => codec.decode(ref, 'session-a'), /REFERENCE_UNAVAILABLE/)
})

test('legacy signed handles remain usable and failures distinguish format and signature', () => {
  const secret = Buffer.alloc(32, 8)
  const codec = new KnowledgeHandleCodec(secret)
  const payload = Buffer.from(JSON.stringify({ v: 1, sessionId: 's', knowledgeBaseId: 'b', entryId: 'e' })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  const handle = `k1.${payload}.${signature}`
  assert.equal(codec.decode(handle, 's').entryId, 'e')
  assert.throws(() => codec.decode(handle.slice(0, -1), 's'), /REFERENCE_FORMAT_INVALID/)
  const changed = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`
  assert.throws(() => codec.decode(`k1.${payload}.${changed}`, 's'), /REFERENCE_SIGNATURE_MISMATCH/)
  codec.clear()
  assert.throws(() => codec.decode(handle, 's'), /REFERENCE_SIGNATURE_MISMATCH/)
})

test('reference cache has bounded capacity, LRU and explicit expiry', () => {
  let now = 0
  const refs = new SessionReferences(2, 100, () => now)
  const a = refs.put('s', 'a'), b = refs.put('s', 'b')
  assert.equal(refs.get(a, 's'), 'a')
  refs.put('s', 'c')
  assert.throws(() => refs.get(b, 's'), /REFERENCE_UNAVAILABLE/)
  now = 101
  assert.throws(() => refs.get(a, 's'), /REFERENCE_UNAVAILABLE/)
})

test('missing and ambiguous body anchors fail safely with actionable diagnostics', () => {
  const missing = applyKnowledgeTextEdits('原文完整段落', [{ oldText: '原文段落', newText: '已解决' }])
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /EDIT_ANCHOR_NOT_FOUND/)
  const ambiguous = applyKnowledgeTextEdits('标题\n问题\n问题', [{ oldText: '问题', newText: '已解决' }])
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.reason, /EDIT_ANCHOR_AMBIGUOUS.*第 2 行/)
})
