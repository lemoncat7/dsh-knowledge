import assert from 'node:assert/strict'
import test from 'node:test'
import { createNoteMentionSource, NOTE_MENTION_SOURCE } from '../lib/note-mention-source.js'

const id = `note_${'a'.repeat(32)}`
const sourceKey = 'b'.repeat(64)
const session = { sessionId: 'session-a' }
const request = (extra = {}) => ({ query: '部署', signal: new AbortController().signal, position: 'inline', drilled: false, ...extra })
const pick = candidate => ({ candidate, session, action: 'pick', via: 'menu', position: 'inline', span: { start: 0, end: 3, draftRev: 1 } })

test('@ source lists only the note endpoint and inserts stable references, not file paths or full content', async () => {
  const calls = [], opened = []
  const source = createNoteMentionSource(id => opened.push(id), async (url, options) => {
    calls.push({ url, options })
    return Response.json(url.includes(`/note-mentions/${id}?`) ? { text: 'reference with fresh handle' } : {
      sourceKey, items: [{ id, name: '部署[规范].md', parent: '项目 A', version: 1 }],
    })
  })
  const candidates = await source.candidates(session, request())
  assert.equal(candidates[0].section, '笔记文档')
  assert.equal(candidates[0].description, '项目 A')
  const result = source.onPick(pick(candidates[0])).insert
  assert.equal(result.source, NOTE_MENTION_SOURCE)
  assert.equal(result.label, '部署[规范].md')
  assert.equal(result.clipboardText, `@[部署\\[规范\\].md](note://${id})`)
  assert.equal(source.codec.clipboardText(result.ref), result.clipboardText)
  assert.equal(source.openReference(session, result), true)
  assert.deepEqual(opened, [id])
  assert.equal(source.openReference({ sessionId: 'session-b' }, result), false)
  assert.equal(source.onPick({ ...pick(candidates[0]), session: { sessionId: 'session-b' } }), undefined)
  assert.equal(await source.codec.serialize(result.ref, request().signal), 'reference with fresh handle')
  const url = new URL(calls[1].url, 'http://local')
  assert.equal(url.searchParams.get('sessionId'), session.sessionId)
  assert.equal(url.searchParams.get('sourceKey'), sourceKey)
  assert.equal(calls[0].options.headers['x-dsh-knowledge-client'], 'conversation-web')
  assert.equal(calls.length, 2)
})

test('@ source respects quoted file paths, folder drill, cancellation and invalid payloads', async () => {
  let calls = 0
  const source = createNoteMentionSource(() => {}, async () => { calls++; return Response.json({}) })
  assert.deepEqual(await source.candidates(session, request({ quoted: true })), [])
  assert.deepEqual(await source.candidates(session, request({ drilled: true })), [])
  assert.deepEqual(await source.candidates(session, request({ query: 'a'.repeat(256) })), [])
  const controller = new AbortController()
  const pending = source.candidates(session, request({ signal: controller.signal }))
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 0)
  assert.equal(source.onPick(pick({ name: 'forged', value: '{}' })), undefined)
  await assert.rejects(source.codec.serialize('{}', request().signal), /引用无效/)
})

test('deleted or unavailable note fails serialization visibly; never silently falls back to a title', async () => {
  const source = createNoteMentionSource(() => {}, async () => Response.json({ error: '引用的笔记文档已不存在，请重新选择。' }, { status: 404 }))
  const ref = JSON.stringify({ id, name: '旧名.md', sessionId: session.sessionId, sourceKey })
  await assert.rejects(source.codec.serialize(ref, request().signal), /已不存在/)
})
